// Pure-module tests (Node, no servers): price table parity with the app, KST calendar, codes, CORS matching,
// usage metering of chunked JSON/SSE bodies.
import assert from 'node:assert/strict';
import * as appConfig from '../../js/core/config.js';
import { costUsd as appCostUsd } from '../../js/ai/usage.js';
import { CACHE_READ_FACTOR, CACHE_WRITE_FACTOR, PRICES, costUsd } from '../src/pricing.js';
import { generateCode, normalizeCode, validateCodeInput } from '../src/codes.js';
import { isOriginAllowed } from '../src/http.js';
import { meterBody, usageParts } from '../src/meter.js';
import { kstDay, kstDaysBack, kstMonth, nextKstMidnight, requestNow } from '../src/time.js';
import { sseText, streamEvents } from './fake-upstream.mjs';

const ORIGINS = ['https://e2jinsoopark.github.io', 'http://localhost:*', 'http://127.0.0.1:*'];

/** Deterministic PRNG so a failure is reproducible. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Feed `bytes` through meterBody in chunks of the given sizes; returns { passed bytes, result }. */
async function meterChunks(bytes, contentType, sizes, requestedModel = 'claude-haiku-5-5') {
  let i = 0;
  let k = 0;
  const source = new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) return controller.close();
      const n = sizes[k++ % sizes.length];
      controller.enqueue(bytes.slice(i, i + n));
      i += n;
    },
  });
  const { body, finished } = meterBody(source, contentType, requestedModel);
  const passed = new Uint8Array(await new Response(body).arrayBuffer());
  return { passed, result: await finished };
}

