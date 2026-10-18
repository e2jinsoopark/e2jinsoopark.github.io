// Gemini provider in a real browser against a Playwright-routed generativelanguage.googleapis.com.
import assert from 'node:assert/strict';
import { recordRoute, runSuite, sse } from './lib.mjs';

const API = 'https://generativelanguage.googleapis.com/**';
const KEY = 'AIza-test-0000';
const MODEL = 'gemini-test-flash';

const candidate = (text, finishReason = 'STOP') => ({
  candidates: [{ content: { role: 'model', parts: [{ text: '생각 중…', thought: true }, { text }] }, finishReason }],
  usageMetadata: { promptTokenCount: 1500, cachedContentTokenCount: 1000, candidatesTokenCount: 80, thoughtsTokenCount: 20, totalTokenCount: 1600 },
  modelVersion: MODEL,
});

async function useGemini(page) {
  await page.evaluate(async ({ key, model }) => {
    const { settings } = await import('/js/core/settings.js');
    settings.set({ provider: 'gemini', gemini: { apiKey: key, translateModel: model, assistModel: model } });
  }, { key: KEY, model: MODEL });
}

const err = (status, statusText, message, details = []) => ({ status, json: { error: { code: status, message, status: statusText, details } } });

function hasKeyDeep(obj, key) {
  if (!obj || typeof obj !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return true;
  return Object.values(obj).some((v) => hasKeyDeep(v, key));
}

const tests = [
  {
    name: 'complete() with JSON schema: endpoint, x-goog-api-key header, responseSchema stripped of additionalProperties',
    fn: async ({ page }) => {
      await useGemini(page);
      const answer = { translations: [{ id: 'p1-0', ko: '서론' }] };
      const calls = await recordRoute(page, API, () => ({ json: candidate(JSON.stringify(answer)) }));
      const r = await page.evaluate(async (model) => {
        const { geminiProvider } = await import('/js/ai/gemini.js');
        const P = await import('/js/ai/prompts.js');
        return geminiProvider.complete({
          model, system: P.translationSystem({ meta: { title: 'T' } }, {}),
          messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'prev' }, { role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }] }],
          json: P.TRANSLATION_SCHEMA, maxTokens: 16000, effort: 'low',
        });
      }, MODEL);
      assert.equal(calls.length, 1);
      const c = calls[0];
      assert.equal(c.url, `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`);
      assert.ok(!c.url.includes('key='), 'key never in the URL');
      assert.equal(c.headers['x-goog-api-key'], KEY);
      const gc = c.body.generationConfig;
      assert.equal(gc.responseMimeType, 'application/json');
      assert.equal(gc.maxOutputTokens, 16000);
      assert.ok(!hasKeyDeep(gc.responseSchema, 'additionalProperties'));
      assert.equal(gc.responseSchema.type, 'OBJECT');
      assert.equal(gc.responseSchema.properties.translations.items.properties.ko.type, 'STRING');
      assert.deepEqual(gc.responseSchema.properties.translations.items.required, ['id', 'ko']);
      assert.deepEqual(gc.responseSchema.properties.translations.items.propertyOrdering, ['id', 'ko']);
      assert.ok(c.body.systemInstruction.parts[0].text.includes('# Fidelity'));
      assert.deepEqual(c.body.contents.map((x) => x.role), ['user', 'model', 'user']);
      assert.deepEqual(c.body.contents[2].parts[1], { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } });
      assert.deepEqual(r.json, answer); // thought parts ignored
      assert.deepEqual(r.usage, { model: MODEL, inputTokens: 500, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0 });
      return `POST ${new URL(c.url).pathname}; schema=${JSON.stringify(gc.responseSchema).slice(0, 120)}…; usage=${JSON.stringify(r.usage)}`;
    },
  },
  {
    name: 'stream(): streamGenerateContent?alt=sse chunks (CRLF framing) → text events + usage',
    fn: async ({ page }) => {
      await useGemini(page);
      const chunks = ['논문에 ', '따르면 ', '감소하였다.'];
      const body = sse(chunks.map((text, i) => [null, {
        candidates: [{ content: { role: 'model', parts: [{ text }] }, ...(i === chunks.length - 1 ? { finishReason: 'STOP' } : {}) }],
        ...(i === chunks.length - 1 ? { usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 30, totalTokenCount: 930 } } : {}),
      }]), { crlf: true });
      const calls = await recordRoute(page, API, () => ({ contentType: 'text/event-stream', body }));
      const r = await page.evaluate(async (model) => {
        const { geminiProvider } = await import('/js/ai/gemini.js');
        const out = [];
        for await (const ev of geminiProvider.stream({ model, system: [{ text: 'a' }, { text: 'b', cache: true }], messages: [{ role: 'user', content: 'Q' }], maxTokens: 32000 })) out.push(ev);
        return out;
      }, MODEL);
      assert.equal(calls[0].url, `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`);
      assert.equal(calls[0].body.systemInstruction.parts[0].text, 'a\n\nb');
      assert.ok(!('responseSchema' in calls[0].body.generationConfig));
      assert.deepEqual(r.filter((e) => e.type === 'text').map((e) => e.text), chunks);
      assert.deepEqual(r.at(-1), { type: 'done', usage: { model: MODEL, inputTokens: 900, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'end_turn' });
      return `${r.length - 1} text events + done(${JSON.stringify(r.at(-1).usage)})`;
    },
  },
  {
    name: 'listModels(): paginates GET /v1beta/models, keeps only generateContent models',
    fn: async ({ page }) => {
      await useGemini(page);
      const calls = await recordRoute(page, API, (c) => {
        const token = new URL(c.url).searchParams.get('pageToken');
        return token
          ? { json: { models: [{ name: 'models/gemini-b', displayName: 'Gemini B', supportedGenerationMethods: ['generateContent', 'countTokens'] }] } }
          : { json: { models: [
            { name: 'models/gemini-a', displayName: 'Gemini A', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/text-embedding', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
          ], nextPageToken: 'p2' } };
      });
      const models = await page.evaluate(async () => (await import('/js/ai/gemini.js')).geminiProvider.listModels());
      assert.equal(calls.length, 2);
      assert.ok(calls.every((c) => c.method === 'GET' && c.headers['x-goog-api-key'] === KEY && !c.url.includes('key=')));
      assert.deepEqual(models.map((m) => m.id), ['gemini-a', 'gemini-b']);
      return `2 pages → ${models.map((m) => m.label).join(', ')}`;
    },
  },
  {
    name: '429 → Korean free-tier daily-quota message; short RetryInfo delay is retried once',
    fn: async ({ page }) => {
      await useGemini(page);
      let mode = 'daily';
      const calls = await recordRoute(page, API, (c, n) => {
        if (mode === 'daily') return err(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded', [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }]);
        return n === 2 ? err(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded', [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.2s' }]) : { json: candidate('OK') };
      });
      const run = () => page.evaluate(async (model) => {
        const { geminiProvider } = await import('/js/ai/gemini.js');
        try {
          return { text: (await geminiProvider.complete({ model, messages: [{ role: 'user', content: 'Q' }] })).text };
        } catch (e) {
          return { code: e.code, message: e.message, fatal: e.fatal };
        }
      }, MODEL);
      const daily = await run();
      assert.equal(calls.length, 1, 'no retry when there is no RetryInfo (daily quota)');
      assert.equal(daily.code, 'quota');
      assert.match(daily.message, /무료/);
      assert.match(daily.message, /일일 할당량/);
      mode = 'minute';
      const minute = await run();
      assert.equal(calls.length, 3);
      assert.equal(minute.text, 'OK');
      return `daily → "${daily.message}"; per-minute (retryDelay 0.2s) → retried → "${minute.text}"`;
    },
  },
  {
    name: 'errors: API_KEY_INVALID → auth (testKey false), 404 → not_found, SAFETY → refusal, MAX_TOKENS on JSON, network',
    fn: async ({ page }) => {
      await useGemini(page);
      let mode = 'badkey';
      const handlers = {
        badkey: () => err(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }]),
        notfound: () => err(404, 'NOT_FOUND', 'models/x is not found'),
        safety: () => ({ json: candidate('', 'SAFETY') }),
        maxtokens: () => ({ json: candidate('{"translations":[{"id":"p1', 'MAX_TOKENS') }),
        network: () => ({ abort: 'internetdisconnected' }),
      };
      await recordRoute(page, API, () => handlers[mode]());
      const out = {};
      for (const m of Object.keys(handlers)) {
        mode = m;
        out[m] = await page.evaluate(async (model) => {
          const { geminiProvider } = await import('/js/ai/gemini.js');
          const P = await import('/js/ai/prompts.js');
          try {
            await geminiProvider.complete({ model, messages: [{ role: 'user', content: 'Q' }], json: P.TRANSLATION_SCHEMA });
            return null;
          } catch (e) {
            return { code: e.code, message: e.message };
          }
        }, MODEL);
      }
      mode = 'badkey';
      const test = await page.evaluate(async () => (await import('/js/ai/gemini.js')).geminiProvider.testKey());
      assert.deepEqual(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v?.code])),
        { badkey: 'auth', notfound: 'not_found', safety: 'refusal', maxtokens: 'max_tokens', network: 'network' });
      for (const v of Object.values(out)) assert.match(v.message, /[가-힣]/);
      assert.equal(test.ok, false);
      assert.match(test.message, /API 키/);
      return Object.entries(out).map(([k, v]) => `${k}→${v.code}`).join(', ') + `; testKey → ${test.message}`;
    },
  },
  {
    name: 'tasks.keyPoints via Gemini (routed): JSON items validated against the doc',
    fn: async ({ page }) => {
      await useGemini(page);
      const calls = await recordRoute(page, API, () => ({ json: candidate(JSON.stringify({ items: [
        { sid: 'p1-3', category: 'contribution' }, { sid: 'p9-99', category: 'result' }, { sid: 'p2-5', category: 'nonsense' },
        { sid: 'p2-4', category: 'method' }, { sid: 'p1-3', category: 'result' }, { sid: 'p1-0', category: 'result' },
      ] })) }));
      const r = await page.evaluate(async () => {
        const T = await import('/js/ai/tasks.js');
        const { buildSyntheticDoc } = await import('/tests/ai/synth.js');
        return T.keyPoints(buildSyntheticDoc({ pages: 4 }));
      });
      assert.ok(calls[0].body.generationConfig.responseSchema.properties.items.items.properties.category.enum.includes('limitation'));
      // p9-99 unknown, 'nonsense' category, duplicate p1-3 and furniture p1-0 are dropped
      assert.deepEqual(r.items, [{ sid: 'p1-3', category: 'contribution' }, { sid: 'p2-4', category: 'method' }]);
      return `kept ${JSON.stringify(r.items)}`;
    },
  },
];

const { failed } = await runSuite('gemini', tests);
process.exitCode = failed ? 1 : 0;
