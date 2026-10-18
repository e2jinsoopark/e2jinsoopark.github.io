// HTTP tests against `wrangler dev` (local D1) + the fake Anthropic upstream. Each budget test pins its own KST
// day with the x-relay-test-now header (TEST_MODE=1), so tests do not share "today".
import assert from 'node:assert/strict';
import {
  ADMIN_TOKEN, call, close, GLOBAL_LIMIT_USD, newCode, REAL_KEY, sendMessage, sleep, usageFor, waitFor,
  waitForRequests, WORKER,
} from './lib.mjs';
import { jsonReply, message, sseReply, sseText, streamEvents } from './fake-upstream.mjs';

const GOOD_ORIGINS = ['https://e2jinsoopark.github.io', 'http://localhost:5173', 'http://127.0.0.1:9999', 'http://localhost'];
const BAD_ORIGINS = ['https://evil.example', 'http://localhost.evil.com', 'https://e2jinsoopark.github.io.evil.com', 'null'];
const BAD_CODE_MESSAGE = '초대 코드가 올바르지 않거나 사용이 중지되었습니다.';
const EXPOSED = ['request-id', 'x-relay-today-usd', 'x-relay-limit-usd', 'x-should-retry'];

/** Anthropic error shape with the given status/type; returns the message. */
function assertError(res, status, type) {
  assert.equal(res.status, status, `status ${res.status}: ${res.text}`);
  assert.equal(res.json?.type, 'error', res.text);
  assert.equal(res.json.error?.type, type, res.text);
  assert.equal(typeof res.json.error.message, 'string');
  return res.json.error.message;
}

/** Requests the fake upstream received since `mark` (an index into fake.requests). */
const since = (fake, mark) => fake.requests.slice(mark);

