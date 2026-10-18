// The real Anthropic SDK (0.131.0 from jsDelivr, as the app loads it) in Edge, on a localhost page, talking to the
// relay with baseURL + apiKey = invite code. The relay forwards to the fake upstream.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { newCode, PAGE_PORT, REAL_KEY, WORKER } from './lib.mjs';
import { jsonReply, message, sseReply, streamEvents } from './fake-upstream.mjs';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm';
const PAGE = `http://localhost:${PAGE_PORT}/`;

/** Static page server (the page origin must differ from the Worker's, like the real app). */
function startPageServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>relay sdk test</title><body>relay sdk test</body>');
  });
  return new Promise((resolve) => server.listen(PAGE_PORT, '127.0.0.1', () => resolve(server)));
}

export async function setup() {
  const server = await startPageServer();
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  const posts = [];
  page.on('request', (r) => {
    if (r.url().startsWith(`${WORKER}/v1/messages`) && r.method() === 'POST') posts.push({ url: r.url(), headers: r.headers() });
  });
  await page.goto(PAGE);
  await page.evaluate(async (url) => { window.sdk = await import(url); }, SDK_URL);
  return { server, browser, page, posts };
}

export async function teardown({ server, browser }) {
  await browser?.close();
  await new Promise((r) => server?.close(r) ?? r());
}

/** Run `fn(client, sdk, args)` in the page with a fresh client for `code`. */
function inPage(page, code, fn, args = {}, { maxRetries = 0 } = {}) {
  return page.evaluate(async ({ code, base, src, args, maxRetries }) => {
    const sdk = window.sdk;
    const client = new sdk.default({ apiKey: code, baseURL: base, dangerouslyAllowBrowser: true, maxRetries });
    return new Function('client', 'sdk', 'args', `return (${src})(client, sdk, args);`)(client, sdk, args);
  }, { code, base: WORKER, src: fn.toString(), args, maxRetries });
}

/** Headers the upstream must never see, and must see. */
function assertCleanUpstream(call, code) {
  assert.equal(call.headers['x-api-key'], REAL_KEY);
  assert.equal(call.headers['anthropic-dangerous-direct-browser-access'], undefined);
  assert.deepEqual(Object.keys(call.headers).filter((h) => h.startsWith('x-stainless')), []);
  assert.deepEqual(Object.entries(call.headers).filter(([, v]) => String(v).includes(code)), []);
}

