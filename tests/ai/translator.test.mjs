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
          exact: translatable.filter((s) => /[A-Za-z]{2,}/.test(s.text)).every((s) => t.translations.get(s.sid) === ('〔번역〕 ' + s.text.slice(0, 60)).trim()),
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
      assert.equal(r.newText, ('〔번역〕 ' + r.src.slice(0, 60)).trim());
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
];

const { failed } = await runSuite('translator', tests);
process.exitCode = failed ? 1 : 0;
