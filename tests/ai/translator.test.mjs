// Translator on a synthetic 12-page PaperDoc with the offline mock provider (?mock=1), in a real browser.
import assert from 'node:assert/strict';
import { runSuite } from './lib.mjs';

const Q = '?mock=1';

/** Code prepended to every page.evaluate body: imports + a fresh mock. */
const SETUP = `
  const { Translator } = await import('/js/ai/translator.js');
  const { mockControl } = await import('/js/ai/mock.js');
  const { buildSyntheticDoc } = await import('/tests/ai/synth.js');
  const { LIMITS } = await import('/js/core/config.js');
  const { settings } = await import('/js/core/settings.js');
  const { bus } = await import('/js/core/bus.js');
  const { hash } = await import('/js/core/util.js');
  const usage = await import('/js/ai/usage.js');
  const P = await import('/js/ai/prompts.js');
  mockControl.reset();
  mockControl.latencyMs = 5;
  const doc = buildSyntheticDoc();
  const translatable = doc.sentences.filter((s) => ['body', 'heading', 'caption'].includes(s.kind));
  const idx = new Map(doc.sentences.map((s, i) => [s.sid, i]));
  const reqs = () => mockControl.requests.filter((r) => r.task === 'translate');
`;

/** Run `body` (async JS source using SETUP's bindings) in the page and return its value. */
const inPage = (page, body) => page.evaluate(`(async () => { ${SETUP}\n${body} })()`);

