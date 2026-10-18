// usage.js cost math + monthly totals, prompts.js formats/schemas, tasks.js with the mock provider — in the browser.
import assert from 'node:assert/strict';
import { runSuite } from './lib.mjs';

const Q = '?mock=1';
const near = (a, b, eps = 1e-12) => Math.abs(a - b) < eps;

const tests = [
  {
    name: 'costUsd(): Haiku short/long-context rates (threshold on total prompt incl. cache), Sonnet, Opus, parts, unknown models',
    query: Q,
    fn: async ({ page }) => {
      const r = await page.evaluate(async () => {
        const { costUsd } = await import('/js/ai/usage.js');
        const u = (model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0) => ({ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
        return {
          haikuShort: costUsd(u('claude-haiku-5-5', 10_000, 2_000)),
          haikuAtThreshold: costUsd(u('claude-haiku-5-5', 100_000, 0)),
          haikuLong: costUsd(u('claude-haiku-5-5', 150_000, 4_000)),
          haikuLongViaCache: costUsd(u('claude-haiku-5-5', 50_000, 1_000, 60_000)),
          haikuLongCacheWrite: costUsd(u('claude-haiku-5-5', 1_000, 0, 0, 120_000)),
          haikuShortCache: costUsd(u('claude-haiku-5-5', 1_000, 0, 10_000, 2_000)),
          sonnet: costUsd(u('claude-sonnet-5-5', 1_000, 1_000, 100_000, 10_000)),
          opusIO: costUsd(u('claude-opus-5-5', 1_000_000, 1_000_000)),
          opusCacheRead: costUsd(u('claude-opus-5-5', 0, 0, 1_000_000)),
          dated: costUsd(u('claude-sonnet-5-5-20261001', 1_000_000)),
          parts: costUsd({ ...u('claude-sonnet-5-5', 5), parts: [u('claude-sonnet-5-5', 1_000), u('claude-haiku-5-5', 1_000)] }),
          gemini: costUsd(u('gemini-2.5-flash', 1e6, 1e6)),
          fallbackOpus48: costUsd(u('claude-opus-4-8', 1e6, 0)),
          unknownClaude: costUsd({ ...u('claude-future-9', 1e6, 0), requestedModel: 'claude-sonnet-5-5' }),
          unknownPart: costUsd({ ...u('claude-opus-5-5', 0), requestedModel: 'claude-opus-5-5', parts: [u('claude-opus-5-5', 1e6), u('claude-nextgen-1', 1e6)] }),
          mock: costUsd(u('mock', 1e6, 1e6)),
          junk: costUsd(u('claude-haiku-5-5', -5, Number.NaN)),
          none: costUsd(null),
        };
      });
      const expect = {
        haikuShort: (10_000 * 0.10 + 2_000 * 0.50) / 1e6, // 0.002
        haikuAtThreshold: (100_000 * 0.10) / 1e6, // not "over" 100K
        haikuLong: (150_000 * 0.50 + 4_000 * 2.50) / 1e6, // 0.085
        haikuLongViaCache: (50_000 * 0.50 + 60_000 * 0.05 + 1_000 * 2.50) / 1e6, // 110K total prompt → long
        haikuLongCacheWrite: (1_000 * 0.50 + 120_000 * 0.625) / 1e6,
        haikuShortCache: (1_000 * 0.10 + 10_000 * 0.01 + 2_000 * 0.125) / 1e6,
        sonnet: (1_000 * 2 + 1_000 * 10 + 100_000 * 0.20 + 10_000 * 2.50) / 1e6, // 0.057
        opusIO: 24,
        opusCacheRead: 0.20, // Opus 5.5 cache reads are $0.20/MTok (0.05×)
        dated: 2,
        parts: (1_000 * 2 + 1_000 * 0.10) / 1e6,
        gemini: 0, mock: 0, junk: 0, none: 0,
        // Regression (fallback-cost-zero): fallback targets are priced; an unknown claude-* model is estimated at
        // the requested model's rates instead of $0.
        fallbackOpus48: 5, unknownClaude: 2, unknownPart: 4 + 4,
      };
      for (const [k, v] of Object.entries(expect)) assert.ok(near(r[k], v), `${k}: ${r[k]} ≠ ${v}`);
      return Object.entries(r).map(([k, v]) => `${k}=$${+v.toFixed(6)}`).join(' ');
    },
  },
  {
    name: 'recordUsage()/usageSummary(): monthly totals by model/task/paper in localStorage, bus event, 12-month pruning, corrupt storage',
    query: Q,
    fn: async ({ page }) => {
      const r = await page.evaluate(async () => {
        const U = await import('/js/ai/usage.js');
        const { bus } = await import('/js/core/bus.js');
        const { STORAGE_KEYS } = await import('/js/core/config.js');
        localStorage.setItem(STORAGE_KEYS.usage, '"garbage"');
        const corrupt = U.usageSummary();
        const months = {};
        for (let i = 1; i <= 14; i++) months[`2024-${String(i).padStart(2, '0')}`.replace('2024-13', '2025-01').replace('2024-14', '2025-02')] = { usd: 1, calls: 1, byModel: {}, byTask: {}, byPaper: {} };
        localStorage.setItem(STORAGE_KEYS.usage, JSON.stringify({ version: 1, months }));
        const events = [];
        const off = bus.on('usage:change', (d) => events.push(d));
        U.recordUsage({ model: 'claude-haiku-5-5', inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, { paperId: 'a', task: 'translate' });
        U.recordUsage({ model: 'claude-sonnet-5-5', inputTokens: 1_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, { paperId: 'a', task: 'summary' });
        U.recordUsage({ model: 'claude-sonnet-5-5', inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 5_000, cacheWriteTokens: 0, parts: [
          { model: 'claude-sonnet-5-5', inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          { model: 'claude-sonnet-5', inputTokens: 1_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        ] }, { task: 'chat' });
        off();
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.usage));
        return { corrupt, s: U.usageSummary(), monthKeys: Object.keys(stored.months).sort(), events: events.length, lastEvt: events.at(-1).summary.calls, current: U.monthKey() };
      });
      assert.equal(r.corrupt.calls, 0);
      assert.equal(r.s.month, r.current);
      assert.equal(r.s.calls, 3);
      // Regression (fallback-cost-zero): the fallback attempt on claude-sonnet-5 is priced too ($2/$10), not booked as $0.
      assert.ok(near(r.s.usd, 0.002 + 0.012 + 0.002 + 0.0021), `usd ${r.s.usd}`);
      assert.ok(r.s.byModel['claude-sonnet-5'].usd > 0, 'fallback model cost recorded');
      assert.equal(r.s.byModel['claude-haiku-5-5'].inputTokens, 10_000);
      assert.equal(r.s.byModel['claude-sonnet-5-5'].calls, 2);
      assert.equal(r.s.byModel['claude-sonnet-5'].calls, 1); // fallback attempt recorded under its own model
      assert.deepEqual(Object.keys(r.s.byTask).sort(), ['chat', 'summary', 'translate']);
      assert.equal(r.s.byPaper.a.calls, 2);
      assert.equal(r.monthKeys.length, 12);
      assert.ok(r.monthKeys.includes(r.current));
      assert.equal(r.events, 3);
      assert.equal(r.lastEvt, 3);
      return `month ${r.s.month}: ${r.s.calls} calls $${r.s.usd.toFixed(4)}; models ${Object.keys(r.s.byModel).join(',')}; kept ${r.monthKeys[0]}…${r.monthKeys.at(-1)}`;
    },
  },
  {
    name: 'prompts: translation message ↔ parser round trip (kinds, "<", "</s>", whitespace), system blocks, glossary, term style',
    query: Q,
    fn: async ({ page }) => {
      const r = await page.evaluate(async () => {
        const P = await import('/js/ai/prompts.js');
        const items = [
          { sid: 'p1-0', kind: 'heading', text: '2.1  Study\n design' },
          { sid: 'p1-1', kind: 'body', text: 'Delirium was lower (p < .05; 95% CI 0.2–0.8) [12].' },
          { sid: 'p1-2', kind: 'caption', text: 'Figure 1. A </s> tag inside.' },
        ];
        const msg = P.translationUserMessage({ items, context: [{ sid: 'p0-9', text: 'Prior   sentence.' }] });
        const parsed = P.parseTranslationUserMessage(msg);
        const sysOn = P.translationSystem({ meta: { title: 'T', abstract: 'x'.repeat(5000) } }, { keepTermsInEnglish: true, glossary: [{ src: 'delirium', tgt: '섬망' }, { src: ' ', tgt: 'x' }] });
        const sysOff = P.translationSystem({ meta: {} }, { keepTermsInEnglish: false, glossary: [] });
        // Regression (glossary-not-in-assist): summary/chat/explain/key points follow the same glossary and term style.
        const assistOn = P.assistSystem({ sentences: [], meta: { title: 'T' } }, { keepTermsInEnglish: true, glossary: [{ src: 'restraint', tgt: '신체보호대' }] });
        const assistOff = P.assistSystem({ sentences: [], meta: { title: 'T' } }, { keepTermsInEnglish: false, glossary: [] });
        return { msg, parsed, sysOn, sysOff, assistOn, assistOff, quick: P.quickTranslateSystem({ glossary: [{ src: 'fall', tgt: '낙상' }] }) };
      });
      assert.deepEqual(r.parsed.items.map((i) => [i.sid, i.kind]), [['p1-0', 'heading'], ['p1-1', 'body'], ['p1-2', 'caption']]);
      assert.equal(r.parsed.items[0].text, '2.1 Study design');
      assert.equal(r.parsed.items[1].text, 'Delirium was lower (p < .05; 95% CI 0.2–0.8) [12].');
      assert.equal(r.parsed.items[2].text, 'Figure 1. A < /s> tag inside.');
      assert.deepEqual(r.parsed.context, ['Prior sentence.']);
      assert.ok(!r.msg.includes('p0-9'), 'context sentences carry no id (cannot be returned)');
      assert.equal(r.sysOn.length, 2);
      assert.equal(r.sysOn[1].cache, true);
      assert.match(r.sysOn[0].text, /한국어|Korean/);
      assert.match(r.sysOn[0].text, /기계환기\(mechanical ventilation\)/);
      assert.match(r.sysOff[0].text, /Korean only/);
      assert.match(r.sysOn[1].text, /- delirium → 섬망/);
      assert.ok(!r.sysOn[1].text.includes('→ x'), 'blank glossary entries dropped');
      assert.match(r.sysOff[1].text, /\(none\)/);
      assert.match(r.assistOn[0].text, /- restraint → 신체보호대/);
      assert.match(r.assistOn[0].text, /섬망\(delirium\)/);
      assert.match(r.assistOff[0].text, /Korean only/);
      assert.equal(r.assistOn[1].cache, true);
      assert.ok(r.sysOn[1].text.length < 3000, 'abstract capped at 2000 chars');
      for (const rule of ["'~다' 체", '그림 1.', '표 3.', 'p < .05', 'Never merge, split, reorder, skip']) assert.ok(r.sysOn[0].text.includes(rule), rule);
      assert.match(r.quick, /fall → 낙상/);
      return `round trip ok; rules ${r.sysOn[0].text.length} chars, paper block ${r.sysOn[1].text.length} chars (cache:true)`;
    },
  },
  {
    name: 'schemas are strict-ready (every object: additionalProperties:false + all properties required); paper text formatting',
    query: Q,
    fn: async ({ page }) => {
      const r = await page.evaluate(async () => {
        const P = await import('/js/ai/prompts.js');
        const { buildSyntheticDoc } = await import('/tests/ai/synth.js');
        const problems = [];
        const walk = (s, path) => {
          if (s.type === 'object') {
            if (s.additionalProperties !== false) problems.push(`${path}: additionalProperties`);
            const keys = Object.keys(s.properties || {});
            if (JSON.stringify([...(s.required || [])].sort()) !== JSON.stringify(keys.sort())) problems.push(`${path}: required`);
            for (const [k, v] of Object.entries(s.properties || {})) walk(v, `${path}.${k}`);
          }
          if (s.type === 'array') walk(s.items, `${path}[]`);
        };
        walk(P.TRANSLATION_SCHEMA, 'translation');
        walk(P.KEYPOINTS_SCHEMA, 'keyPoints');
        const doc = buildSyntheticDoc();
        const full = P.paperText(doc);
        const cut = P.paperText(doc, { maxChars: 2000 });
        const empty = P.paperText({ sentences: [], meta: { title: 'Scan' } });
        const sys = P.assistSystem(doc);
        return { problems, full: full.slice(0, 300), hasFurniture: full.includes('Journal of Synthetic Nursing Research'), heading: /\[p1-1\] ## /.test(full),
          caption: /\[p2-\d+\] \(캡션\) Figure 1\./.test(full), cutLen: cut.length, cutNote: cut.includes('생략'), empty, sysCache: sys.map((b) => Boolean(b.cache)) };
      });
      assert.deepEqual(r.problems, []);
      assert.ok(!r.hasFurniture && r.heading && r.caption);
      assert.ok(r.cutLen < 2300 && r.cutNote);
      assert.match(r.empty, /추출된 텍스트가 없습니다/);
      assert.deepEqual(r.sysCache, [false, true]);
      return `schemas strict-ready; paper text starts: ${JSON.stringify(r.full.slice(0, 140))}`;
    },
  },
  {
    name: 'tasks (mock): summarize, keyPoints (≤25, valid, spread), quickTranslate — models, effort, cached system',
    query: Q,
    fn: async ({ page }) => {
      const r = await page.evaluate(async () => {
        const T = await import('/js/ai/tasks.js');
        const { mockControl } = await import('/js/ai/mock.js');
        const { buildSyntheticDoc } = await import('/tests/ai/synth.js');
        mockControl.reset();
        const doc = buildSyntheticDoc();
        const s = await T.summarize(doc);
        const k = await T.keyPoints(doc);
        const q = await T.quickTranslate('  The   incidence of delirium decreased.  ');
        const many = Array.from({ length: 60 }, (_, i) => ({ sid: doc.sentences.filter((x) => x.kind === 'body')[i * 3].sid, category: 'result' }));
        const sel = T.selectKeyPoints(doc, many, 25);
        let scanErr = null;
        try { await T.summarize({ sentences: [], meta: {} }); } catch (e) { scanErr = { code: e.code, message: e.message }; }
        const reqs = mockControl.requests.map((x) => ({ task: x.task, effort: x.effort, model: x.model, cache: Array.isArray(x.system) && x.system.at(-1).cache === true, json: Boolean(x.json) }));
        const pages = new Set(k.items.map((i) => doc.sentenceById.get(i.sid).page));
        const kinds = [...new Set(k.items.map((i) => doc.sentenceById.get(i.sid).kind))];
        return { s, k, q, sel: { n: sel.length, ordered: sel.every((x, i) => i === 0 || doc.sentences.findIndex((d) => d.sid === x.sid) > doc.sentences.findIndex((d) => d.sid === sel[i - 1].sid)), first: sel[0].sid, last: sel.at(-1).sid, manyLast: many.at(-1).sid }, scanErr, reqs, pages: pages.size, kinds };
      });
      assert.match(r.s.markdown, /^## 한 줄 요약/);
      assert.match(r.s.markdown, /\[p\d+-\d+\]/);
      assert.ok(r.k.items.length > 0 && r.k.items.length <= 25);
      assert.ok(r.pages >= 8, `key points spread over ${r.pages} pages`);
      assert.ok(r.kinds.every((k) => k === 'body' || k === 'caption'));
      assert.equal(r.q.text, '〔번역〕 The incidence of delirium decreased.');
      assert.equal(r.sel.n, 25);
      assert.ok(r.sel.ordered);
      assert.equal(r.sel.first, 'p1-2');
      assert.equal(r.scanErr?.code, 'bad_request');
      assert.deepEqual(r.reqs, [
        { task: 'summary', effort: 'medium', model: 'mock', cache: true, json: false },
        { task: 'keyPoints', effort: 'medium', model: 'mock', cache: true, json: true }, // same effort as the other assist tasks (shared cache)
        { task: 'quickTranslate', effort: 'low', model: 'mock', cache: false, json: false },
      ]);
      return `summary ${r.s.markdown.length} chars; keyPoints ${r.k.items.length} over ${r.pages} pages; quickTranslate "${r.q.text}"; scanned → "${r.scanErr.message}"`;
    },
  },
  {
    name: 'tasks (mock): chat & explain stream protocol (strings, then {done, usage}); history normalisation; image part; abort',
    query: Q,
    fn: async ({ page }) => {
      const r = await page.evaluate(async () => {
        const T = await import('/js/ai/tasks.js');
        const { mockControl } = await import('/js/ai/mock.js');
        const { buildSyntheticDoc } = await import('/tests/ai/synth.js');
        mockControl.reset();
        mockControl.streamDelayMs = 2;
        const doc = buildSyntheticDoc();
        const collect = async (gen) => { const out = []; for await (const x of gen) out.push(x); return out; };
        const history = [{ role: 'assistant', content: 'greeting' }, { role: 'user', content: 'q1' }, { role: 'user', content: 'q1b' },
          { role: 'assistant', content: 'a1', id: 'x', ts: 1 }, { role: 'user', content: '' }, { role: 'user', content: 'unanswered' }];
        const chat = await collect(T.chat(doc, history, '이 연구의 표본 수는?', { quote: 'We enrolled 240 patients.' }));
        const chatReq = mockControl.requests.at(-1);
        const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const ex = await collect(T.explain(doc, { quote: 'Delirium decreased.', imageDataUrl: png, nearSid: 'p4-5' }));
        const exReq = mockControl.requests.at(-1);
        const errs = {};
        try { await collect(T.explain(doc, {})); } catch (e) { errs.empty = e.code; }
        try { await collect(T.explain(doc, { imageDataUrl: 'data:text/html;base64,AAAA' })); } catch (e) { errs.badImage = e.code; }
        const ac = new AbortController();
        const got = [];
        try {
          for await (const x of T.chat(doc, [], '질문', { signal: ac.signal })) { got.push(x); if (got.length === 2) ac.abort(); }
        } catch (e) { errs.abort = e.code; }
        return {
          chatTypes: chat.map((x) => typeof x), last: chat.at(-1), text: chat.filter((x) => typeof x === 'string').join(''),
          roles: chatReq.messages.map((m) => m.role), contents: chatReq.messages.map((m) => m.content), effort: chatReq.effort, kind: chatReq.kind,
          exParts: exReq.messages[0].content.map((p) => p.type), exImage: exReq.messages[0].content[0], exText: exReq.messages[0].content[1].text,
          exDone: ex.at(-1), errs, gotBeforeAbort: got.length,
        };
      });
      assert.ok(r.chatTypes.slice(0, -1).every((t) => t === 'string') && r.chatTypes.at(-1) === 'object');
      assert.equal(r.last.done, true);
      assert.ok(r.last.usage && r.last.usage.outputTokens > 0);
      assert.match(r.text, /모의 답변/);
      assert.equal(r.kind, 'stream');
      assert.equal(r.effort, 'medium');
      assert.deepEqual(r.roles, ['user', 'assistant', 'user']);
      assert.equal(r.contents[0], 'q1\n\nq1b');
      assert.match(r.contents[2], /<quote>\nWe enrolled 240 patients\.\n<\/quote>\n\n이 연구의 표본 수는\?/);
      assert.deepEqual(r.exParts, ['image', 'text']);
      assert.equal(r.exImage.mediaType, 'image/png');
      assert.ok(r.exImage.data.startsWith('iVBOR'));
      assert.match(r.exText, /\[p4-5\]/);
      assert.match(r.exText, /\[p4-2\]/);
      assert.equal(r.exDone.done, true);
      assert.deepEqual(r.errs, { empty: 'bad_request', badImage: 'bad_request', abort: 'aborted' });
      return `chat: ${r.chatTypes.length - 1} chunks + done; roles ${r.roles.join('/')}; explain parts ${r.exParts.join('+')}; errors ${JSON.stringify(r.errs)}`;
    },
  },
];

const { failed } = await runSuite('unit', tests);
process.exitCode = failed ? 1 : 0;