export const tests = [
  {
    name: 'SDK messages.create via the relay (browser sends code + browser-access header; upstream gets neither)',
    fn: async ({ page, fake, posts }) => {
      const { code } = await newCode({ name: 'SDK' });
      fake.reply(jsonReply(JSON.stringify(message({ text: '중계 OK', usage: { input_tokens: 11, output_tokens: 3 } }))));
      const mark = fake.requests.length;
      const postMark = posts.length;
      const r = await inPage(page, code, async (client) => {
        const msg = await client.messages.create({ model: 'claude-haiku-5-5', max_tokens: 64, messages: [{ role: 'user', content: '안녕' }] });
        return { text: msg.content[0].text, model: msg.model, usage: msg.usage };
      });
      assert.equal(r.text, '중계 OK');
      assert.equal(r.usage.input_tokens, 11);
      const sent = posts[postMark].headers;
      assert.equal(sent['x-api-key'], code);
      assert.equal(sent['anthropic-dangerous-direct-browser-access'], 'true');
      const up = fake.requests[mark];
      assert.equal(up.url, '/v1/messages');
      assertCleanUpstream(up, code);
      assert.equal(up.headers['anthropic-version'], '2023-06-01');
      return `text "${r.text}"; browser → relay had x-api-key=code + browser-access; relay → upstream: ${Object.keys(up.headers).sort().join(', ')}`;
    },
  },
  {
    name: 'SDK messages.stream via the relay: text deltas and finalMessage usage',
    fn: async ({ page, fake }) => {
      const { code } = await newCode({ allowedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'] });
      fake.reply(sseReply(streamEvents({ model: 'claude-sonnet-5-5', chunks: ['스트리밍 ', '중계 ', '성공'] })));
      const mark = fake.requests.length;
      const r = await inPage(page, code, async (client) => {
        const stream = client.messages.stream({ model: 'claude-sonnet-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
        const deltas = [];
        stream.on('text', (t) => deltas.push(t));
        const final = await stream.finalMessage();
        return { deltas, usage: final.usage, stop: final.stop_reason };
      });
      assert.deepEqual(r.deltas, ['스트리밍 ', '중계 ', '성공']);
      assert.equal(r.usage.output_tokens, 42);
      assert.equal(r.usage.cache_read_input_tokens, 3000);
      assert.equal(fake.requests[mark].body.stream, true);
      assertCleanUpstream(fake.requests[mark], code);
      return `deltas ${JSON.stringify(r.deltas)}, final usage out=${r.usage.output_tokens} cacheRead=${r.usage.cache_read_input_tokens}, stop=${r.stop}`;
    },
  },
  {
    name: 'SDK beta.messages.create with betas + fallbacks:"default" → ?beta=true and anthropic-beta reach upstream',
    fn: async ({ page, fake }) => {
      const { code } = await newCode({ allowedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'] });
      fake.reply(jsonReply(JSON.stringify(message({ model: 'claude-sonnet-5-5', text: '베타 OK' }))));
      const mark = fake.requests.length;
      const r = await inPage(page, code, async (client) => {
        const msg = await client.beta.messages.create({
          model: 'claude-sonnet-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
          betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        });
        return { text: msg.content[0].text };
      });
      const up = fake.requests[mark];
      assert.equal(r.text, '베타 OK');
      assert.equal(up.url, '/v1/messages?beta=true');
      assert.equal(up.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
      assert.equal(up.body.fallbacks, 'default');
      assert.equal(up.body.betas, undefined);
      assertCleanUpstream(up, code);
      return `upstream url ${up.url}, anthropic-beta ${up.headers['anthropic-beta']}, fallbacks ${up.body.fallbacks}`;
    },
  },
  {
    name: 'SDK models.list: auto-pagination over the code\'s models, first page with limit 1',
    fn: async ({ page }) => {
      const { code } = await newCode({ allowedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'] });
      const r = await inPage(page, code, async (client) => {
        const ids = [];
        for await (const m of client.models.list({ limit: 1 })) ids.push(m.id);
        const first = await client.models.list({ limit: 1 });
        return { ids, firstPage: first.data.map((m) => m.id), hasNext: first.hasNextPage(), names: (await client.models.list()).data.map((m) => m.display_name) };
      });
      assert.deepEqual(r.ids, ['claude-haiku-5-5', 'claude-sonnet-5-5']);
      assert.deepEqual(r.firstPage, ['claude-haiku-5-5']);
      assert.equal(r.hasNext, true);
      assert.deepEqual(r.names, ['Claude Haiku 5.5', 'Claude Sonnet 5.5']);
      return `auto-paginated ${r.ids.join(', ')} (limit 1 → hasNextPage ${r.hasNext})`;
    },
  },
  {
    name: 'SDK: a budget 429 is NOT retried (x-should-retry: false is visible cross-origin); an upstream 429 is',
    fn: async ({ page, fake, posts }) => {
      const { code } = await newCode({ dailyLimitUsd: 0 });
      let postMark = posts.length;
      const denied = await inPage(page, code, async (client, sdk) => {
        const t0 = performance.now();
        try {
          await client.messages.create({ model: 'claude-haiku-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
          return { ok: true };
        } catch (err) {
          return {
            cls: err.constructor.name, isRateLimit: err instanceof sdk.RateLimitError, status: err.status,
            shouldRetry: err.headers?.get?.('x-should-retry') ?? null, message: err.error?.error?.message, ms: performance.now() - t0,
          };
        }
      }, {}, { maxRetries: 3 });
      const deniedPosts = posts.length - postMark;
      assert.equal(denied.isRateLimit, true, JSON.stringify(denied));
      assert.equal(denied.status, 429);
      assert.equal(denied.shouldRetry, 'false');
      assert.match(denied.message, /^오늘 사용 한도\(\$0\.00\)를 모두 썼습니다/);
      assert.equal(deniedPosts, 1, `SDK sent ${deniedPosts} requests`);

      // Contrast: Anthropic's own 429 (no x-should-retry: false) is retried by the same SDK settings.
      const { code: other } = await newCode();
      const limited = '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}';
      for (let i = 0; i < 3; i++) fake.reply(jsonReply(limited, { status: 429, headers: { 'retry-after-ms': '20' } }));
      postMark = posts.length;
      const retried = await inPage(page, other, async (client) => {
        try {
          await client.messages.create({ model: 'claude-haiku-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
          return { ok: true };
        } catch (err) {
          return { status: err.status };
        }
      }, {}, { maxRetries: 2 });
      const retriedPosts = posts.length - postMark;
      assert.equal(retried.status, 429);
      assert.equal(retriedPosts, 3, `upstream 429 sent ${retriedPosts} requests`);
      return `budget 429 → ${denied.cls}, 1 request in ${Math.round(denied.ms)} ms, x-should-retry=${denied.shouldRetry}, "${denied.message}"; `
        + `upstream 429 → ${retriedPosts} requests (retried)`;
    },
  },
  {
    name: 'SDK maps relay denials to typed errors with the Korean messages (401, 403)',
    fn: async ({ page }) => {
      const { code } = await newCode();
      const run = (c, model) => inPage(page, c, async (client, sdk, { model }) => {
        try {
          await client.messages.create({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
          return { ok: true };
        } catch (err) {
          return { auth: err instanceof sdk.AuthenticationError, perm: err instanceof sdk.PermissionDeniedError, message: err.error?.error?.message };
        }
      }, { model });
      const bad = await run('PR-0000-0000', 'claude-haiku-5-5');
      const perm = await run(code, 'claude-opus-5-5');
      assert.deepEqual(bad, { auth: true, perm: false, message: '초대 코드가 올바르지 않거나 사용이 중지되었습니다.' });
      assert.deepEqual(perm, { auth: false, perm: true, message: '이 초대 코드로는 claude-opus-5-5을 쓸 수 없습니다.' });
      return `AuthenticationError "${bad.message}"; PermissionDeniedError "${perm.message}"`;
    },
  },
];