const tests = [
  {
    name: 'synthetic PaperDoc: ≥300 sentences over 12 pages with headings/captions/references/furniture',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        const kinds = {};
        for (const s of doc.sentences) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
        return { n: doc.sentences.length, pages: doc.numPages, kinds, provider: settings.get().provider };
      `);
      assert.ok(r.n >= 300, `${r.n} sentences`);
      assert.equal(r.pages, 12);
      for (const k of ['body', 'heading', 'caption', 'reference', 'furniture']) assert.ok(r.kinds[k] > 0, k);
      assert.equal(r.provider, 'mock');
      return `${r.n} sentences, kinds ${JSON.stringify(r.kinds)}, provider=${r.provider}`;
    },
  },
  {
    name: 'translateAll: all translatable done; batches ≤ 40 sentences & ≤ 3500 chars, reading order; refs/furniture/wordless never sent',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        const saves = [];
        const t = new Translator({ doc, save: async (obj) => { saves.push(obj); } });
        const progress = await t.translateAll();
        const batches = reqs().map((q) => ({ n: q.ids.length, chars: q.ids.reduce((a, id) => a + doc.sentenceById.get(id).text.length, 0),
          ordered: q.ids.every((id, i) => i === 0 || idx.get(id) > idx.get(q.ids[i - 1])) }));
        const sent = new Set(reqs().flatMap((q) => q.ids));
        const kindsSent = [...new Set([...sent].map((id) => doc.sentenceById.get(id).kind))];
        const wordless = doc.sentences.filter((s) => s.kind === 'body' && !/[A-Za-z]{2,}/.test(s.text));
        const last = saves.at(-1);
        return {
          progress, batches, kindsSent, saves: saves.length, limits: LIMITS, translatable: translatable.length,
          wordlessSent: wordless.filter((s) => sent.has(s.sid)).length, wordlessCopied: wordless.every((s) => t.translations.get(s.sid) === s.text),
          exact: translatable.filter((s) => /[A-Za-z]{2,}/.test(s.text)).every((s) => t.translations.get(s.sid) === ('〔번역〕 ' + s.text).trim()),
          savedItems: Object.keys(last.items).length, savedValid: Object.entries(last.items).every(([sid, it]) => it.h === hash(doc.sentenceById.get(sid).text) && it.m === 'mock'),
          savedShape: { version: last.version, targetLang: last.targetLang, segVersion: last.segVersion, hasUpdatedAt: typeof last.updatedAt === 'number' },
          refTranslated: doc.sentences.some((s) => s.kind === 'reference' && t.translations.has(s.sid)),
        };
      `);
      assert.equal(r.progress.done, r.progress.total);
      assert.equal(r.progress.total, r.translatable);
      assert.equal(r.progress.failed, 0);
      assert.ok(r.batches.every((b) => b.n <= r.limits.translateBatchMaxSentences), 'sentence limit');
      assert.ok(r.batches.every((b) => b.chars <= r.limits.translateBatchMaxChars), 'char limit');
      assert.ok(r.batches.every((b) => b.ordered), 'reading order inside batches');
      assert.ok(r.batches.some((b) => b.n === r.limits.translateBatchMaxSentences), 'sentence limit binds on short pages');
      assert.ok(r.batches.some((b) => b.n < 30 && b.chars > 3000), 'char limit binds on long pages');
      assert.deepEqual(r.kindsSent.sort(), ['body', 'caption', 'heading']);
      assert.equal(r.wordlessSent, 0);
      assert.ok(r.wordlessCopied && r.exact && !r.refTranslated);
      assert.equal(r.saves, r.batches.length, 'save callback after each batch');
      assert.ok(r.savedValid);
      assert.deepEqual(r.savedShape, { version: 1, targetLang: 'ko', segVersion: 1, hasUpdatedAt: true });
      const sizes = r.batches.map((b) => `${b.n}/${b.chars}c`).join(' ');
      return `${r.progress.done}/${r.progress.total} in ${r.batches.length} batches [n/chars: ${sizes}]; saves=${r.saves}`;
    },
  },
  {
    name: 'concurrency cap from settings is observed (3, then 2); cold start sends one batch alone to warm the prompt cache',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        mockControl.latencyMs = 40;
        const out = {};
        for (const c of [3, 2]) {
          mockControl.reset(); mockControl.latencyMs = 40;
          settings.set({ translate: { concurrency: c } });
          const t = new Translator({ doc });
          await t.translateAll();
          const rs = reqs();
          out[c] = { max: mockControl.maxInFlight, first: rs[0].concurrent, secondAfterFirst: rs[1].startedAt >= rs[0].endedAt,
            reachedCap: rs.filter((q) => q.concurrent === c).length, n: rs.length };
        }
        return out;
      `);
      for (const c of [3, 2]) {
        assert.equal(r[c].max, c, `max in flight for concurrency ${c}`);
        assert.equal(r[c].first, 1);
        assert.ok(r[c].secondAfterFirst, 'second request starts only after the first one returned');
        assert.ok(r[c].reachedCap > 0);
      }
      return `concurrency 3 → max in flight ${r[3].max} (${r[3].reachedCap}/${r[3].n} requests at cap); concurrency 2 → ${r[2].max}; first batch solo`;
    },
  },
  {
    name: 'startPage priority (pages 7–12 then 1–6) and translatePages() mid-run jumps the queue',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        settings.set({ translate: { concurrency: 1 } });
        mockControl.latencyMs = 15;
        const t = new Translator({ doc });
        let jumpAt = -1;
        let pagesDone = null;
        t.addEventListener('update', () => {
          if (jumpAt >= 0) return;
          jumpAt = reqs().length;
          pagesDone = t.translatePages([3]);
        });
        const all = t.translateAll({ startPage: 7 });
        await Promise.all([all, new Promise((r) => setTimeout(r, 50)).then(() => pagesDone)]);
        const pageOf = (id) => doc.sentenceById.get(id).page;
        const seq = reqs().map((q) => [...new Set(q.ids.map(pageOf))]);
        return { seq, jumpAt, progress: t.progress };
      `);
      const firstPages = r.seq.map((pages) => pages[0]);
      assert.equal(firstPages[0], 7, 'first batch starts at page 7');
      assert.deepEqual(r.seq[r.jumpAt], [3], 'the batch right after translatePages([3]) is page 3');
      const rest = firstPages.filter((_, i) => i !== r.jumpAt);
      const wrap = rest.findIndex((p) => p < 7);
      assert.ok(rest.slice(0, wrap).every((p) => p >= 7) && rest.slice(wrap).every((p) => p < 7), `order ${rest}`);
      assert.ok(rest.slice(0, wrap).every((p, i, a) => i === 0 || p >= a[i - 1]));
      assert.equal(r.progress.done, r.progress.total);
      return `batch first pages: ${firstPages.join(',')} (page-3 jump at batch #${r.jumpAt})`;
    },
  },
  {
    name: 'cache reuse by hash: valid cached items reused; changed sentence text → only those re-translated',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        const t1 = new Translator({ doc });
        await t1.translateAll();
        const saved = JSON.parse(JSON.stringify(t1.toJSON()));
        const firstRun = reqs().length;
        const doc2 = buildSyntheticDoc();
        const changed = ['p2-3', 'p8-5', 'p10-1'];
        for (const sid of changed) doc2.sentenceById.get(sid).text += ' Revised wording';
        mockControl.reset(); mockControl.latencyMs = 5;
        const t2 = new Translator({ doc: doc2, cached: saved });
        const before = { progress: t2.progress, status: changed.map((s) => t2.statusOf(s)), keep: t2.translations.get('p2-4') === t1.translations.get('p2-4') };
        await t2.translateAll();
        const sent = reqs().flatMap((q) => q.ids).sort();
        const wrongLang = new Translator({ doc, cached: { ...saved, targetLang: 'ja' } }).progress.done;
        return { firstRun, before, sent, changed, after: t2.progress, newText: t2.translations.get('p2-3'), src: doc2.sentenceById.get('p2-3').text, wrongLang };
      `);
      assert.equal(r.before.progress.done, r.before.progress.total - 3);
      assert.deepEqual(r.before.status, [null, null, null]);
      assert.ok(r.before.keep);
      assert.deepEqual(r.sent, [...r.changed].sort(), 'only the changed sentences are sent');
      assert.equal(r.after.done, r.after.total);
      assert.equal(r.newText, ('〔번역〕 ' + r.src).trim());
      assert.ok(r.wrongLang < 20, 'cache for another target language is ignored (only wordless copies count)');
      return `first run ${r.firstRun} requests; reopened with cache: ${r.before.progress.done}/${r.before.progress.total} done, re-sent only ${r.sent.join(',')}`;
    },
  },
  {
    name: 'ids missing from a response are retried once; a permanently missing id is marked failed (no endless retries)',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        mockControl.dropIdsOnce = new Set(['p2-3', 'p5-7']);
        mockControl.dropIdsAlways = new Set(['p3-4']);
        const t = new Translator({ doc });
        const errors = [];
        const failedUpdates = [];
        t.addEventListener('error', (e) => errors.push(e.detail));
        t.addEventListener('update', (e) => e.detail.failed && failedUpdates.push(...e.detail.failed));
        const progress = await t.translateAll();
        const count = (sid) => reqs().filter((q) => q.ids.includes(sid)).length;
        const retryReqs = reqs().filter((q) => q.ids.length <= 2).map((q) => q.ids);
        const st = t.statusOf('p3-4');
        const counts = { 'p2-3': count('p2-3'), 'p5-7': count('p5-7'), 'p3-4': count('p3-4') };
        mockControl.dropIdsAlways.clear();
        const again = await t.translateSids(['p3-4']);
        return { progress, counts, retryReqs, st, errors: [...errors], failedUpdates, again, after: t.statusOf('p3-4') };
      `);
      assert.deepEqual(r.counts, { 'p2-3': 2, 'p5-7': 2, 'p3-4': 2 });
      assert.deepEqual(r.retryReqs.map((x) => x.join(',')).sort(), ['p2-3', 'p3-4', 'p5-7']);
      assert.equal(r.st, 'failed');
      assert.equal(r.progress.failed, 1);
      assert.equal(r.progress.done, r.progress.total - 1);
      assert.equal(r.errors.length, 1);
      assert.equal(r.errors[0].fatal, false);
      assert.deepEqual(r.errors[0].sids, ['p3-4']);
      assert.deepEqual(r.failedUpdates, ['p3-4']);
      assert.equal(r.after, 'done');
      assert.equal(r.again.failed, 0);
      return `requests per id ${JSON.stringify(r.counts)}; retry batches ${JSON.stringify(r.retryReqs)}; error "${r.errors[0].message}"; translateSids retry → ${r.after}`;
    },
  },
  {
    name: 'max_tokens on a batch → split in halves and retried; everything still translated',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        mockControl.failNext = [{ code: 'max_tokens' }];
        const t = new Translator({ doc });
        const p = await t.translateAll();
        const rs = reqs();
        return { p, sizes: rs.slice(0, 3).map((q) => q.ids), };
      `);
      const [full, a, b] = r.sizes;
      assert.deepEqual([...a, ...b], full);
      assert.equal(a.length, Math.ceil(full.length / 2));
      assert.equal(r.p.done, r.p.total);
      return `failed batch of ${full.length} → ${a.length} + ${b.length}; ${r.p.done}/${r.p.total} done`;
    },
  },
  {
    name: 'cancel() mid-run aborts in-flight requests, stops sending, keeps finished work; a new run resumes',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        mockControl.latencyMs = 60;
        const t = new Translator({ doc });
        const dones = [];
        t.addEventListener('done', (e) => dones.push(e.detail));
        let updates = 0;
        let atCancel = null;
        t.addEventListener('update', () => {
          if (++updates === 3) { t.cancel(); atCancel = { requests: reqs().length, inFlight: mockControl.inFlight }; }
        });
        const t0 = performance.now();
        const progress = await t.translateAll();
        const resolvedMs = performance.now() - t0;
        await new Promise((r) => setTimeout(r, 400));
        const afterWait = { requests: reqs().length, inFlight: mockControl.inFlight, running: t.running };
        const aborted = reqs().filter((q) => q.endedAt - q.startedAt < 50).length;
        const doneBefore = t.progress.done;
        const resumed = await t.translateAll();
        const dup = reqs().slice(afterWait.requests).flatMap((q) => q.ids).filter((id, i, a) => a.indexOf(id) !== i).length;
        return { progress, atCancel, afterWait, aborted, dones, doneBefore, resumed, dup };
      `);
      assert.ok(r.progress.done > 0 && r.progress.done < r.progress.total, `partial: ${r.progress.done}/${r.progress.total}`);
      assert.equal(r.progress.pending, 0);
      assert.equal(r.afterWait.requests, r.atCancel.requests, 'no request after cancel()');
      assert.equal(r.afterWait.inFlight, 0);
      assert.equal(r.afterWait.running, false);
      assert.ok(r.aborted >= 1, 'in-flight requests were aborted early');
      assert.deepEqual(r.dones.map((d) => d.cancelled), [true, false]);
      assert.equal(r.resumed.done, r.resumed.total);
      assert.equal(r.dup, 0);
      return `cancelled at ${r.atCancel.requests} requests (${r.atCancel.inFlight} in flight, ${r.aborted} aborted) with ${r.doneBefore}/${r.progress.total} done; resumed → ${r.resumed.done}/${r.resumed.total}`;
    },
  },
  {
    name: 'progress + cost: monotonic progress events, costUsd equals sum of recorded usage (Haiku prices), usage summary',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        usage.clearUsage();
        mockControl.reportModel = 'claude-haiku-5-5';
        const t = new Translator({ doc, paperId: 'paperX' });
        const progress = [];
        t.addEventListener('progress', (e) => progress.push(e.detail));
        let busUsd = 0;
        const off = bus.on('usage:change', (d) => { if (d.usage) busUsd += d.usd; });
        const final = await t.translateAll();
        off();
        const summary = usage.usageSummary();
        return { final, busUsd, monotonic: progress.every((p, i) => i === 0 || p.done >= progress[i - 1].done),
          events: progress.length, last: progress.at(-1), summary, n: reqs().length, tokens: t.usage };
      `);
      assert.ok(r.final.costUsd > 0);
      assert.ok(Math.abs(r.final.costUsd - r.busUsd) < 1e-12, `${r.final.costUsd} vs ${r.busUsd}`);
      assert.ok(Math.abs(r.summary.usd - r.final.costUsd) < 1e-12);
      assert.ok(r.monotonic);
      assert.equal(r.last.done, r.last.total);
      assert.equal(r.summary.byTask.translate.calls, r.n);
      assert.equal(r.summary.byPaper.paperX.calls, r.n);
      assert.ok(r.summary.byModel['claude-haiku-5-5'].cacheReadTokens > 0, 'later batches read the cached system prefix');
      assert.equal(r.summary.byModel['claude-haiku-5-5'].cacheWriteTokens > 0, true);
      return `${r.events} progress events, cost $${r.final.costUsd.toFixed(6)} = Σ usage events; month ${r.summary.month}: ${r.summary.calls} calls, tokens ${JSON.stringify(r.tokens)}`;
    },
  },
  {
    name: 'fatal error (bad key) and 400 stop the run at once; 3 consecutive transient failures stop it too',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        const run = async (fails) => {
          mockControl.reset(); mockControl.latencyMs = 5;
          mockControl.failNext = fails;
          const t = new Translator({ doc });
          const initialDone = t.progress.done; // wordless sentences are copied locally
          const errors = []; const dones = [];
          t.addEventListener('error', (e) => errors.push(e.detail));
          t.addEventListener('done', (e) => dones.push(e.detail));
          const p = await t.translateAll();
          await new Promise((r) => setTimeout(r, 100));
          return { p, initialDone, errors, dones, n: reqs().length };
        };
        return { fatal: await run([{ code: 'auth' }]), transient: await run([{ code: 'network' }, { code: 'network' }, { code: 'network' }]),
          badRequest: await run([{ code: 'bad_request', message: 'Claude가 요청을 처리할 수 없습니다(잘못된 요청). 상세: Your credit balance is too low' }]) };
      `);
      assert.equal(r.fatal.n, 1);
      assert.equal(r.fatal.errors[0].fatal, true);
      assert.equal(r.fatal.p.done, r.fatal.initialDone);
      assert.equal(r.fatal.p.pending, 0);
      assert.deepEqual(r.fatal.dones.map((d) => d.stopped), [true]);
      assert.equal(r.transient.n, 3);
      assert.ok(r.transient.errors.some((e) => /연속/.test(e.message)));
      assert.deepEqual(r.transient.dones.map((d) => d.stopped), [true]);
      assert.equal(r.badRequest.n, 1, 'a 400 stops the run at the first batch');
      assert.equal(r.badRequest.errors.length, 1, 'one error event (one toast) for a stopped run');
      assert.deepEqual(r.badRequest.dones.map((d) => d.stopped), [true]);
      assert.match(r.badRequest.errors.at(-1).message, /credit balance is too low.*번역을 멈췄습니다/);
      return `auth → 1 request, fatal "${r.fatal.errors[0].message}"; network×3 → "${r.transient.errors.at(-1).message}"; 400 → 1 request, "${r.badRequest.errors.at(-1).message}"`;
    },
  },
  {
    name: 'every request: identical cacheable system prefix; 2 preceding source sentences as read-only context',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        settings.set({ translate: { glossary: [{ src: 'delirium', tgt: '섬망' }], keepTermsInEnglish: true } });
        const t = new Translator({ doc });
        await t.translateAll();
        const rs = reqs();
        const sys0 = JSON.stringify(rs[0].system);
        const prev2 = (sid) => { const out = []; for (let i = idx.get(sid) - 1; i >= 0 && out.length < 2; i--) { const s = doc.sentences[i]; if (s.kind !== 'furniture') out.unshift(s.text); } return out; };
        const ctxOk = rs.every((q) => JSON.stringify(P.parseTranslationUserMessage(q.messages[0].content).context.filter(Boolean)) === JSON.stringify(prev2(q.ids[0])));
        return { same: rs.every((q) => JSON.stringify(q.system) === sys0), blocks: rs[0].system.map((b) => ({ cache: Boolean(b.cache), len: b.text.length })),
          glossary: rs[0].system[1].text.includes('delirium → 섬망'), effort: [...new Set(rs.map((q) => q.effort))], ctxOk,
          firstCtx: P.parseTranslationUserMessage(rs[0].messages[0].content).context, secondCtx: P.parseTranslationUserMessage(rs[1].messages[0].content).context };
      `);
      assert.ok(r.same);
      assert.deepEqual(r.blocks.map((b) => b.cache), [false, true]);
      assert.ok(r.blocks[0].len > 2048 * 2, 'rules block alone is well above the 512-token cache minimum');
      assert.ok(r.glossary);
      assert.deepEqual(r.effort, ['low']);
      assert.ok(r.ctxOk);
      assert.equal(r.secondCtx.length, 2);
      return `system blocks ${JSON.stringify(r.blocks)}; first ctx ${JSON.stringify(r.firstCtx)}; second ctx ${JSON.stringify(r.secondCtx).slice(0, 120)}…`;
    },
  },
  {
    name: 'regression fatal-ai-error-marks-sentences-failed: a bad key / no credit stops the run with ONE fatal error and leaves sentences untranslated, not failed',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        const run = async (fail) => {
          mockControl.reset(); mockControl.latencyMs = 5;
          mockControl.failNext = [fail];
          const t = new Translator({ doc });
          const errors = []; const failedUpdates = [];
          t.addEventListener('error', (e) => errors.push(e.detail));
          t.addEventListener('update', (e) => e.detail.failed && failedUpdates.push(...e.detail.failed));
          const p = await t.translateAll();
          return { p, errors, failedUpdates, statuses: [...new Set(translatable.map((s) => t.statusOf(s.sid)))] };
        };
        return { auth: await run({ code: 'auth' }), billing: await run({ code: 'billing' }), badRequest: await run({ code: 'bad_request' }) };
      `);
      for (const [k, x] of Object.entries(r)) {
        assert.equal(x.p.failed, 0, `${k}: no sentence may be marked failed`);
        assert.deepEqual(x.failedUpdates, [], `${k}: no failed updates`);
        assert.equal(x.errors.length, 1, `${k}: one error event`);
        assert.equal(x.errors[0].fatal, true, `${k}: fatal`);
        assert.deepEqual(x.errors[0].sids, [], `${k}: the error names no sentences`);
        assert.ok(!x.statuses.includes('failed'), `${k}: statuses ${x.statuses}`);
      }
      return Object.entries(r).map(([k, x]) => `${k}: failed=${x.p.failed}, error fatal=${x.errors[0].fatal} code=${x.errors[0].code}`).join('; ');
    },
  },
  {
    name: 'sentences that are only a URL / DOI / e-mail address are shown as is and never sent (like number-only sentences)',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        const ids = ['https://doi.org/10.1111/nicc.70196', 'E-mail: jane.doe@univ.edu', 'www.clinicaltrials.gov', 'doi:10.1097/CCM.0000000000004520'];
        const body = doc.sentences.filter((s) => s.kind === 'body').slice(5, 9);
        body.forEach((s, i) => { s.text = ids[i]; });
        const prose = doc.sentences.filter((s) => s.kind === 'body')[12];
        prose.text = 'Details are available at https://example.org/protocol for all of the participating sites.';
        const t = new Translator({ doc });
        await t.translateAll();
        const sent = new Set(reqs().flatMap((q) => q.ids));
        return { copied: body.map((s) => [t.translations.get(s.sid) === s.text, sent.has(s.sid)]), proseSent: sent.has(prose.sid),
          saved: Object.keys(t.toJSON().items).filter((sid) => body.some((s) => s.sid === sid)).length };
      `);
      assert.deepEqual(r.copied, [[true, false], [true, false], [true, false], [true, false]]);
      assert.equal(r.proseSent, true, 'a sentence with words around a URL is still translated');
      assert.equal(r.saved, 0, 'copied sentences are not written to the translation file');
      return `copied as is, not sent: ${JSON.stringify(r.copied)}; prose with a URL sent=${r.proseSent}`;
    },
  },
  {
    name: 'max_tokens: request cap scales with the batch; finished entries of a cut-off answer are kept, only the rest is re-sent',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        const t0 = new Translator({ doc });
        let caps = null;
        mockControl.reset(); mockControl.latencyMs = 5;
        // First batch is cut off after two finished entries.
        let first = true;
        mockControl.failWhen = (req) => {
          if (!first || req.task !== 'translate') return null;
          first = false;
          const [a, b] = req.items;
          const part = '{"translations":[{"id":"' + a.sid + '","ko":"부분 번역 ' + a.text.replace(/"/g, '') + '"},{"id":"' + b.sid + '","ko":"부분 번역 ' + b.text.replace(/"/g, '') + '"},{"id":"' + req.items[2].sid + '","ko":"끝나지 않은';
          return { code: 'max_tokens', partialText: part };
        };
        const p = await t0.translateAll();
        const rs = reqs();
        caps = rs.map((q) => ({ n: q.ids.length, chars: q.items.reduce((n, it) => n + it.text.length, 0), max: q.maxTokens }));
        return { p, caps, firstIds: rs[0].ids, secondIds: rs[1].ids, salvaged: [t0.translations.get(rs[0].ids[0]), t0.translations.get(rs[0].ids[1])] };
      `);
      assert.equal(r.p.done, r.p.total);
      assert.deepEqual(r.secondIds, r.firstIds.slice(2), 'only the unfinished ids are re-sent');
      assert.ok(r.salvaged.every((x) => x.startsWith('부분 번역')), 'salvaged entries kept');
      assert.ok(r.caps.every((c) => c.max >= 4000 && c.max <= 16000), JSON.stringify(r.caps.slice(0, 3)));
      const small = r.caps.reduce((a, b) => (b.chars < a.chars ? b : a));
      const big = r.caps.reduce((a, b) => (b.chars > a.chars ? b : a));
      assert.ok(small.max < big.max && big.max < 16000, `cap follows the batch size: ${JSON.stringify({ small, big })}`);
      return `first batch ${r.firstIds.length} ids cut off → 2 salvaged, ${r.secondIds.length} re-sent; caps ${small.max} (${small.chars} chars) … ${big.max} (${big.chars} chars)`;
    },
  },
  {
    name: 'refusal of one sentence in a batch: bisected so only that sentence fails',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        const bad = translatable[7].sid;
        mockControl.failWhen = (req) => (req.task === 'translate' && req.ids.includes(bad) ? { code: 'refusal' } : null);
        const t = new Translator({ doc });
        const errors = [];
        t.addEventListener('error', (e) => errors.push(e.detail));
        const p = await t.translateAll();
        return { p, bad, failed: translatable.filter((s) => t.statusOf(s.sid) === 'failed').map((s) => s.sid), errors };
      `);
      assert.deepEqual(r.failed, [r.bad]);
      assert.equal(r.p.done, r.p.total - 1);
      assert.match(r.errors[0].message, /Sonnet 5\.5/);
      return `failed only ${r.failed}; ${r.p.done}/${r.p.total} done; hint "${r.errors[0].message}"`;
    },
  },
  {
    name: 'fidelity checks: a translation that drops numbers is re-requested once, then kept with a warning',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        const s = translatable.find((x) => x.kind === 'body');
        s.text = 'The odds ratio for delirium was OR = 1.23 (95% CI 1.01-1.50) among the 214 patients in the unit.';
        const other = translatable.filter((x) => x.kind === 'body')[3];
        let calls = 0;
        mockControl.translateWith = (it) => {
          if (it.sid === s.sid) { calls++; return calls === 1 ? '섬망의 교차비는 높았다.' : '섬망의 교차비는 OR = 1.23이었다.'; }
          if (it.sid === other.sid) return '〔번역〕 ' + it.text;
          return '〔번역〕 ' + it.text;
        };
        const t = new Translator({ doc });
        await t.translateAll();
        return { calls, kept: t.translations.get(s.sid), warn: t.warnings.get(s.sid), saved: t.toJSON().items[s.sid], otherWarn: t.warnings.has(other.sid) };
      `);
      assert.equal(r.calls, 2, 'retried once');
      assert.equal(r.kept, '섬망의 교차비는 OR = 1.23이었다.');
      assert.equal(r.warn, 'numbers');
      assert.equal(r.saved.w, 'numbers', 'the warning is saved with the item');
      assert.equal(r.otherWarn, false);
      return `requests for the sentence: ${r.calls}; kept "${r.kept}" with warning ${r.warn}`;
    },
  },
  {
    name: 'regression hanja-slip: a Korean answer with Chinese characters (文献, 중症) is re-requested once; the clean retry is kept without a warning, a repeated slip is kept with one',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        const bodies = translatable.filter((x) => x.kind === 'body');
        const a = bodies[0];
        const b = bodies[1];
        let callsA = 0;
        let callsB = 0;
        mockControl.translateWith = (it) => {
          if (it.sid === a.sid) { callsA++; return callsA === 1 ? '다음 기준에 해당하는 文献은 제외하였다.' : '다음 기준에 해당하는 문헌은 제외하였다.'; }
          if (it.sid === b.sid) { callsB++; return '기관내관 삽관은 중症 환자에게 필수적인 중재이다.'; }
          return '〔번역〕 ' + it.text;
        };
        const t = new Translator({ doc });
        await t.translateAll();
        return {
          callsA, callsB, keptA: t.translations.get(a.sid), warnA: t.warnings.get(a.sid) ?? null,
          keptB: t.translations.get(b.sid), warnB: t.warnings.get(b.sid) ?? null, savedB: t.toJSON().items[b.sid]?.w ?? null,
          p: t.progress,
        };
      `);
      assert.equal(r.callsA, 2, 'retried once');
      assert.equal(r.keptA, '다음 기준에 해당하는 문헌은 제외하였다.');
      assert.equal(r.warnA, null, 'the clean retry carries no warning');
      assert.equal(r.callsB, 2, 'retried once, not more');
      assert.equal(r.warnB, 'script');
      assert.equal(r.savedB, 'script', 'the warning is saved with the item');
      assert.equal(r.p.failed, 0, 'a script slip is a warning, never a failure');
      return `A: ${r.callsA} requests → "${r.keptA}"; B: ${r.callsB} requests, kept with warning ${r.warnB}`;
    },
  },
  {
    name: 'first-mention rule across batches: earlier English parentheticals are listed as introduced; context carries its Korean',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        settings.set({ translate: { keepTermsInEnglish: true, concurrency: 1 } });
        let n = 0;
        mockControl.translateWith = (it) => (n++ === 0 ? '섬망(delirium)은 흔하다. ' + it.text : '〔번역〕 ' + it.text);
        const t = new Translator({ doc });
        await t.translateAll();
        const rs = reqs();
        const second = rs[1].messages[0].content;
        settings.set({ translate: { concurrency: 3 } });
        return { second: second.slice(0, 600), hasIntroduced: /<introduced>\\ndelirium\\n<\\/introduced>/.test(second), hasKo: /<context_ko>\\n\\[\\d\\] /.test(second),
          parse: P.parseTranslationUserMessage(second).items.length === rs[1].ids.length };
      `);
      assert.ok(r.hasIntroduced, r.second);
      assert.ok(r.hasKo, r.second);
      assert.ok(r.parse);
      return r.second.split('<translate>')[0].replace(/\n/g, '⏎').slice(0, 300);
    },
  },
  {
    name: 'cache lookup falls back to the text hash when a resegmentation shifted the sids',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        const t1 = new Translator({ doc });
        await t1.translateAll();
        const saved = t1.toJSON();
        // Shift every item one sid later on page 3 (as if a split earlier on the page renumbered them).
        const items = {};
        for (const [sid, it] of Object.entries(saved.items)) items[sid.startsWith('p3-') ? 'x' + sid : sid] = it;
        mockControl.reset();
        const t2 = new Translator({ doc, cached: { ...saved, items } });
        const before = t2.progress;
        await t2.translateAll();
        return { before, sent: reqs().length };
      `);
      assert.equal(r.before.done, r.before.total);
      assert.equal(r.sent, 0, 'nothing re-sent');
      return `${r.before.done}/${r.before.total} restored by hash, ${r.sent} requests`;
    },
  },
  {
    name: 'regression term-drift: renderings one batch reports are binding for later batches (<terms> after the cached prefix), saved in translation.json, reloaded and merged; the glossary wins',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        const { mergeTranslation } = await import('/js/store/merge.js');
        settings.set({ translate: { concurrency: 1, glossary: [] } });
        const body = (p) => doc.sentences.filter((s) => s.page === p && s.kind === 'body');
        const s1 = body(1)[2], s4 = body(4)[5], s9 = body(9)[3];
        s1.text = 'An endotracheal tube (ETT) holder reduced medical device-related pressure injuries (MDRPIs).';
        s4.text = 'Securing the ETTs prevented tube dislodgement in most patients.';
        s9.text = 'MDRPIs were less frequent with holders, and the endotracheal tubes stayed in place for the whole stay in the unit.';
        const ko = (t) => '〔번역〕 ' + t.replace(/endotracheal tubes?/gi, '기관내관').replace(/medical device-related pressure injur(?:y|ies)/gi, '의료기기 관련 욕창');
        const report = (req) => (req.items.some((it) => /endotracheal/i.test(it.text))
          ? [{ en: 'endotracheal tube (ETT)', ko: '기관내관' }, { en: 'medical device-related pressure injury (MDRPI)', ko: '의료기기 관련 욕창 (MDRPI)' },
            { en: 'holder', ko: '홀더' } /* not what the translation says */, { en: 'endotracheal tube', ko: '기관내 튜브' } /* a second rendering */]
          : []);
        mockControl.translateWith = (it) => ko(it.text);
        mockControl.termsWith = report;
        const saves = [];
        const t = new Translator({ doc, save: async (o) => { saves.push(JSON.parse(JSON.stringify(o))); } });
        await t.translateAll();
        const rs = reqs();
        const reqOf = (s) => rs.find((q) => q.ids.includes(s.sid));
        const sys0 = JSON.stringify(rs[0].system);
        const ctxText = (q) => P.parseTranslationUserMessage(q.messages[0].content).context.join(' ');
        const mentions = (q) => /\\bETTs?\\b|endotracheal|MDRPI/i.test(q.items.map((i) => i.text).join(' ') + ' ' + ctxText(q));
        const firstAt = rs.indexOf(reqOf(s1));
        const out = {
          terms: t.terms, firstAt,
          before: rs.slice(0, firstAt + 1).map((q) => q.terms.length),
          at4: reqOf(s4).terms, at9: reqOf(s9).terms,
          unrelated: rs.filter((q, i) => i > firstAt && !mentions(q)).map((q) => q.terms.length),
          sameSystem: rs.every((q) => JSON.stringify(q.system) === sys0),
          listInSystem: sys0.includes('→ 기관내관'),
          userHasList: reqOf(s4).messages[0].content.includes('<terms>\\nendotracheal tube (ETT) → 기관내관\\n</terms>'),
          saved: saves.at(-1).terms, savedItems: Object.keys(saves.at(-1).items).length,
        };
        // Reopened from the file, and merged with another device's file (union by key, first rendering kept).
        const file = saves.at(-1);
        out.reloaded = new Translator({ doc, cached: file }).terms;
        const other = { ...file, items: {}, terms: { 'skin tear': { en: 'skin tear', ko: '피부 찢김' }, 'endotracheal tube': { en: 'endotracheal tube', ko: '기관튜브' } } };
        const merged = mergeTranslation(file, other);
        out.mergedKeys = Object.keys(merged.terms);
        out.merged = new Translator({ doc, cached: merged }).terms.map((x) => x.en + '=' + x.ko);
        const late = new Translator({ doc });
        late.mergeCached(other);
        out.mergeCachedTerms = late.terms.map((x) => x.ko);
        // The user's glossary overrides an established term: it is no longer sent for that term.
        mockControl.reset(); mockControl.latencyMs = 5; mockControl.translateWith = (it) => ko(it.text);
        settings.set({ translate: { glossary: [{ src: 'endotracheal tube', tgt: '기관 내 튜브' }] } });
        const g = new Translator({ doc, cached: { ...file, items: {} } });
        await g.translateAll();
        out.glossed4 = reqs().find((q) => q.ids.includes(s4.sid)).terms;
        out.glossed9 = reqs().find((q) => q.ids.includes(s9.sid)).terms.map((x) => x.en);
        return out;
      `);
      const ETT = { en: 'endotracheal tube (ETT)', ko: '기관내관' };
      const MDRPI = { en: 'medical device-related pressure injury (MDRPI)', ko: '의료기기 관련 욕창' };
      assert.deepEqual(r.terms, [ETT, MDRPI], 'only renderings found in the translations; the first one wins');
      assert.ok(r.before.every((n) => n === 0), 'nothing established before the first mention');
      assert.deepEqual(r.at4, [ETT], 'page 4 (ETTs) gets the ETT rendering only');
      assert.deepEqual(r.at9, [ETT, MDRPI], 'page 9 gets both');
      assert.ok(r.unrelated.length > 5 && r.unrelated.every((n) => n === 0), 'batches without these terms carry no <terms>');
      assert.ok(r.sameSystem, 'the cached system prefix is identical for every batch');
      assert.equal(r.listInSystem, false, 'the growing list is not in the system prompt');
      assert.ok(r.userHasList);
      assert.deepEqual(r.saved, { 'endotracheal tube': ETT, 'medical device related pressure injury': MDRPI });
      assert.deepEqual(r.reloaded, [ETT, MDRPI]);
      assert.deepEqual(r.mergedKeys.sort(), ['endotracheal tube', 'medical device related pressure injury', 'skin tear']);
      assert.ok(r.merged.includes('endotracheal tube (ETT)=기관내관') && r.merged.includes('skin tear=피부 찢김') && !r.merged.some((x) => x.includes('기관튜브')),
        JSON.stringify(r.merged));
      assert.deepEqual(r.mergeCachedTerms, ['피부 찢김', '기관튜브'], "a fresh translator takes the other file's terms");
      assert.deepEqual(r.glossed4, [], 'glossary covers endotracheal tube → not sent');
      assert.deepEqual(r.glossed9, [MDRPI.en]);
      return `established ${r.terms.map((x) => `${x.en}→${x.ko}`).join('; ')} at batch #${r.firstAt}; page 4 got ${JSON.stringify(r.at4)}; ${r.unrelated.length} unrelated batches sent none; merged ${r.merged.join(', ')}`;
    },
  },
  {
    name: 'regression untranslated-counted-done: an answer still in English (front matter, affiliations) is re-requested once, then FAILED (retryable) — never done; name-only lines pass; cached English loads as failed',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        settings.set({ translate: { concurrency: 1 } });
        const b = doc.sentences.filter((s) => s.page === 1 && s.kind === 'body');
        const lines = {
          affil: '1Department of Nursing, Example General Hospital, Taipei, Taiwan | 2School of Nursing, Example University, Taipei, Taiwan',
          corr: 'Correspondence: Jane Doe (jane.doe@example.org)',
          dates: 'Received: 15 January 2025 | Revised: 6 September 2025 | Accepted: 12 September 2025',
          keywords: 'Keywords: AnchorFast | endotracheal tube holder | meta-analysis',
          authors: 'Jane Doe1,2 | John Roe1 | Ana van der Berg3',
          copyright: '© 2025 The Author(s).',
        };
        const sid = {};
        Object.keys(lines).forEach((k, i) => { b[i].text = lines[k]; sid[k] = b[i].sid; });
        const heading = doc.sentences.find((s) => s.page === 1 && s.kind === 'heading');
        heading.text = 'Nursing in Critical Care'; lines.journal = heading.text; sid.journal = heading.sid;
        const english = new Set(Object.values(sid));
        mockControl.translateWith = (it) => (english.has(it.sid) ? it.text : '〔번역〕 ' + it.text);
        const t = new Translator({ doc });
        const errors = []; const failedEvents = [];
        t.addEventListener('error', (e) => errors.push(e.detail));
        t.addEventListener('update', (e) => e.detail.failed && failedEvents.push(...e.detail.failed));
        const progress = await t.translateAll();
        const status = (tr) => Object.fromEntries(Object.entries(sid).map(([k, s]) => [k, tr.statusOf(s)]));
        const saved = JSON.parse(JSON.stringify(t.toJSON()));
        const out = {
          progress, status: status(t), sid, errors, failedEvents,
          counts: Object.fromEntries(Object.entries(sid).map(([k, s]) => [k, reqs().filter((q) => q.ids.includes(s)).length])),
          retryFlag: reqs().filter((q) => q.ids.includes(sid.affil)).map((q) => q.retry),
          shown: Object.keys(sid).filter((k) => t.translations.has(sid[k])),
          savedKeys: Object.keys(sid).filter((k) => saved.items[sid[k]]),
        };
        // A file written before this fix kept those English answers as done (with a warning).
        const old = JSON.parse(JSON.stringify(saved));
        for (const k of ['affil', 'corr', 'dates', 'keywords']) old.items[sid[k]] = { h: hash(lines[k]), t: lines[k], m: 'claude-haiku-5-5', w: 'untranslated' };
        const t2 = new Translator({ doc, cached: old });
        out.reopened = { status: status(t2), progress: t2.progress };
        const t3 = new Translator({ doc });
        out.mergeAdded = t3.mergeCached(old).filter((s) => english.has(s)).map((s) => Object.keys(sid).find((k) => sid[k] === s));
        // The retry the pane offers ('다시 시도' → translateSids) succeeds once the model answers in Korean.
        mockControl.reset(); mockControl.latencyMs = 5;
        const failed = Object.values(sid).filter((s) => t2.statusOf(s) === 'failed');
        const p = await t2.translateSids(failed);
        out.retried = { progress: p, status: status(t2), sent: reqs().flatMap((q) => q.ids).sort(), failed: failed.sort() };
        return out;
      `);
      const failedKeys = ['affil', 'corr', 'dates', 'keywords'];
      for (const k of failedKeys) {
        assert.equal(r.status[k], 'failed', `${k} must be failed`);
        assert.equal(r.counts[k], 2, `${k}: one retry`);
      }
      for (const k of ['authors', 'copyright', 'journal']) {
        assert.equal(r.status[k], 'done', `${k}: a name-only line may stay as is`);
        assert.equal(r.counts[k], 1);
      }
      assert.deepEqual(r.retryFlag, [false, true], 'the retry tells the model the segment came back in English');
      assert.equal(r.progress.failed, 4);
      assert.equal(r.progress.done, r.progress.total - 4);
      assert.deepEqual(r.shown.sort(), ['authors', 'copyright', 'journal']);
      assert.deepEqual(r.savedKeys.sort(), ['authors', 'copyright', 'journal'], 'English answers are not saved');
      assert.deepEqual([...r.failedEvents].sort(), failedKeys.map((k) => r.sid[k]).sort(), "'update' names them failed (the pane shows 다시 시도)");
      assert.equal(r.errors.length, 1);
      assert.match(r.errors[0].message, /영어 그대로/);
      assert.equal(r.errors[0].fatal, false);
      for (const k of failedKeys) assert.equal(r.reopened.status[k], 'failed', `reopened ${k}`);
      assert.equal(r.reopened.status.authors, 'done');
      assert.equal(r.reopened.progress.failed, 4);
      assert.deepEqual(r.mergeAdded.sort(), ['authors', 'copyright', 'journal'], 'mergeCached skips English items too');
      assert.deepEqual(r.retried.sent, r.retried.failed);
      for (const k of failedKeys) assert.equal(r.retried.status[k], 'done');
      assert.equal(r.retried.progress.failed, 0);
      return `failed after 2 requests each: ${failedKeys.join(', ')}; accepted as is: authors, copyright, journal; error "${r.errors[0].message}"; reopened old file → ${r.reopened.progress.failed} failed; retry → done`;
    },
  },
  {
    name: 'a failing save (storage full) stops the run instead of paying for translations that cannot be kept',
    query: Q,
    fn: async ({ page }) => {
      const r = await inPage(page, `
        const t = new Translator({ doc, save: async () => { throw new Error('브라우저 저장 공간이 부족합니다.'); } });
        const errors = []; const dones = [];
        t.addEventListener('error', (e) => errors.push(e.detail));
        t.addEventListener('done', (e) => dones.push(e.detail));
        await t.translateAll();
        await new Promise((res) => setTimeout(res, 50));
        return { n: reqs().length, errors, stopped: dones.map((d) => d.stopped) };
      `);
      assert.ok(r.n <= 3, `requests after the failed save: ${r.n}`);
      assert.equal(r.errors.length, 1);
      assert.match(r.errors[0].message, /저장하지 못해 번역을 멈췄습니다/);
      assert.deepEqual(r.stopped, [true]);
      return `${r.n} request(s), then stopped: "${r.errors[0].message}"`;
    },
  },
];

const { failed } = await runSuite('translator', tests);
process.exitCode = failed ? 1 : 0;