export const tests = [
  {
    name: 'CORS: allowed origins are echoed with Vary: Origin and the exposed headers',
    fn: async () => {
      const { code } = await newCode();
      for (const origin of GOOD_ORIGINS) {
        const res = await call('/relay/me', { code, origin });
        assert.equal(res.status, 200, `${origin}: ${res.text}`);
        assert.equal(res.headers.get('access-control-allow-origin'), origin);
        assert.match(res.headers.get('vary') || '', /Origin/);
        const exposed = (res.headers.get('access-control-expose-headers') || '').split(/,\s*/);
        for (const h of EXPOSED) assert.ok(exposed.includes(h), `${h} not exposed: ${exposed}`);
      }
      const plain = await call('/relay/me', { code });
      assert.equal(plain.status, 200);
      assert.equal(plain.headers.get('access-control-allow-origin'), null);
      assert.match(plain.headers.get('vary') || '', /Origin/);
      return `${GOOD_ORIGINS.join(', ')} echoed; no-Origin (curl) → 200 without ACAO; exposed: ${EXPOSED.join(', ')}`;
    },
  },
  {
    name: 'CORS: other origins get no CORS headers (403), preflight included',
    fn: async ({ fake }) => {
      const { code } = await newCode();
      const mark = fake.requests.length;
      for (const origin of BAD_ORIGINS) {
        const res = await sendMessage({ code, headers: { origin } });
        assertError(res, 403, 'permission_error');
        assert.equal(res.headers.get('access-control-allow-origin'), null, origin);
        const pre = await call('/v1/messages', {
          method: 'OPTIONS', origin,
          headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-api-key' },
        });
        assert.equal(pre.headers.get('access-control-allow-origin'), null, `preflight ${origin}`);
        assert.equal(pre.headers.get('access-control-allow-headers'), null);
      }
      assert.equal(since(fake, mark).length, 0, 'upstream must not be called');
      return `${BAD_ORIGINS.join(', ')} → 403 / preflight without ACAO; upstream untouched`;
    },
  },
  {
    name: 'CORS preflight: 204, echoes Access-Control-Request-Headers, methods, max-age 86400, Vary',
    fn: async () => {
      const requested = 'anthropic-beta,anthropic-dangerous-direct-browser-access,anthropic-version,content-type,'
        + 'x-api-key,x-stainless-arch,x-stainless-lang,x-stainless-retry-count,x-stainless-timeout';
      const res = await call('/v1/messages?beta=true', {
        method: 'OPTIONS', origin: 'http://localhost:5173',
        headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': requested },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      assert.equal(res.headers.get('access-control-allow-headers'), requested);
      assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, PATCH, OPTIONS');
      assert.equal(res.headers.get('access-control-max-age'), '86400');
      assert.match(res.headers.get('vary') || '', /Origin/);
      return `204; allow-headers = "${requested}"`;
    },
  },
  {
    name: 'auth: missing, unknown and malformed codes → 401 authentication_error, x-should-retry: false',
    fn: async ({ fake }) => {
      const mark = fake.requests.length;
      const none = await sendMessage({});
      assert.match(assertError(none, 401, 'authentication_error'), /초대 코드가 없습니다/);
      for (const code of ['PR-0000-0000', 'garbage', 'sk-ant-api03-abc']) {
        const res = await sendMessage({ code });
        assert.equal(assertError(res, 401, 'authentication_error'), BAD_CODE_MESSAGE);
        assert.equal(res.headers.get('x-should-retry'), 'false');
        assert.ok(res.headers.get('request-id')?.startsWith('relay_'));
      }
      const me = await call('/relay/me', { code: 'PR-0000-0000' });
      assertError(me, 401, 'authentication_error');
      const models = await call('/v1/models', { code: 'PR-0000-0000' });
      assertError(models, 401, 'authentication_error');
      assert.equal(since(fake, mark).length, 0);
      return `401 "${BAD_CODE_MESSAGE}" on /v1/messages, /relay/me, /v1/models; upstream untouched`;
    },
  },
  {
    name: 'auth: Bearer code works; typed variants (lowercase, spaces, O/I/L) normalise',
    fn: async () => {
      const { code } = await newCode({ name: '정규화' });
      const bearer = await call('/relay/me', { headers: { authorization: `Bearer ${code}` } });
      assert.equal(bearer.status, 200, bearer.text);
      assert.equal(bearer.json.name, '정규화');
      const typed = ` ${code.toLowerCase().replace(/-/g, ' ')} `.replace(/0/g, 'o').replace(/1/g, 'l');
      const res = await call('/relay/me', { code: typed });
      assert.equal(res.status, 200, `${typed}: ${res.text}`);
      return `Bearer ${code} ok; "${typed}" accepted`;
    },
  },
  {
    name: 'auth: a disabled code is refused (401) until re-enabled',
    fn: async ({ fake }) => {
      const { code } = await newCode({ name: '중지' });
      const off = await call(`/relay/admin/codes/${code}`, { method: 'PATCH', admin: true, body: { active: false } });
      assert.equal(off.status, 200, off.text);
      assert.equal(off.json.active, false);
      const mark = fake.requests.length;
      assert.equal(assertError(await sendMessage({ code }), 401, 'authentication_error'), BAD_CODE_MESSAGE);
      assertError(await call('/relay/me', { code }), 401, 'authentication_error');
      assert.equal(since(fake, mark).length, 0);
      await call(`/relay/admin/codes/${code}`, { method: 'PATCH', admin: true, body: { active: true } });
      const on = await sendMessage({ code });
      assert.equal(on.status, 200, on.text);
      return 'active:false → 401 on messages and /relay/me; active:true → 200';
    },
  },
  {
    name: 'model not in allowedModels → 403 permission_error naming the model',
    fn: async ({ fake }) => {
      const { code } = await newCode();
      const mark = fake.requests.length;
      const res = await sendMessage({ code, params: { model: 'claude-sonnet-5-5' } });
      assert.equal(assertError(res, 403, 'permission_error'), '이 초대 코드로는 claude-sonnet-5-5을 쓸 수 없습니다.');
      assert.equal(res.headers.get('x-should-retry'), 'false');
      const unknown = await sendMessage({ code, params: { model: 'claude-opus-4-8' } });
      assertError(unknown, 403, 'permission_error');
      assert.equal(since(fake, mark).length, 0);
      return `"${res.json.error.message}"; upstream untouched`;
    },
  },
  {
    name: 'max_tokens cap: 32000 is forwarded, 32001 → 400 invalid_request_error',
    fn: async ({ fake }) => {
      const { code } = await newCode();
      const mark = fake.requests.length;
      const over = await sendMessage({ code, params: { max_tokens: 32001 } });
      assert.match(assertError(over, 400, 'invalid_request_error'), /32000 이하/);
      assert.equal(since(fake, mark).length, 0);
      const at = await sendMessage({ code, params: { max_tokens: 32000 } });
      assert.equal(at.status, 200, at.text);
      assert.equal(since(fake, mark).length, 1);
      assert.equal(since(fake, mark)[0].body.max_tokens, 32000);
      return `32001 → "${over.json.error.message}"; 32000 → forwarded`;
    },
  },
  {
    name: 'bad bodies: non-JSON / missing fields → 400, body over 6 MB → 413 request_too_large',
    fn: async ({ fake }) => {
      const { code } = await newCode();
      const mark = fake.requests.length;
      assertError(await call('/v1/messages', { method: 'POST', code, body: '{not json', headers: { 'content-type': 'application/json' } }),
        400, 'invalid_request_error');
      for (const body of [{}, { model: 'claude-haiku-5-5', messages: [] }, { model: 'claude-haiku-5-5', max_tokens: 1.5, messages: [] },
        { model: 'claude-haiku-5-5', max_tokens: 10, messages: 'hi' }]) {
        assertError(await call('/v1/messages', { method: 'POST', code, body }), 400, 'invalid_request_error');
      }
      const filler = 'a'.repeat(6 * 1024 * 1024);
      const big = await call('/v1/messages', {
        method: 'POST', code, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: filler }] }),
      });
      assert.match(assertError(big, 413, 'request_too_large'), /6MB/);
      assert.equal(since(fake, mark).length, 0);
      return 'non-JSON, 4 malformed bodies → 400; 6 MB+ → 413; upstream untouched';
    },
  },
  {
    name: 'features billed beyond tokens are refused (fallbacks list, server tools, fast mode, MCP); fallbacks:"default" and custom tools pass',
    fn: async ({ fake }) => {
      const { code } = await newCode({ allowedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'] });
      const mark = fake.requests.length;
      const refused = [
        { model: 'claude-sonnet-5-5', fallbacks: [{ model: 'claude-opus-4-8' }] },
        { tools: [{ type: 'web_search_20260209', name: 'web_search' }] },
        { model: 'claude-sonnet-5-5', speed: 'fast' },
        { mcp_servers: [{ type: 'url', url: 'https://example.com/mcp', name: 'x' }] },
      ];
      for (const params of refused) {
        assert.match(assertError(await sendMessage({ code, params }), 403, 'permission_error'), /다음 기능을 쓸 수 없습니다/);
      }
      assert.equal(since(fake, mark).length, 0);
      const ok1 = await sendMessage({ code, query: '?beta=true', params: { model: 'claude-sonnet-5-5', fallbacks: 'default' } });
      const ok2 = await sendMessage({ code, params: { tools: [{ name: 'lookup', description: 'd', input_schema: { type: 'object' } }] } });
      assert.equal(ok1.status, 200, ok1.text);
      assert.equal(ok2.status, 200, ok2.text);
      assert.equal(since(fake, mark).length, 2);
      return `${refused.length} refused with 403; fallbacks:"default" and a custom tool forwarded`;
    },
  },
  {
    name: 'non-stream: body passes byte-for-byte with status/request-id; usage recorded exactly (D1 via admin usage)',
    fn: async ({ fake }) => {
      const now = '2026-11-10T09:00:00+09:00';
      const { code } = await newCode({ name: '바이트' }, now);
      // Odd spacing, key order and non-ASCII on purpose: any re-serialisation would change these bytes.
      const canned = `{"id":"msg_1" , "type":"message","role":"assistant","model":"claude-haiku-5-5",\n`
        + `"content":[{"type":"text","text":"요약: 섬망 \\u0041 ✓"}],"stop_reason":"end_turn","stop_sequence":null,`
        + `"usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":2000,"cache_creation_input_tokens":400}}\n`;
      fake.reply(jsonReply(canned, { headers: { 'request-id': 'req_fake_1' } }));
      const res = await sendMessage({ code, now });
      assert.equal(res.status, 200);
      assert.equal(res.text, canned);
      assert.equal(res.headers.get('request-id'), 'req_fake_1');
      assert.equal(res.headers.get('content-type'), 'application/json');
      assert.equal(res.headers.get('anthropic-organization-id'), null, 'owner org id must not leak');
      assert.equal(res.headers.get('x-relay-today-usd'), '0');
      assert.equal(res.headers.get('x-relay-limit-usd'), '0.5');
      const day = await waitForRequests(code, 1, { now });
      const m = day.byModel['claude-haiku-5-5'];
      assert.deepEqual([m.requests, m.inputTokens, m.outputTokens, m.cacheReadTokens, m.cacheWriteTokens], [1, 1000, 500, 2000, 400]);
      assert.ok(close(day.usd, 0.00042), `usd ${day.usd}`);
      const me = await call('/relay/me', { code, now });
      assert.ok(close(me.json.todayUsd, 0.00042));
      assert.equal(me.json.todayRequests, 1);
      const list = await call('/relay/admin/codes', { admin: true, now });
      const rec = list.json.codes.find((c) => c.code === code);
      assert.ok(rec.lastUsedAt, 'lastUsedAt stamped');
      assert.ok(close(rec.todayUsd, 0.00042) && close(rec.totalUsd, 0.00042) && rec.totalRequests === 1);
      return `${Buffer.byteLength(canned)} bytes identical; recorded 1000/500/2000/400 tokens = $${day.usd}; me.todayUsd=${me.json.todayUsd}`;
    },
  },
  {
    name: 'upstream gets the real key and anthropic-version/-beta only: never the code, cookies or the browser-access header',
    fn: async ({ fake }) => {
      const { code } = await newCode();
      const mark = fake.requests.length;
      const body = JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 16, messages: [{ role: 'user', content: '헤더' }] });
      const res = await call('/v1/messages?beta=true', {
        method: 'POST', body, origin: 'http://localhost:5173',
        headers: {
          'x-api-key': code, authorization: `Bearer ${code}`, cookie: 'session=abc',
          'anthropic-dangerous-direct-browser-access': 'true', 'anthropic-version': '2023-06-01',
          'anthropic-beta': 'server-side-fallback-2026-07-01,other-beta', 'x-stainless-os': 'Windows',
          'content-type': 'application/json', 'x-relay-test-now': '2026-10-18T10:00:00+09:00',
        },
      });
      assert.equal(res.status, 200, res.text);
      const [up] = since(fake, mark);
      assert.equal(up.url, '/v1/messages?beta=true');
      assert.equal(up.headers['x-api-key'], REAL_KEY);
      assert.equal(up.headers['anthropic-version'], '2023-06-01');
      assert.equal(up.headers['anthropic-beta'], 'server-side-fallback-2026-07-01,other-beta');
      assert.match(up.headers['content-type'], /^application\/json/);
      for (const h of ['authorization', 'cookie', 'anthropic-dangerous-direct-browser-access', 'x-stainless-os', 'origin', 'x-relay-test-now']) {
        assert.equal(up.headers[h], undefined, `${h} forwarded`);
      }
      const leaked = Object.entries(up.headers).filter(([, v]) => String(v).includes(code));
      assert.deepEqual(leaked, [], 'invite code reached upstream');
      assert.equal(up.raw, body, 'request body changed');
      await call('/v1/messages', { method: 'POST', code, body });
      assert.equal(since(fake, mark)[1].headers['anthropic-version'], '2023-06-01', 'default version');
      assert.equal(since(fake, mark)[1].url, '/v1/messages');
      return `upstream headers: ${Object.keys(up.headers).sort().join(', ')}`;
    },
  },
  {
    name: 'stream: SSE arrives incrementally (first event before upstream finishes), bytes identical, usage from start+delta',
    fn: async ({ fake }) => {
      const now = '2026-11-11T09:00:00+09:00';
      const { code } = await newCode({ allowedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'] }, now);
      const events = streamEvents({ model: 'claude-sonnet-5-5', chunks: ['첫 ', '번째 ', '조각'] });
      const full = sseText(events);
      let release;
      const gate = new Promise((r) => { release = r; });
      const safety = setTimeout(() => release(), 6000);
      let upstreamEnded = 0;
      fake.reply(sseReply(events, { holdAfter: 3, until: gate, onEnd: (t) => { upstreamEnded = t; } }));
      const started = Date.now();
      const res = await fetch(`${WORKER}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': code, 'content-type': 'application/json', 'x-relay-test-now': now },
        body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('event: message_start')) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      const firstAt = Date.now();
      assert.ok(text.includes('event: message_start'), 'no message_start before the upstream was released');
      assert.equal(upstreamEnded, 0, 'upstream had already finished: the relay buffered the stream');
      assert.ok(firstAt - started < 3000, `first event took ${firstAt - started} ms`);
      release();
      clearTimeout(safety);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      assert.equal(text, full, 'stream bytes changed');
      const day = await waitForRequests(code, 1, { now });
      const m = day.byModel['claude-sonnet-5-5'];
      assert.deepEqual([m.inputTokens, m.outputTokens, m.cacheReadTokens, m.cacheWriteTokens], [120, 42, 3000, 0]);
      assert.ok(close(day.usd, 0.00126), `usd ${day.usd}`);
      return `first event after ${firstAt - started} ms while upstream held; ${Buffer.byteLength(full)} bytes identical; `
        + `recorded 120 in / 42 out / 3000 cache-read = $${day.usd}`;
    },
  },
  {
    name: 'stream cut off by the client: usage is still recorded (partial if the upstream is dropped, full if it finishes)',
    fn: async ({ fake }) => {
      const now = '2026-11-12T09:00:00+09:00';
      const { code } = await newCode({}, now);
      const events = streamEvents({ model: 'claude-haiku-5-5', startUsage: { input_tokens: 500, cache_read_input_tokens: 0 } });
      let abortedAt = 0;
      let droppedAfterMs = null; // set when the relay closed the upstream connection before the fake let go
      let released = false;
      let hold;
      const gate = new Promise((r) => { hold = r; });
      const safety = setTimeout(() => { released = true; hold(); }, 4000);
      fake.reply(sseReply(events, {
        holdAfter: 2, until: gate,
        onClose: (t) => { if (!released) droppedAfterMs = t - abortedAt; },
      }));
      const controller = new AbortController();
      const res = await fetch(`${WORKER}/v1/messages`, {
        method: 'POST', signal: controller.signal,
        headers: { 'x-api-key': code, 'content-type': 'application/json', 'x-relay-test-now': now },
        body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      });
      await res.body.getReader().read();
      abortedAt = Date.now();
      controller.abort();
      const day = await waitForRequests(code, 1, { now, timeout: 12_000 }).finally(() => { clearTimeout(safety); hold(); });
      const m = day.byModel['claude-haiku-5-5'];
      assert.equal(m.inputTokens, 500);
      // Dropped upstream: only message_start was seen (output 1). Upstream ran to the end: its final count (42).
      assert.equal(m.outputTokens, droppedAfterMs === null ? 42 : 1);
      return droppedAfterMs === null
        ? 'wrangler dev did not propagate the client abort; the upstream finished and its full usage (500 in / 42 out) was recorded'
        : `relay dropped the upstream ${droppedAfterMs} ms after the abort; partial usage (500 in / 1 out) recorded`;
    },
  },
  {
    name: 'upstream errors (529, 400) pass through unchanged and count as a request with no tokens',
    fn: async ({ fake }) => {
      const now = '2026-11-13T09:00:00+09:00';
      const { code } = await newCode({}, now);
      const overloaded = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_x"}';
      fake.reply(jsonReply(overloaded, { status: 529, headers: { 'x-should-retry': 'true', 'retry-after': '3' } }));
      const a = await sendMessage({ code, now });
      assert.equal(a.status, 529);
      assert.equal(a.text, overloaded);
      assert.equal(a.headers.get('x-should-retry'), 'true');
      assert.equal(a.headers.get('retry-after'), '3');
      const bad = '{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}';
      fake.reply(jsonReply(bad, { status: 400 }));
      const b = await sendMessage({ code, now });
      assert.equal(b.status, 400);
      assert.equal(b.text, bad);
      const day = await waitForRequests(code, 2, { now });
      const m = day.byModel['claude-haiku-5-5'];
      assert.deepEqual([m.requests, m.inputTokens, m.outputTokens, m.usd], [2, 0, 0, 0]);
      return '529 + retry headers and 400 passed through; usage = 2 requests, 0 tokens, $0';
    },
  },
  {
    name: 'server-side fallback: usage.iterations are priced per attempt on their own models',
    fn: async ({ fake }) => {
      const now = '2026-11-14T09:00:00+09:00';
      const { code } = await newCode({ allowedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'] }, now);
      fake.reply(jsonReply(JSON.stringify(message({
        model: 'claude-opus-5',
        usage: {
          input_tokens: 300, output_tokens: 100,
          iterations: [
            { type: 'message', model: 'claude-sonnet-5-5', input_tokens: 300, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 300, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          ],
        },
      }))));
      const res = await sendMessage({ code, now, query: '?beta=true', params: { model: 'claude-sonnet-5-5', fallbacks: 'default' } });
      assert.equal(res.status, 200, res.text);
      const day = await waitForRequests(code, 1, { now });
      assert.equal(day.requests, 1);
      assert.deepEqual(Object.keys(day.byModel).sort(), ['claude-opus-5', 'claude-sonnet-5-5']);
      assert.ok(close(day.byModel['claude-sonnet-5-5'].usd, 0.0006));
      assert.ok(close(day.byModel['claude-opus-5'].usd, 0.004));
      assert.ok(close(day.usd, 0.0046));
      return `1 request; sonnet-5-5 $${day.byModel['claude-sonnet-5-5'].usd} + opus-5 $${day.byModel['claude-opus-5'].usd} = $${day.usd}`;
    },
  },
  {
    name: 'per-code budget: spent → 429 rate_limit_error, x-should-retry false, Korean message; next KST day reopens',
    fn: async ({ fake }) => {
      const late = '2026-11-02T23:59:00+09:00';
      const nextDay = '2026-11-03T00:00:05+09:00';
      const { code } = await newCode({ dailyLimitUsd: 0.01 }, late);
      fake.reply(jsonReply(JSON.stringify(message({ usage: { input_tokens: 0, output_tokens: 30_000 } }))));
      const first = await sendMessage({ code, now: late });
      assert.equal(first.status, 200, first.text);
      await waitForRequests(code, 1, { now: late });
      const mark = fake.requests.length;
      const denied = await sendMessage({ code, now: late });
      const msg = assertError(denied, 429, 'rate_limit_error');
      assert.equal(msg, '오늘 사용 한도($0.01)를 모두 썼습니다. 내일 오전 0시(한국 시간)에 다시 열립니다.');
      assert.equal(denied.headers.get('x-should-retry'), 'false');
      assert.equal(denied.headers.get('x-relay-today-usd'), '0.015');
      assert.equal(denied.headers.get('x-relay-limit-usd'), '0.01');
      assert.equal(since(fake, mark).length, 0, 'denied request reached upstream');
      const me = await call('/relay/me', { code, now: late });
      assert.ok(close(me.json.todayUsd, 0.015));
      assert.equal(me.json.resetsAt, '2026-11-02T15:00:00.000Z');
      const reopened = await sendMessage({ code, now: nextDay });
      assert.equal(reopened.status, 200, reopened.text);
      assert.equal(reopened.headers.get('x-relay-today-usd'), '0');
      return `"${msg}" at 23:59 KST; 200 again at 00:00:05 KST (resetsAt ${me.json.resetsAt})`;
    },
  },
  {
    name: 'global daily budget across all codes → 429 for every code until the next KST day',
    fn: async ({ fake }) => {
      const day = '2030-01-05T12:00:00+09:00';
      const nextDay = '2030-01-06T00:00:01+09:00';
      const big = await newCode({ name: '큰손', allowedModels: ['claude-opus-5-5'], dailyLimitUsd: 20 }, day);
      const small = await newCode({ name: '작은손' }, day);
      fake.reply(jsonReply(JSON.stringify(message({ model: 'claude-opus-5-5', usage: { input_tokens: 0, output_tokens: 60_000 } }))));
      const spend = await sendMessage({ code: big.code, now: day, params: { model: 'claude-opus-5-5' } });
      assert.equal(spend.status, 200, spend.text);
      await waitForRequests(big.code, 1, { now: day });
      const denied = await sendMessage({ code: small.code, now: day });
      const msg = assertError(denied, 429, 'rate_limit_error');
      assert.equal(msg, `중계 서버의 오늘 전체 사용 한도($${GLOBAL_LIMIT_USD.toFixed(2)})를 모두 썼습니다. 내일 오전 0시(한국 시간)에 다시 열립니다.`);
      assert.equal(denied.headers.get('x-should-retry'), 'false');
      const list = await call('/relay/admin/codes', { admin: true, now: day });
      assert.ok(close(list.json.todayTotalUsd, 1.2), `todayTotalUsd ${list.json.todayTotalUsd}`);
      assert.equal(list.json.globalDailyLimitUsd, GLOBAL_LIMIT_USD);
      const reopened = await sendMessage({ code: small.code, now: nextDay });
      assert.equal(reopened.status, 200, reopened.text);
      return `$1.2 spent by one code → other code gets "${msg}"; next day 200`;
    },
  },
  {
    name: 'admin auth: missing / wrong token / an invite code as Bearer → 401',
    fn: async () => {
      const { code } = await newCode();
      for (const admin of [undefined, 'wrong-token-wrong-token', ADMIN_TOKEN.slice(0, -1), code]) {
        for (const [method, path] of [['GET', '/relay/admin/codes'], ['POST', '/relay/admin/codes'], ['GET', '/relay/admin/usage'],
          ['PATCH', `/relay/admin/codes/${code}`]]) {
          const res = await call(path, { method, admin, body: method === 'GET' ? undefined : { name: 'x' } });
          assertError(res, 401, 'authentication_error');
        }
      }
      const viaKey = await call('/relay/admin/codes', { headers: { 'x-api-key': ADMIN_TOKEN } });
      assertError(viaKey, 401, 'authentication_error');
      return '16 admin calls with missing/wrong/near-miss/invite tokens → 401; x-api-key is not admin auth';
    },
  },
  {
    name: 'admin create: defaults, PR-XXXX-XXXX, validation errors',
    fn: async () => {
      const now = '2026-10-18T10:00:00+09:00';
      const res = await call('/relay/admin/codes', { method: 'POST', admin: true, now, body: { name: '홍길동' } });
      assert.equal(res.status, 201, res.text);
      const rec = res.json;
      assert.match(rec.code, /^PR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      assert.deepEqual({ ...rec, code: 'X' }, {
        code: 'X', name: '홍길동', active: true, allowedModels: ['claude-haiku-5-5'], dailyLimitUsd: 0.5,
        createdAt: new Date(Date.parse(now)).toISOString(), lastUsedAt: null, todayUsd: 0, monthUsd: 0, totalUsd: 0, totalRequests: 0,
      });
      const two = await call('/relay/admin/codes', {
        method: 'POST', admin: true, body: { name: '박간호', allowedModels: ['claude-sonnet-5-5', 'claude-haiku-5-5'], dailyLimitUsd: 2 },
      });
      assert.deepEqual([two.json.allowedModels, two.json.dailyLimitUsd], [['claude-haiku-5-5', 'claude-sonnet-5-5'], 2]);
      const bad = [{ name: '' }, { name: 'x'.repeat(41) }, { name: 'a', dailyLimitUsd: 21 }, { name: 'a', dailyLimitUsd: -0.1 },
        { name: 'a', allowedModels: ['gpt-5'] }, { name: 'a', allowedModels: [] }, []];
      for (const body of bad) assertError(await call('/relay/admin/codes', { method: 'POST', admin: true, body }), 400, 'invalid_request_error');
      assertError(await call('/relay/admin/codes', { method: 'POST', admin: true, body: '{', headers: { 'content-type': 'application/json' } }),
        400, 'invalid_request_error');
      return `created ${rec.code} with defaults (Haiku, $0.5); ${bad.length + 1} invalid bodies → 400`;
    },
  },
  {
    name: 'admin list + patch: fields, today/month/total sums by KST calendar, 404 for unknown codes',
    fn: async ({ fake }) => {
      const prevMonth = '2027-03-31T16:30:00Z'; // 01:30 KST on 2027-04-01
      const utcPrev = '2027-03-31T14:30:00Z'; // 23:30 KST on 2027-03-31
      const mid = '2027-04-15T09:00:00+09:00';
      const { code } = await newCode({ name: '집계' }, utcPrev);
      const spend = async (now, out) => {
        fake.reply(jsonReply(JSON.stringify(message({ usage: { input_tokens: 0, output_tokens: out } }))));
        assert.equal((await sendMessage({ code, now })).status, 200);
      };
      await spend(utcPrev, 2000); // March: $0.001
      await waitForRequests(code, 1, { now: utcPrev });
      await spend(prevMonth, 4000); // April 1 (KST): $0.002
      await waitForRequests(code, 1, { now: prevMonth });
      await spend(mid, 8000); // April 15: $0.004
      await waitForRequests(code, 1, { now: mid });
      const list = await call('/relay/admin/codes', { admin: true, now: mid });
      assert.equal(list.status, 200);
      const rec = list.json.codes.find((c) => c.code === code);
      assert.ok(close(rec.todayUsd, 0.004) && close(rec.monthUsd, 0.006) && close(rec.totalUsd, 0.007), JSON.stringify(rec));
      assert.equal(rec.totalRequests, 3);
      assert.ok(list.json.monthTotalUsd >= 0.006 && list.json.todayTotalUsd >= 0.004);
      for (const k of ['code', 'name', 'active', 'allowedModels', 'dailyLimitUsd', 'createdAt', 'lastUsedAt', 'todayUsd', 'monthUsd', 'totalUsd', 'totalRequests']) {
        assert.ok(k in rec, k);
      }
      const patched = await call(`/relay/admin/codes/${code.toLowerCase()}`, {
        method: 'PATCH', admin: true, now: mid, body: { name: '집계(수정)', dailyLimitUsd: 1.5, allowedModels: ['claude-opus-5-5', 'claude-haiku-5-5'] },
      });
      assert.equal(patched.status, 200, patched.text);
      assert.deepEqual([patched.json.name, patched.json.dailyLimitUsd, patched.json.allowedModels, patched.json.code],
        ['집계(수정)', 1.5, ['claude-haiku-5-5', 'claude-opus-5-5'], code]);
      assert.ok(close(patched.json.monthUsd, 0.006));
      assertError(await call(`/relay/admin/codes/${code}`, { method: 'PATCH', admin: true, body: {} }), 400, 'invalid_request_error');
      assertError(await call(`/relay/admin/codes/${code}`, { method: 'PATCH', admin: true, body: { active: 'no' } }), 400, 'invalid_request_error');
      assertError(await call('/relay/admin/codes/PR-ZZZZ-ZZZZ', { method: 'PATCH', admin: true, body: { name: 'x' } }), 404, 'not_found_error');
      assertError(await call('/relay/admin/codes/nonsense', { method: 'PATCH', admin: true, body: { name: 'x' } }), 404, 'not_found_error');
      assertError(await call('/relay/admin/codes/PR-%E0%A4%A', { method: 'PATCH', admin: true, body: { name: 'x' } }), 404, 'not_found_error');
      return `today $${rec.todayUsd}, month $${rec.monthUsd} (Apr 1 01:30 KST counted in April), total $${rec.totalUsd}; patch ok; 404s`;
    },
  },
  {
    name: 'regression broken-invitee-name: a CP949 body or a U+FFFD name → 400 in Korean on create and patch; the stored name is unchanged',
    fn: async () => {
      // "테스트" in CP949 / EUC-KR, as a Korean Windows console sends it: not valid UTF-8.
      const cp949 = Uint8Array.from([0xC5, 0xD7, 0xBD, 0xBA, 0xC6, 0xAE]);
      assert.equal(new TextDecoder('euc-kr').decode(cp949), '테스트', 'fixture bytes are CP949 "테스트"');
      const enc = new TextEncoder();
      const body = (nameBytes) => Uint8Array.from([...enc.encode('{"name":"'), ...nameBytes, ...enc.encode('"}')]);
      const headers = { 'content-type': 'application/json' };
      const created = await call('/relay/admin/codes', { method: 'POST', admin: true, headers, body: body(cp949) });
      const m1 = assertError(created, 400, 'invalid_request_error');
      assert.match(m1, /UTF-8/);
      assert.match(m1, /[가-힣]/);
      const fffd = await call('/relay/admin/codes', { method: 'POST', admin: true, body: { name: '\uFFFD\uFFFD \uFFFD\u05BD\uFFFD\u01AE' } });
      const m2 = assertError(fffd, 400, 'invalid_request_error');
      assert.match(m2, /깨진 글자/);
      const { code } = await newCode({ name: '정상 이름' });
      const p1 = await call(`/relay/admin/codes/${code}`, { method: 'PATCH', admin: true, headers, body: body(cp949) });
      assert.match(assertError(p1, 400, 'invalid_request_error'), /UTF-8/);
      const p2 = await call(`/relay/admin/codes/${code}`, { method: 'PATCH', admin: true, body: { name: '홍길동\uFFFD' } });
      assert.match(assertError(p2, 400, 'invalid_request_error'), /깨진 글자/);
      const list = await call('/relay/admin/codes', { admin: true });
      assert.equal(list.json.codes.find((c) => c.code === code).name, '정상 이름', 'refused patches change nothing');
      const me = await call('/relay/me', { code });
      assert.ok(!JSON.stringify(me.json).includes('\uFFFD'), me.text);
      const fixed = await call(`/relay/admin/codes/${code}`, { method: 'PATCH', admin: true, body: { name: '관리자 테스트' } });
      assert.equal(fixed.status, 200, fixed.text);
      assert.equal(fixed.json.name, '관리자 테스트');
      return `create CP949 → "${m1}"; U+FFFD name → "${m2}"; patch refused the same way; a UTF-8 patch repairs the name`;
    },
  },
  {
    name: 'admin usage report: N consecutive KST days newest first, zeros included, byModel tokens',
    fn: async ({ fake }) => {
      const now = '2026-12-03T10:00:00+09:00';
      const { code } = await newCode({}, '2026-12-01T10:00:00+09:00');
      fake.reply(jsonReply(JSON.stringify(message({ usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } }))));
      await sendMessage({ code, now: '2026-12-01T10:00:00+09:00' });
      await waitForRequests(code, 1, { now: '2026-12-01T10:00:00+09:00' });
      const { days } = await usageFor(code, { now, days: 4 });
      assert.deepEqual(days.map((d) => d.day), ['2026-12-03', '2026-12-02', '2026-12-01', '2026-11-30']);
      assert.deepEqual(days.map((d) => d.requests), [0, 0, 1, 0]);
      assert.deepEqual(days[0], { day: '2026-12-03', usd: 0, requests: 0, byModel: {} });
      const m = days[2].byModel['claude-haiku-5-5'];
      assert.deepEqual(m, { usd: m.usd, requests: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 });
      const all = await call('/relay/admin/usage', { admin: true, now });
      assert.equal(all.json.days.length, 30);
      assertError(await call('/relay/admin/usage?code=bad', { admin: true }), 400, 'invalid_request_error');
      return `days=4 → ${days.map((d) => `${d.day}:${d.requests}`).join(' ')}; default window 30 days`;
    },
  },
  {
    name: '/v1/models lists only the code\'s models in the Models API page shape (limit, after_id)',
    fn: async () => {
      const one = await newCode();
      const two = await newCode({ allowedModels: ['claude-sonnet-5-5', 'claude-haiku-5-5'] });
      const a = await call('/v1/models', { code: one.code });
      assert.equal(a.status, 200);
      assert.deepEqual(a.json, {
        data: [{ type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: a.json.data[0].created_at }],
        has_more: false, first_id: 'claude-haiku-5-5', last_id: 'claude-haiku-5-5',
      });
      assert.ok(!Number.isNaN(Date.parse(a.json.data[0].created_at)));
      const b = await call('/v1/models?limit=100', { code: two.code });
      assert.deepEqual(b.json.data.map((m) => m.id), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
      const page1 = await call('/v1/models?limit=1', { code: two.code });
      assert.deepEqual([page1.json.data.map((m) => m.id), page1.json.has_more], [['claude-haiku-5-5'], true]);
      const page2 = await call('/v1/models?limit=1&after_id=claude-haiku-5-5', { code: two.code });
      assert.deepEqual([page2.json.data.map((m) => m.id), page2.json.has_more], [['claude-sonnet-5-5'], false]);
      return 'Haiku-only → [haiku]; Haiku+Sonnet → 2 models; limit=1 → has_more, after_id → second page';
    },
  },
  {
    name: '/relay/me: name, models, limit, today spend/requests, resetsAt = next 00:00 KST',
    fn: async () => {
      const { code } = await newCode({ name: '홍길동', allowedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'], dailyLimitUsd: 0.75 });
      const cases = [
        ['2026-10-18T10:00:00+09:00', '2026-10-18T15:00:00.000Z'],
        ['2026-10-18T23:59:59.999+09:00', '2026-10-18T15:00:00.000Z'],
        ['2026-10-19T00:00:00+09:00', '2026-10-19T15:00:00.000Z'],
      ];
      for (const [now, resetsAt] of cases) {
        const res = await call('/relay/me', { code, now });
        assert.equal(res.status, 200, res.text);
        assert.deepEqual(res.json, {
          name: '홍길동', allowedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'], dailyLimitUsd: 0.75,
          todayUsd: 0, todayRequests: 0, resetsAt,
        });
        assert.equal(res.headers.get('x-relay-limit-usd'), '0.75');
      }
      return `resetsAt ${cases.map((c) => c[1]).join(' / ')}`;
    },
  },
  {
    name: 'unknown routes → 404, wrong methods → 405, all in Anthropic error shape',
    fn: async () => {
      assertError(await call('/v1/complete', { method: 'POST' }), 404, 'not_found_error');
      assertError(await call('/relay/admin/nope', { admin: true }), 404, 'not_found_error');
      assertError(await call('/v1/messages'), 405, 'invalid_request_error');
      assertError(await call('/relay/admin/codes', { method: 'PATCH', admin: true, body: {} }), 405, 'invalid_request_error');
      const root = await call('/');
      assert.deepEqual(root.json, { service: 'paper-relay', ok: true });
      await sleep(0);
      return '404/405 shapes ok; GET / health check';
    },
  },
];