export const tests = [
  {
    name: 'price table and cache factors are identical to js/core/config.js',
    fn: () => {
      assert.deepEqual(PRICES, appConfig.PRICES);
      assert.equal(CACHE_READ_FACTOR, appConfig.CACHE_READ_FACTOR);
      assert.equal(CACHE_WRITE_FACTOR, appConfig.CACHE_WRITE_FACTOR);
      return `${Object.keys(PRICES).length} models deep-equal; cacheRead ×${CACHE_READ_FACTOR}, cacheWrite ×${CACHE_WRITE_FACTOR}`;
    },
  },
  {
    name: 'costUsd matches the app\'s costUsd for 2000 random usages (incl. Haiku long-context, dated ids)',
    fn: () => {
      const rand = rng(42);
      const models = [...Object.keys(PRICES), 'claude-haiku-5-5-20261001', 'claude-opus-5-5@20261001'];
      let worst = 0;
      let longCases = 0;
      for (let n = 0; n < 2000; n++) {
        const u = {
          model: models[Math.floor(rand() * models.length)],
          inputTokens: Math.floor(rand() * 150_000),
          outputTokens: Math.floor(rand() * 32_000),
          cacheReadTokens: rand() < 0.5 ? 0 : Math.floor(rand() * 80_000),
          cacheWriteTokens: rand() < 0.5 ? 0 : Math.floor(rand() * 20_000),
        };
        if (u.model.startsWith('claude-haiku-5-5') && u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens > 100_000) longCases++;
        worst = Math.max(worst, Math.abs(costUsd(u) - appCostUsd(u)));
      }
      assert.ok(worst < 1e-12, `max |relay - app| = ${worst}`);
      assert.ok(longCases > 20, `long-context Haiku cases exercised: ${longCases}`);
      return `max |relay − app| = ${worst}; ${longCases} long-context Haiku cases`;
    },
  },
  {
    name: 'hand-computed prices: Haiku short/long, Sonnet/Opus cache reads, unknown model as Sonnet 5.5',
    fn: () => {
      const usd = (model, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) =>
        costUsd({ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
      // Haiku: 1000×0.10 + 500×0.50 + 2000×0.01 + 400×0.125 = 420 µ$
      assert.ok(Math.abs(usd('claude-haiku-5-5', 1000, 500, 2000, 400) - 0.00042) < 1e-12);
      // Haiku long (prompt 90K + 20K > 100K): 90000×0.5 + 1000×2.5 + 20000×0.05 = 48500 µ$
      assert.ok(Math.abs(usd('claude-haiku-5-5', 90_000, 1000, 20_000) - 0.0485) < 1e-12);
      // Sonnet: 120×2 + 42×10 + 3000×0.20 = 1260 µ$ ; Opus cache read 0.20
      assert.ok(Math.abs(usd('claude-sonnet-5-5', 120, 42, 3000) - 0.00126) < 1e-12);
      assert.ok(Math.abs(usd('claude-opus-5-5', 0, 0, 1_000_000) - 0.2) < 1e-12);
      assert.ok(Math.abs(usd('claude-opus-5', 300, 100) - 0.004) < 1e-12);
      assert.equal(usd('claude-future-9', 1000, 1000), usd('claude-sonnet-5-5', 1000, 1000));
      return 'Haiku 420µ$, Haiku-long 0.0485, Sonnet 0.00126, Opus cache read $0.20/M, unknown → Sonnet 5.5 rates';
    },
  },
  {
    name: 'KST calendar: day/month boundaries at 15:00Z, next midnight, day lists',
    fn: () => {
      const t = Date.parse('2026-10-18T14:59:59.999Z'); // 23:59:59.999 KST
      assert.equal(kstDay(t), '2026-10-18');
      assert.equal(kstDay(t + 1), '2026-10-19');
      assert.equal(kstMonth(Date.parse('2027-03-31T16:30:00Z')), '2027-04'); // 01:30 KST on Apr 1
      assert.equal(new Date(nextKstMidnight(t)).toISOString(), '2026-10-18T15:00:00.000Z');
      assert.equal(new Date(nextKstMidnight(t + 1)).toISOString(), '2026-10-19T15:00:00.000Z');
      assert.deepEqual(kstDaysBack(Date.parse('2026-03-01T03:00:00+09:00'), 3), ['2026-03-01', '2026-02-28', '2026-02-27']);
      return 'KST day flips at 15:00Z; 2027-03-31T16:30Z is April in KST; resetsAt = next 00:00 KST';
    },
  },
  {
    name: 'test clock header is honoured only in TEST_MODE',
    fn: () => {
      const req = new Request('http://x/', { headers: { 'x-relay-test-now': '2030-01-01T00:00:00+09:00' } });
      assert.equal(requestNow(req, true), Date.parse('2030-01-01T00:00:00+09:00'));
      assert.ok(Math.abs(requestNow(req, false) - Date.now()) < 1000);
      const ms = new Request('http://x/', { headers: { 'x-relay-test-now': '1700000000000' } });
      assert.equal(requestNow(ms, true), 1_700_000_000_000);
      return 'testMode=true → pinned; testMode=false → real clock';
    },
  },
  {
    name: 'invite codes: PR-XXXX-XXXX Crockford, crypto-random, typed variants normalise',
    fn: () => {
      const seen = new Set();
      const counts = {};
      for (let i = 0; i < 4000; i++) {
        const c = generateCode();
        assert.match(c, /^PR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
        seen.add(c);
        for (const ch of c.slice(3).replace('-', '')) counts[ch] = (counts[ch] || 0) + 1;
      }
      assert.equal(seen.size, 4000);
      assert.equal(Object.keys(counts).length, 32);
      const min = Math.min(...Object.values(counts));
      const max = Math.max(...Object.values(counts));
      assert.ok(min > 800 && max < 1200, `per-char counts ${min}..${max} (expected ≈1000)`);
      assert.equal(normalizeCode('pr-ab2c-d3ef'), 'PR-AB2C-D3EF');
      assert.equal(normalizeCode(' pr ab2c d3ef '), 'PR-AB2C-D3EF');
      assert.equal(normalizeCode('PRAB2CD3EF'), 'PR-AB2C-D3EF');
      assert.equal(normalizeCode('PR-OOIL-0011'), 'PR-0011-0011');
      assert.equal(normalizeCode('PR-ABCU-0000'), ''); // U is not Crockford
      assert.equal(normalizeCode('sk-ant-123'), '');
      assert.equal(normalizeCode(''), '');
      return `4000 unique codes, all 32 symbols used (${min}..${max} each); O/I/L read as 0/1/1`;
    },
  },
  {
    name: 'admin input validation: name 1–40 chars, limit 0–20, models ⊆ KNOWN_MODELS',
    fn: () => {
      const defaults = { allowedModels: ['claude-haiku-5-5'], dailyLimitUsd: 0.5 };
      const ok = validateCodeInput({ name: '  홍길동 ' }, { partial: false, defaults });
      assert.deepEqual(ok.value, { name: '홍길동', allowedModels: ['claude-haiku-5-5'], dailyLimitUsd: 0.5 });
      assert.ok(validateCodeInput({ name: '가'.repeat(40) }, { partial: false, defaults }).value);
      for (const bad of [{ name: '' }, { name: '가'.repeat(41) }, { name: 'a', dailyLimitUsd: 20.01 },
        { name: 'a', dailyLimitUsd: -1 }, { name: 'a', dailyLimitUsd: '1' }, { name: 'a', allowedModels: [] },
        { name: 'a', allowedModels: ['claude-opus-5'] }, { name: 'a', active: 'yes' }]) {
        assert.ok(validateCodeInput(bad, { partial: false, defaults }).error, JSON.stringify(bad));
      }
      assert.ok(validateCodeInput({}, { partial: true }).error);
      assert.deepEqual(validateCodeInput({ allowedModels: ['claude-sonnet-5-5', 'claude-haiku-5-5'] }, { partial: true }).value,
        { allowedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'] });
      return 'valid/invalid bodies classified; models re-ordered to KNOWN_MODELS order';
    },
  },
  {
    name: 'regression broken-invitee-name: a name with U+FFFD, a lone surrogate or a control character is refused in Korean (create and patch)',
    fn: () => {
      const defaults = { allowedModels: ['claude-haiku-5-5'], dailyLimitUsd: 0.5 };
      // What a CP949 "관리자 테스트" body looked like after a lenient UTF-8 decode (seen on the live relay).
      const mojibake = '\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD \uFFFD\uFFFD\uFFFD\u05BD\uFFFD\u01AE';
      const out = [];
      for (const name of [mojibake, '홍길동\uFFFD', '홍\uD800길동', '홍\uDC00', '홍길동\n관리자', 'a\u0000b']) {
        for (const partial of [false, true]) {
          const r = validateCodeInput({ name }, { partial, defaults });
          assert.ok(r.error, `accepted ${JSON.stringify(name)} (partial ${partial})`);
          assert.match(r.error, /[가-힣]/, 'Korean message');
          out.push(r.error);
        }
      }
      assert.match(out[0], /깨진 글자/);
      assert.match(out.at(-1), /제어 문자/);
      // Valid Korean, emoji (a proper surrogate pair) and punctuation stay accepted.
      for (const name of ['관리자 테스트', '박간호 😀', 'Kim (EICU2)']) {
        assert.equal(validateCodeInput({ name }, { partial: false, defaults }).value?.name, name, name);
      }
      return `${out.length} broken names refused, e.g. "${out[0]}"`;
    },
  },
  {
    name: 'CORS origin matching: exact entries and :* port patterns, no prefix tricks',
    fn: () => {
      for (const o of ['https://e2jinsoopark.github.io', 'http://localhost:5173', 'http://localhost', 'http://127.0.0.1:8103']) {
        assert.ok(isOriginAllowed(o, ORIGINS), o);
      }
      for (const o of ['https://e2jinsoopark.github.io.evil.com', 'http://e2jinsoopark.github.io', 'http://localhost.evil.com',
        'http://localhost:80.evil.com', 'http://localhost:', 'https://localhost:5173', 'null', '', 'http://127.0.0.2:8080']) {
        assert.ok(!isOriginAllowed(o, ORIGINS), o);
      }
      return '4 allowed, 9 look-alikes refused';
    },
  },
  {
    name: 'meter: SSE split at every chunk size (incl. mid-UTF-8) passes bytes through and reads final usage',
    fn: async () => {
      const text = sseText(streamEvents({ chunks: ['논문을 ', '요약하면', ' — 끝.'] }));
      const bytes = new TextEncoder().encode(text);
      for (const sizes of [[1], [2], [3], [7], [64], [5, 1, 13], [bytes.length]]) {
        const { passed, result } = await meterChunks(bytes, 'text/event-stream', sizes, 'claude-haiku-5-5');
        assert.deepEqual(passed, bytes, `bytes differ for chunk sizes ${sizes}`);
        assert.deepEqual(result.parts, [{ model: 'claude-sonnet-5-5', inputTokens: 120, outputTokens: 42, cacheReadTokens: 3000, cacheWriteTokens: 0 }]);
        assert.equal(result.complete, true);
      }
      return `${bytes.length} bytes identical for 7 chunkings; usage = message_start input/cache + message_delta output`;
    },
  },
  {
    name: 'meter: message_delta overrides input/cache counts when present; CRLF framing; JSON body',
    fn: async () => {
      const events = streamEvents({ deltaUsage: { input_tokens: 130, cache_read_input_tokens: 2900 } });
      const crlf = sseText(events).replace(/\n/g, '\r\n');
      const a = await meterChunks(new TextEncoder().encode(crlf), 'text/event-stream', [10]);
      assert.deepEqual(a.result.parts[0], { model: 'claude-sonnet-5-5', inputTokens: 130, outputTokens: 42, cacheReadTokens: 2900, cacheWriteTokens: 0 });
      const msg = JSON.stringify({ model: 'claude-opus-5-5', usage: { input_tokens: 7, output_tokens: 9, cache_creation_input_tokens: 11 } });
      const b = await meterChunks(new TextEncoder().encode(msg), 'application/json', [4]);
      assert.deepEqual(b.result.parts[0], { model: 'claude-opus-5-5', inputTokens: 7, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 11 });
      const c = await meterChunks(new TextEncoder().encode('{"type":"error"'), 'application/json', [4]);
      assert.equal(c.result, null);
      return 'delta overrides applied; CRLF parsed; JSON usage read; truncated JSON → null';
    },
  },
  {
    name: 'meter: a client that goes away mid-stream cancels the upstream and still yields the usage seen so far',
    fn: async () => {
      const texts = streamEvents({ model: 'claude-haiku-5-5', startUsage: { input_tokens: 500, cache_read_input_tokens: 0 } })
        .map((e) => new TextEncoder().encode(sseText([e])));
      let upstreamCancelled = false;
      let sent = 0;
      const source = new ReadableStream({
        pull(controller) {
          if (sent < 2) controller.enqueue(texts[sent++]);
          else return new Promise(() => {}); // upstream stalls: only the client can end this
        },
        cancel() { upstreamCancelled = true; },
      }, { highWaterMark: 0 });
      const { body, finished } = meterBody(source, 'text/event-stream', 'claude-haiku-5-5');
      const reader = body.getReader();
      await reader.read();
      await reader.cancel('client went away');
      const result = await finished;
      assert.equal(upstreamCancelled, true, 'upstream body not cancelled');
      assert.equal(result.complete, false);
      assert.deepEqual(result.parts, [{ model: 'claude-haiku-5-5', inputTokens: 500, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
      return 'cancel → upstream cancelled, complete=false, message_start usage (500 in / 1 out) kept';
    },
  },
  {
    name: 'usage.iterations (server-side fallback) become one part per attempt with its own model',
    fn: () => {
      const parts = usageParts('claude-opus-5', {
        input_tokens: 300, output_tokens: 100,
        iterations: [
          { type: 'message', model: 'claude-sonnet-5-5', input_tokens: 300, output_tokens: 0 },
          { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 300, output_tokens: 100 },
        ],
      });
      assert.deepEqual(parts.map((p) => [p.model, p.inputTokens, p.outputTokens]),
        [['claude-sonnet-5-5', 300, 0], ['claude-opus-5', 300, 100]]);
      assert.equal(usageParts('m', { input_tokens: 1, iterations: [{ model: 'x', input_tokens: 5 }] })[0].inputTokens, 1);
      return '2 iterations → 2 parts; a single iteration uses the top-level usage';
    },
  },
];
