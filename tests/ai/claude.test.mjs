// Claude provider, end to end in a real browser (Edge): the real SDK from jsDelivr talks to a Playwright-routed
// https://api.anthropic.com that records the exact requests and returns canned JSON / SSE. No paid calls.
import assert from 'node:assert/strict';
import { recordRoute, runSuite, sse } from './lib.mjs';
import { parseTranslationUserMessage, TRANSLATION_SCHEMA } from '../../js/ai/prompts.js';

const API = 'https://api.anthropic.com/**';
const KEY = 'sk-ant-test-0000';

const message = (over = {}) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
  content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...over,
});

const apiError = (status, type, msg) => ({ status, json: { type: 'error', error: { type, message: msg }, request_id: 'req_test' } });

function streamEvents({ model = 'claude-sonnet-5-5', chunks, stopReason = 'end_turn', stopDetails = null }) {
  return sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['ping', { type: 'ping' }],
    ...chunks.map((text) => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }]),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null, ...(stopDetails ? { stop_details: stopDetails } : {}) }, usage: { output_tokens: 42 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/** Select the Claude provider with a fake key (in this test's fresh browser context). */
async function useClaude(page, extra = {}) {
  await page.evaluate(async ({ key, extra }) => {
    const { settings } = await import('/js/core/settings.js');
    settings.set({ provider: 'claude', claude: { apiKey: key }, ...extra });
  }, { key: KEY, extra });
}

const tests = [
  {
    name: 'SDK 0.131.0 loads from jsDelivr: default export + typed error classes',
    fn: async ({ page }) => {
      const r = await page.evaluate(async () => {
        const { VENDOR } = await import('/js/core/config.js');
        const m = await import(VENDOR.anthropicSdk);
        const client = new m.default({ apiKey: 'x', dangerouslyAllowBrowser: true });
        const named = ['APIError', 'APIConnectionError', 'APIConnectionTimeoutError', 'APIUserAbortError', 'AuthenticationError',
          'PermissionDeniedError', 'NotFoundError', 'RateLimitError', 'BadRequestError', 'InternalServerError'];
        const statics = ['AuthenticationError', 'PermissionDeniedError', 'RateLimitError', 'APIConnectionError', 'InternalServerError', 'BadRequestError'];
        return {
          url: VENDOR.anthropicSdk,
          defaultType: typeof m.default,
          named: named.filter((n) => typeof m[n] === 'function'),
          staticsSame: statics.filter((n) => m.default[n] === m[n]),
          hasCreate: typeof client.messages.create, hasStream: typeof client.messages.stream,
          hasBeta: typeof client.beta.messages.create, hasModels: typeof client.models.list,
          connSubclassOfApiError: m.APIConnectionError.prototype instanceof m.APIError,
        };
      });
      assert.equal(r.defaultType, 'function');
      assert.equal(r.named.length, 10, `named exports: ${r.named}`);
      assert.equal(r.staticsSame.length, 6, `Anthropic.X === X for: ${r.staticsSame}`);
      assert.deepEqual([r.hasCreate, r.hasStream, r.hasBeta, r.hasModels], ['function', 'function', 'function', 'function']);
      return `${r.url} → default=${r.defaultType}, ${r.named.length} error classes, Anthropic.* statics ok, APIConnectionError⊂APIError=${r.connSubclassOfApiError}`;
    },
  },
  {
    name: 'complete() Haiku: exact body — model, output_config{effort,format}, cache_control on paper block, no thinking',
    fn: async ({ page }) => {
      await useClaude(page);
      const answer = { translations: [{ id: 'p1-0', ko: '서론' }] };
      const calls = await recordRoute(page, API, () => ({
        json: message({ content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 50, output_tokens: 30, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0 } }),
      }));
      const r = await page.evaluate(async () => {
        const { claudeProvider } = await import('/js/ai/claude.js');
        const P = await import('/js/ai/prompts.js');
        return claudeProvider.complete({
          model: 'claude-haiku-5-5', system: P.translationSystem({ meta: { title: 'T', abstract: 'A' } }, { glossary: [{ src: 'delirium', tgt: '섬망' }] }),
          messages: [{ role: 'user', content: P.translationUserMessage({ items: [{ sid: 'p1-0', kind: 'heading', text: 'Introduction' }] }) }],
          json: P.TRANSLATION_SCHEMA, maxTokens: 16000, effort: 'low',
        });
      });
      assert.equal(calls.length, 1);
      const c = calls[0];
      assert.equal(c.method, 'POST');
      assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
      assert.equal(c.headers['x-api-key'], KEY);
      assert.equal(c.headers['anthropic-version'], '2023-06-01');
      assert.equal(c.headers['anthropic-dangerous-direct-browser-access'], 'true');
      assert.equal(c.headers['anthropic-beta'], undefined);
      assert.equal(c.body.model, 'claude-haiku-5-5');
      assert.equal(c.body.max_tokens, 16000);
      assert.deepEqual(c.body.output_config, { effort: 'low', format: { type: 'json_schema', schema: TRANSLATION_SCHEMA } });
      for (const k of ['thinking', 'temperature', 'top_p', 'top_k', 'fallbacks', 'betas', 'stream']) assert.ok(!(k in c.body), `unexpected ${k}`);
      assert.equal(c.body.system.length, 2);
      assert.equal(c.body.system[0].type, 'text');
      assert.equal(c.body.system[0].cache_control, undefined);
      assert.deepEqual(c.body.system[1].cache_control, { type: 'ephemeral' });
      assert.match(c.body.system[1].text, /delirium → 섬망/);
      assert.match(c.body.messages[0].content, /<s id="p1-0" kind="heading">Introduction<\/s>/);
      assert.deepEqual(r.json, answer);
      assert.deepEqual(r.usage, { model: 'claude-haiku-5-5', inputTokens: 50, outputTokens: 30, cacheReadTokens: 1200, cacheWriteTokens: 0 });
      return `POST ${c.url}; output_config=${JSON.stringify({ effort: c.body.output_config.effort, format: c.body.output_config.format.type })}; system[1].cache_control=ephemeral; keys=${Object.keys(c.body).join(',')}`;
    },
  },
  {
    name: 'complete() Sonnet 5.5 / Opus 5.5: beta.messages + anthropic-beta server-side-fallback-2026-07-01 + fallbacks:"default"',
    fn: async ({ page }) => {
      await useClaude(page);
      const calls = await recordRoute(page, API, (c) => ({
        json: message({
          model: c.body.model,
          content: [{ type: 'fallback', from: { model: c.body.model }, to: { model: 'claude-sonnet-5' } }, { type: 'text', text: '요약입니다.' }],
          usage: {
            input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
            iterations: [
              { type: 'message', model: c.body.model, input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              { type: 'fallback_message', model: 'claude-sonnet-5', input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            ],
          },
        }),
      }));
      const r = await page.evaluate(async () => {
        const { claudeProvider } = await import('/js/ai/claude.js');
        const { costUsd } = await import('/js/ai/usage.js');
        const out = [];
        for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5']) {
          const res = await claudeProvider.complete({ model, system: 'S', messages: [{ role: 'user', content: 'Q' }], maxTokens: 16000, effort: 'medium' });
          out.push({ text: res.text, parts: res.usage.parts?.length, cost: costUsd(res.usage) });
        }
        return out;
      });
      assert.equal(calls.length, 2);
      for (const [i, model] of ['claude-sonnet-5-5', 'claude-opus-5-5'].entries()) {
        const c = calls[i];
        assert.equal(c.url, 'https://api.anthropic.com/v1/messages?beta=true');
        assert.ok(c.headers['anthropic-beta'].split(',').includes('server-side-fallback-2026-07-01'), c.headers['anthropic-beta']);
        assert.equal(c.body.model, model);
        assert.equal(c.body.fallbacks, 'default');
        assert.ok(!('betas' in c.body) && !('thinking' in c.body));
        assert.deepEqual(c.body.output_config, { effort: 'medium' });
        assert.deepEqual(c.body.system, [{ type: 'text', text: 'S' }]);
        assert.equal(r[i].text, '요약입니다.'); // fallback block skipped
        assert.equal(r[i].parts, 2); // per-attempt usage kept for pricing
      }
      return `beta header=${calls[0].headers['anthropic-beta']}; fallbacks=${calls[0].body.fallbacks}; usage.iterations→parts=2; cost sonnet=$${r[0].cost.toFixed(6)}`;
    },
  },
  {
    name: 'fallback beta rejected with 400 → same request retried once without it, then remembered',
    fn: async ({ page }) => {
      await useClaude(page);
      const calls = await recordRoute(page, API, (c) => (c.body.fallbacks
        ? apiError(400, 'invalid_request_error', 'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.')
        : { json: message({ model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '응답' }] }) }));
      const r = await page.evaluate(async () => {
        const C = await import('/js/ai/claude.js');
        const opts = { model: 'claude-sonnet-5-5', system: 'S', messages: [{ role: 'user', content: 'Q' }], maxTokens: 1000, effort: 'medium' };
        const a = await C.claudeProvider.complete(opts);
        const b = await C.claudeProvider.complete(opts);
        return { a: a.text, b: b.text, disabled: C.isFallbackBetaDisabled() };
      });
      assert.deepEqual(calls.map((c) => [c.url.endsWith('?beta=true'), Boolean(c.body.fallbacks)]), [[true, true], [false, false], [false, false]]);
      assert.deepEqual(r, { a: '응답', b: '응답', disabled: true });
      return `requests: beta(400) → plain(200) → plain(200); remembered=${r.disabled}`;
    },
  },
  {
    name: 'genuine 400 on Sonnet is not mistaken for a beta rejection (2 requests, bad_request, beta kept)',
    fn: async ({ page }) => {
      await useClaude(page);
      const calls = await recordRoute(page, API, () => apiError(400, 'invalid_request_error', 'prompt is too long: 1200000 tokens > 1000000 maximum'));
      const r = await page.evaluate(async () => {
        const C = await import('/js/ai/claude.js');
        try {
          await C.claudeProvider.complete({ model: 'claude-sonnet-5-5', system: 'S', messages: [{ role: 'user', content: 'Q' }], maxTokens: 1000 });
          return { ok: true };
        } catch (e) {
          return { code: e.code, message: e.message, fatal: e.fatal, disabled: C.isFallbackBetaDisabled() };
        }
      });
      assert.equal(calls.length, 2);
      assert.equal(r.code, 'bad_request');
      assert.equal(r.disabled, false);
      assert.match(r.message, /잘못된 요청.*prompt is too long/);
      return `${calls.length} requests; ${r.code}: ${r.message}`;
    },
  },
  {
    name: 'stream(): canned SSE (message_start…message_stop) → text deltas + final usage; request body',
    fn: async ({ page }) => {
      await useClaude(page);
      const chunks = ['논문에 따르면 ', '섬망 발생률이 ', '감소하였다 [p3-12].'];
      const calls = await recordRoute(page, API, () => ({ contentType: 'text/event-stream', body: streamEvents({ chunks }) }));
      const r = await page.evaluate(async () => {
        const { claudeProvider } = await import('/js/ai/claude.js');
        const events = [];
        for await (const ev of claudeProvider.stream({
          model: 'claude-sonnet-5-5', system: [{ text: 'rules' }, { text: '<paper>…</paper>', cache: true }],
          messages: [{ role: 'user', content: '결과는?' }], maxTokens: 32000, effort: 'medium',
        })) events.push(ev);
        return events;
      });
      const c = calls[0];
      assert.equal(calls.length, 1);
      assert.equal(c.url, 'https://api.anthropic.com/v1/messages'); // streams use plain messages.stream (no fallback beta)
      assert.equal(c.body.stream, true);
      assert.equal(c.body.max_tokens, 32000);
      assert.deepEqual(c.body.output_config, { effort: 'medium' });
      assert.ok(!('thinking' in c.body));
      assert.deepEqual(c.body.system[1], { type: 'text', text: '<paper>…</paper>', cache_control: { type: 'ephemeral' } });
      const texts = r.filter((e) => e.type === 'text').map((e) => e.text);
      assert.deepEqual(texts, chunks);
      const done = r.at(-1);
      assert.equal(done.type, 'done');
      assert.equal(done.stopReason, 'end_turn');
      assert.deepEqual(done.usage, { model: 'claude-sonnet-5-5', inputTokens: 120, outputTokens: 42, cacheReadTokens: 3000, cacheWriteTokens: 0 });
      return `${texts.length} text events "${texts.join('')}" + done usage ${JSON.stringify(done.usage)}`;
    },
  },
  {
    name: 'stream(): refusal after partial output → Korean refusal error (partial text already yielded)',
    fn: async ({ page }) => {
      await useClaude(page);
      await recordRoute(page, API, () => ({
        contentType: 'text/event-stream',
        body: streamEvents({ chunks: ['부분 '], stopReason: 'refusal', stopDetails: { type: 'refusal', category: 'cyber', explanation: 'x' } }),
      }));
      const r = await page.evaluate(async () => {
        const { claudeProvider } = await import('/js/ai/claude.js');
        const texts = [];
        try {
          for await (const ev of claudeProvider.stream({ model: 'claude-sonnet-5-5', system: 'S', messages: [{ role: 'user', content: 'Q' }], maxTokens: 1000 })) {
            if (ev.type === 'text') texts.push(ev.text);
          }
          return { texts, error: null };
        } catch (e) {
          return { texts, error: { code: e.code, message: e.message, category: e.category } };
        }
      });
      assert.deepEqual(r.texts, ['부분 ']);
      assert.equal(r.error?.code, 'refusal');
      assert.equal(r.error.category, 'cyber');
      assert.match(r.error.message, /거절/);
      return `partial=${JSON.stringify(r.texts)} then ${r.error.code}(${r.error.category}): ${r.error.message}`;
    },
  },
  {
    name: 'complete(): stop_reason refusal → one request, no retry; max_tokens on JSON → max_tokens error',
    fn: async ({ page }) => {
      await useClaude(page);
      let mode = 'refusal';
      const calls = await recordRoute(page, API, () => ({
        json: mode === 'refusal'
          ? message({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } })
          : message({ content: [{ type: 'text', text: '{"translations":[{"id":"p1-0","ko":"잘' }], stop_reason: 'max_tokens' }),
      }));
      const run = () => page.evaluate(async () => {
        const { claudeProvider } = await import('/js/ai/claude.js');
        const P = await import('/js/ai/prompts.js');
        try {
          await claudeProvider.complete({ model: 'claude-haiku-5-5', system: 'S', messages: [{ role: 'user', content: 'Q' }], json: P.TRANSLATION_SCHEMA, maxTokens: 100 });
          return null;
        } catch (e) {
          return { code: e.code, message: e.message, hasUsage: Boolean(e.usage) };
        }
      });
      const refusal = await run();
      assert.equal(calls.length, 1);
      mode = 'max';
      const max = await run();
      assert.equal(calls.length, 2);
      assert.equal(refusal.code, 'refusal');
      assert.equal(max.code, 'max_tokens');
      assert.ok(refusal.hasUsage && max.hasUsage, 'errors carry usage so the cost is still recorded');
      return `refusal → "${refusal.message}" (1 request); max_tokens → "${max.message}"`;
    },
  },
  {
    name: 'typed SDK errors → Korean messages (401, 403, 404, 429×retries, 529, 500, 400, 402, network)',
    fn: async ({ page }) => {
      await useClaude(page);
      let mode = null;
      const handlers = {
        401: () => apiError(401, 'authentication_error', 'invalid x-api-key'),
        403: () => apiError(403, 'permission_error', 'not allowed'),
        404: () => apiError(404, 'not_found_error', 'model: claude-haiku-5-5'),
        429: () => ({ ...apiError(429, 'rate_limit_error', 'rate limited'), headers: { 'retry-after-ms': '5' } }),
        529: () => ({ ...apiError(529, 'overloaded_error', 'overloaded'), headers: { 'retry-after-ms': '5' } }),
        500: () => ({ ...apiError(500, 'api_error', 'internal'), headers: { 'x-should-retry': 'false' } }),
        400: () => apiError(400, 'invalid_request_error', 'messages: field required'),
        402: () => apiError(402, 'billing_error', 'credit balance too low'),
        network: () => ({ abort: 'failed' }),
      };
      const calls = await recordRoute(page, API, () => handlers[mode]());
      const out = {};
      for (const m of Object.keys(handlers)) {
        mode = m;
        const before = calls.length;
        const err = await page.evaluate(async () => {
          const { claudeProvider } = await import('/js/ai/claude.js');
          try {
            await claudeProvider.complete({ model: 'claude-haiku-5-5', system: 'S', messages: [{ role: 'user', content: 'Q' }], maxTokens: 100 });
            return null;
          } catch (e) {
            return { code: e.code, fatal: e.fatal, message: e.message };
          }
        });
        out[m] = { ...err, requests: calls.length - before };
      }
      const expect = { 401: 'auth', 403: 'permission', 404: 'not_found', 429: 'rate_limit', 529: 'server', 500: 'server', 400: 'bad_request', 402: 'billing', network: 'network' };
      for (const [m, code] of Object.entries(expect)) {
        assert.equal(out[m]?.code, code, `${m}: ${JSON.stringify(out[m])}`);
        assert.match(out[m].message, /[가-힣]/, `${m} message is Korean`);
      }
      assert.equal(out[429].requests, 4, 'maxRetries 3 → 4 attempts on 429');
      assert.equal(out[529].requests, 4);
      assert.equal(out[500].requests, 1, 'x-should-retry:false honoured');
      assert.equal(out.network.requests, 4);
      assert.equal(out[401].fatal, true);
      assert.equal(out[429].fatal, false);
      assert.match(out[529].message, /과부하/);
      return Object.entries(out).map(([m, e]) => `${m}→${e.code}×${e.requests}`).join(', ');
    },
  },
  {
    name: 'AbortSignal cancels an in-flight complete() and stream() → code aborted (fast)',
    fn: async ({ page }) => {
      await useClaude(page);
      await recordRoute(page, API, () => ({ delayMs: 3000, json: message() }));
      const r = await page.evaluate(async () => {
        const { claudeProvider } = await import('/js/ai/claude.js');
        const opts = { model: 'claude-haiku-5-5', system: 'S', messages: [{ role: 'user', content: 'Q' }], maxTokens: 100 };
        const attempt = async (fn) => {
          const ac = new AbortController();
          const t0 = performance.now();
          setTimeout(() => ac.abort(), 150);
          try {
            await fn(ac.signal);
            return null;
          } catch (e) {
            return { code: e.code, name: e.name, ms: performance.now() - t0 };
          }
        };
        return {
          complete: await attempt((signal) => claudeProvider.complete({ ...opts, signal })),
          stream: await attempt(async (signal) => { for await (const _ of claudeProvider.stream({ ...opts, signal })) { /* drain */ } }),
        };
      });
      for (const k of ['complete', 'stream']) {
        assert.equal(r[k]?.code, 'aborted', k);
        assert.equal(r[k].name, 'AbortError');
        assert.ok(r[k].ms < 2000, `${k} took ${r[k].ms}`);
      }
      return `complete aborted after ${Math.round(r.complete.ms)} ms, stream after ${Math.round(r.stream.ms)} ms`;
    },
  },
  {
    name: 'testKey() / listModels() use GET /v1/models; missing key fails locally without a request',
    fn: async ({ page }) => {
      let status = 200;
      const calls = await recordRoute(page, API, () => (status === 200
        ? { json: { data: [{ type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }, { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }], has_more: false, first_id: 'a', last_id: 'b' } }
        : apiError(401, 'authentication_error', 'invalid x-api-key')));
      const noKey = await page.evaluate(async () => {
        const { claudeProvider } = await import('/js/ai/claude.js');
        return claudeProvider.testKey();
      });
      assert.equal(calls.length, 0);
      assert.equal(noKey.ok, false);
      await useClaude(page);
      const r = await page.evaluate(async () => {
        const { claudeProvider } = await import('/js/ai/claude.js');
        return { test: await claudeProvider.testKey(), models: await claudeProvider.listModels() };
      });
      status = 401;
      const bad = await page.evaluate(async () => (await import('/js/ai/claude.js')).claudeProvider.testKey());
      assert.ok(calls.every((c) => c.method === 'GET' && new URL(c.url).pathname === '/v1/models'));
      assert.equal(new URL(calls[0].url).searchParams.get('limit'), '1');
      assert.equal(r.test.ok, true);
      assert.deepEqual(r.models.map((m) => m.id), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
      assert.equal(r.models[0].label, 'Claude Haiku 5.5 (빠름·저렴)'); // known label from config
      assert.equal(bad.ok, false);
      assert.match(bad.message, /API 키/);
      return `no key → "${noKey.message}"; ok → "${r.test.message}"; 401 → "${bad.message}"; models=${r.models.length}`;
    },
  },
  {
    name: 'Translator → Claude (routed): batches parsed from real request bodies, translations applied',
    fn: async ({ page }) => {
      await useClaude(page);
      const calls = await recordRoute(page, API, (c) => {
        const { items } = parseTranslationUserMessage(c.body.messages[0].content);
        const translations = items.map((it) => ({ id: it.sid, ko: `번역: ${it.text.slice(0, 20)}` }));
        return { json: message({ content: [{ type: 'text', text: JSON.stringify({ translations }) }], usage: { input_tokens: 400, output_tokens: 300, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 } }) };
      });
      const r = await page.evaluate(async () => {
        const { Translator } = await import('/js/ai/translator.js');
        const { buildSyntheticDoc } = await import('/tests/ai/synth.js');
        const doc = buildSyntheticDoc({ pages: 4 });
        const t = new Translator({ doc });
        const p = await t.translateAll();
        return { p, sample: t.translations.get('p1-1') };
      });
      assert.ok(calls.length >= 2);
      for (const c of calls) {
        assert.equal(c.body.model, 'claude-haiku-5-5');
        assert.deepEqual(c.body.output_config.format, { type: 'json_schema', schema: TRANSLATION_SCHEMA });
        assert.equal(c.body.output_config.effort, 'low');
        assert.deepEqual(c.body.system[1].cache_control, { type: 'ephemeral' });
        assert.ok(!('thinking' in c.body));
      }
      assert.equal(r.p.done, r.p.total);
      assert.ok(r.p.costUsd > 0);
      return `${calls.length} requests, ${r.p.done}/${r.p.total} translated, cost $${r.p.costUsd.toFixed(5)}, sample "${r.sample}"`;
    },
  },
  {
    name: 'tasks via Claude (routed): summarize → Sonnet beta call with cached paper; chat → SSE stream',
    fn: async ({ page }) => {
      await useClaude(page);
      const calls = await recordRoute(page, API, (c) => (c.body.stream
        ? { contentType: 'text/event-stream', body: streamEvents({ chunks: ['답변 ', '[p1-1]'] }) }
        : { json: message({ model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '## 한 줄 요약\n요약 [p1-1]' }] }) }));
      const r = await page.evaluate(async () => {
        const T = await import('/js/ai/tasks.js');
        const { buildSyntheticDoc } = await import('/tests/ai/synth.js');
        const doc = buildSyntheticDoc({ pages: 4 });
        const s = await T.summarize(doc, { paperId: 'paper1' });
        const chunks = [];
        let last = null;
        for await (const x of T.chat(doc, [{ role: 'user', content: '이전 질문' }, { role: 'assistant', content: '이전 답' }], '결과는?', { quote: 'the quote' })) {
          if (typeof x === 'string') chunks.push(x); else last = x;
        }
        return { s, chunks, last };
      });
      const [sum, chat] = calls;
      assert.ok(sum.url.endsWith('/v1/messages?beta=true'));
      assert.equal(sum.body.model, 'claude-sonnet-5-5');
      assert.equal(sum.body.output_config.effort, 'medium');
      assert.match(sum.body.system[1].text, /^<paper title="Effects of a Synthetic/);
      assert.deepEqual(sum.body.system[1].cache_control, { type: 'ephemeral' });
      assert.ok(!sum.body.system[1].text.includes('Journal of Synthetic Nursing Research'), 'furniture excluded');
      assert.equal(chat.body.stream, true);
      assert.deepEqual(chat.body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
      assert.match(chat.body.messages[2].content, /<quote>\nthe quote\n<\/quote>/);
      assert.equal(chat.body.system[1].text, sum.body.system[1].text, 'same cached prefix for summary and chat');
      assert.equal(r.s.markdown, '## 한 줄 요약\n요약 [p1-1]');
      assert.deepEqual(r.chunks, ['답변 ', '[p1-1]']);
      assert.equal(r.last.done, true);
      return `summary via ${sum.url}; chat roles ${chat.body.messages.map((m) => m.role).join('/')}; shared cached paper prefix (${sum.body.system[1].text.length} chars)`;
    },
  },
];

const { failed } = await runSuite('claude', tests);
process.exitCode = failed ? 1 : 0;
