// Automatic model selection and self-healing (js/ai/models.js), end to end in Edge:
//   node tests/models/run.mjs     (starts `python -m http.server 8172` if nothing is listening)
// The real app (index.html, real modules, the real Anthropic SDK from jsDelivr) talks to in-process fakes of the
// Anthropic, OpenAI and Gemini APIs and of the invite-code relay (tests/relay-client/fake-relay.mjs) through
// Playwright route interception, answering in the providers' documented shapes. index.html is answered with a TEST
// COPY whose connect-src also lists https://relay.test; every other external request is aborted and fails the test
// (the pinned SDK bundle passes, the font stylesheet is stubbed). No paid API is called.
// MODELS_ONLY=<regex> runs only the matching tests. Results + screenshots: C:/Users/dindoo/Projects/pr-tools/out/models/.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { parseTranslationUserMessage } from '../../js/ai/prompts.js';
import { CODES, createFakeRelay, RELAY_URL } from '../relay-client/fake-relay.mjs';

const PORT = 8172;
const ORIGIN = `http://localhost:${PORT}`;
const APP = `${ORIGIN}/index.html`;
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/models';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SETTINGS_KEY = 'pr.settings.v1';
const CLAUDE_KEY = 'sk-ant-test-models-0000';
const OPENAI_KEY = 'sk-proj-test-models-0000';
const GEMINI_KEY = 'AIza-test-models-0000';
const CORS = {
  'access-control-allow-origin': '*', 'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-expose-headers': '*',
};
const HEAL_TOAST = /모델을 쓸 수 없어 .+\(으\)로 바꿨습니다\./;

mkdirSync(OUT, { recursive: true });
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

// MODELS_ONLY=<regex>: run only the tests whose name matches (while working on one).
const ONLY = process.env.MODELS_ONLY ? new RegExp(process.env.MODELS_ONLY) : null;

async function test(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  const t0 = Date.now();
  try {
    const evidence = await fn();
    results.push({ name, result: 'pass', evidence: String(evidence ?? 'ok'), ms: Date.now() - t0 });
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)\n      ${evidence ?? ''}`);
  } catch (err) {
    results.push({ name, result: 'fail', evidence: err?.stack || String(err), ms: Date.now() - t0 });
    console.log(`FAIL  ${name}\n      ${err?.stack || err}`);
  }
}

async function serverUp() {
  try { return (await fetch(`${ORIGIN}/index.html`)).ok; } catch { return false; }
}

/** index.html with https://relay.test added to connect-src — served only to the test browser. */
function testCopyOfIndex() {
  const html = readFileSync(`${REPO}/index.html`, 'utf8');
  const out = html.replace(/(connect-src [^;"]*)/, `$1 ${RELAY_URL}`);
  if (out === html) throw new Error('could not find connect-src in index.html');
  return out;
}

// ───────────────────────────── fake APIs ─────────────────────────────

const json = (status, body, headers = {}) => ({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
const sseBody = (events) => events.map((d) => `${d.type ? `event: ${d.type}\n` : ''}data: ${JSON.stringify(d)}\n\n`).join('');
const ANSWER = '요약입니다. 이 논문은 중환자실 간호를 다룹니다.';

/** Korean "translation" of every <s id> in a translation request (passes the translator's fidelity checks). */
function translationsFor(userText) {
  const { items } = parseTranslationUserMessage(userText || '');
  return JSON.stringify({ translations: items.map((it) => ({ id: it.sid, ko: `번역: ${it.text}` })) });
}

/**
 * One fake API = { state, calls, handle(route) }. state.models: listed ids; a POST naming a model that is not
 * listed (or in state.missing) answers the provider's documented "model not found"; state.fail(call) may return
 * another error answer first; state.listFail(call) answers the model list instead (an error answer, or
 * { abort: true } for a connection failure); state.delayMs delays every answer.
 */
function fakeApi(respond, state) {
  const calls = [];
  async function handle(route) {
    const req = route.request();
    if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: CORS }); return; }
    const url = new URL(req.url());
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = req.postData(); }
    const call = { method: req.method(), path: url.pathname, search: url.search, headers: req.headers(), body };
    calls.push(call);
    if (state.delayMs) await sleep(state.delayMs);
    const listFailure = call.method === 'GET' ? state.listFail?.(call) : null;
    const res = listFailure || respond(call, state);
    if (res.abort) {
      call.status = 0;
      await route.abort('failed').catch(() => {});
      return;
    }
    call.status = res.status || 200;
    await route.fulfill({ status: call.status, headers: { ...CORS, ...(res.headers || {}) }, contentType: res.contentType, body: res.body })
      .catch(() => {}); // the page may have aborted the request meanwhile
  }
  return { state, calls, handle };
}

/** Anthropic Messages API: GET /v1/models, POST /v1/messages (JSON + SSE); 404 not_found_error "model: …". */
function anthropicRespond(call, state) {
  if (call.method === 'GET' && call.path === '/v1/models') {
    const data = state.models.map((id, i) => ({ type: 'model', id, display_name: id, created_at: new Date(Date.UTC(2026, 8, 30 - i)).toISOString() }));
    return json(200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
  }
  if (call.method !== 'POST' || call.path !== '/v1/messages') return json(404, { type: 'error', error: { type: 'not_found_error', message: 'Not found' } });
  const failure = state.fail?.(call);
  if (failure) return json(failure.status, { type: 'error', error: { type: failure.type, message: failure.message }, request_id: 'req_fail' });
  const model = call.body?.model;
  if (!state.models.includes(model) || state.missing?.has(model)) {
    return json(404, { type: 'error', error: { type: 'not_found_error', message: `model: ${model}` }, request_id: 'req_404' });
  }
  const user = call.body.messages.at(-1)?.content;
  const text = call.body.output_config?.format ? translationsFor(typeof user === 'string' ? user : '') : ANSWER;
  const usage = { input_tokens: 900, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  if (!call.body.stream) {
    return json(200, { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage });
  }
  const half = Math.ceil(text.length / 2);
  return {
    contentType: 'text/event-stream',
    body: sseBody([
      { type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(half) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 60 } },
      { type: 'message_stop' },
    ]),
  };
}

/** OpenAI Responses API: GET /v1/models, POST /v1/responses (JSON + SSE); 404 code model_not_found. */
function openaiRespond(call, state) {
  if (call.method === 'GET' && call.path === '/v1/models') {
    return json(200, { object: 'list', data: state.models.map((id) => ({ id, object: 'model', created: 1790000000, owned_by: 'openai' })) });
  }
  if (call.method !== 'POST' || call.path !== '/v1/responses') return json(404, { error: { message: 'Not found', type: 'invalid_request_error', param: null, code: null } });
  const failure = state.fail?.(call);
  if (failure) return json(failure.status, { error: { message: failure.message, type: failure.type, param: null, code: failure.code ?? null } });
  const model = call.body?.model;
  if (!state.models.includes(model) || state.missing?.has(model)) {
    return json(404, { error: { message: `The model \`${model}\` does not exist or you do not have access to it.`, type: 'invalid_request_error', param: null, code: 'model_not_found' } });
  }
  const user = [...(call.body.input || [])].reverse().find((m) => m.role === 'user');
  const userText = (Array.isArray(user?.content) ? user.content : []).filter((p) => p.type === 'input_text').map((p) => p.text).join('\n');
  const text = call.body.text?.format?.type === 'json_schema' ? translationsFor(userText) : ANSWER;
  const usage = { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 60, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 960 };
  const message = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] };
  const response = (status, extra = {}) => ({ id: 'resp_fake', object: 'response', created_at: 1792325061, status, model, output: [], usage: null, error: null, incomplete_details: null, ...extra });
  if (!call.body.stream) return json(200, response('completed', { output: [message], usage }));
  const half = Math.ceil(text.length / 2);
  let seq = 0;
  const ev = (type, data) => ({ type, sequence_number: seq++, ...data });
  return {
    contentType: 'text/event-stream',
    body: sseBody([
      ev('response.created', { response: response('in_progress') }),
      ev('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } }),
      ev('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: text.slice(0, half) }),
      ev('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: text.slice(half) }),
      ev('response.completed', { response: response('completed', { output: [message], usage }) }),
    ]),
  };
}

/** Gemini API: GET /v1beta/models, POST models/{id}:generateContent / :streamGenerateContent?alt=sse; 404 NOT_FOUND. */
function geminiRespond(call, state) {
  if (call.method === 'GET' && call.path === '/v1beta/models') {
    return json(200, {
      models: state.models.map((id) => ({
        name: `models/${id}`, displayName: id.replace(/^gemini-/, 'Gemini ').replace(/-/g, ' '),
        supportedGenerationMethods: /embedding/.test(id) ? ['embedContent'] : ['generateContent', 'countTokens'],
      })),
    });
  }
  const m = /^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/.exec(call.path);
  if (call.method !== 'POST' || !m) return json(404, { error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } });
  const model = decodeURIComponent(m[1]);
  const notFound = { code: 404, message: `models/${model} is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.`, status: 'NOT_FOUND' };
  if (!state.models.includes(model) || state.missing?.has(model)) return json(404, { error: notFound });
  const userText = call.body.contents?.at(-1)?.parts?.map((p) => p.text || '').join('') || '';
  const text = call.body.generationConfig?.responseMimeType === 'application/json' ? translationsFor(userText) : ANSWER;
  const usageMetadata = { promptTokenCount: 900, candidatesTokenCount: 60, totalTokenCount: 960 };
  const chunk = (t, finishReason) => ({ candidates: [{ content: { role: 'model', parts: [{ text: t }] }, ...(finishReason ? { finishReason } : {}) }], usageMetadata, modelVersion: model });
  if (m[2] === 'generateContent') return json(200, chunk(text, 'STOP'));
  const half = Math.ceil(text.length / 2);
  // state.streamError: the stream breaks with a 404 error chunk after the first text chunk.
  const events = state.streamError
    ? [chunk(text.slice(0, half)), { error: notFound }]
    : [chunk(text.slice(0, half)), chunk(text.slice(half), 'STOP')];
  return { contentType: 'text/event-stream', body: events.map((d) => `data: ${JSON.stringify(d)}\r\n\r\n`).join('') };
}

// ───────────────────────────── device ─────────────────────────────

let browser;

/**
 * One browser context = one device with its own fakes; `seed` is written to localStorage before the app starts
 * (as stored settings, i.e. what an older or newer app version left there).
 */
async function device({ seed = null, viewport = { width: 1280, height: 900 }, anthropic = {}, openai = {}, gemini = {}, relayRetired = [] } = {}) {
  const fakes = {
    anthropic: fakeApi(anthropicRespond, { models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], missing: new Set(), fail: null, ...anthropic }),
    openai: fakeApi(openaiRespond, { models: ['gpt-6.1-sol', 'gpt-6-luna'], missing: new Set(), fail: null, ...openai }),
    gemini: fakeApi(geminiRespond, { models: ['gemini-3.8-flash'], missing: new Set(), streamError: false, ...gemini }),
    relay: createFakeRelay(),
  };
  // Models Anthropic no longer serves behind the relay: the worker passes Anthropic's 404 through unchanged.
  const retired = new Set(relayRetired);
  fakes.relay.retiredCalls = [];
  const relayHandle = async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/v1/messages') {
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch { /* not JSON */ }
      if (body && retired.has(body.model)) {
        fakes.relay.retiredCalls.push(body.model);
        await route.fulfill({
          status: 404, contentType: 'application/json',
          headers: { 'access-control-allow-origin': req.headers().origin || '*', vary: 'Origin', 'access-control-expose-headers': 'request-id', 'request-id': 'req_relay_404' },
          body: JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `model: ${body.model}` } }),
        });
        return;
      }
    }
    await fakes.relay.handle(route);
  };
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport, colorScheme: 'light' });
  const problems = [];
  const external = [];
  const indexHtml = testCopyOfIndex();
  await ctx.route(/^https?:\/\/(?!localhost:8172\/)/, (route) => {
    const url = route.request().url();
    if (url.startsWith('https://cdn.jsdelivr.net/gh/orioncactus/pretendard')) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '/* font stub (offline test) */' });
    }
    if (url.startsWith('https://cdn.jsdelivr.net/npm/')) return route.continue(); // the pinned SDK bundle + its deps
    if (url.startsWith('https://api.anthropic.com/')) return fakes.anthropic.handle(route);
    if (url.startsWith('https://api.openai.com/')) return fakes.openai.handle(route);
    if (url.startsWith('https://generativelanguage.googleapis.com/')) return fakes.gemini.handle(route);
    if (url.startsWith(`${RELAY_URL}/`)) return relayHandle(route);
    external.push(url);
    return route.abort();
  });
  await ctx.route(/^http:\/\/localhost:8172\/index\.html(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: indexHtml }));
  await ctx.addInitScript(({ key, seed }) => {
    try { if (seed && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(seed)); } catch { /* blocked */ }
    document.addEventListener('securitypolicyviolation', (e) => console.error(`[csp] ${e.violatedDirective} blocked ${e.blockedURI}`));
  }, { key: SETTINGS_KEY, seed });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Chromium logs every non-2xx answer: the fakes' 404/403/400/429 are what these tests ask for.
    if (/^Failed to load resource/.test(m.text())) return;
    problems.push(`console.error ${m.text()}`);
  });
  const done = async () => {
    await ctx.close();
    assert(!external.length, `external requests blocked: ${external.join(', ')}`);
    assert(!problems.length, `console/page/CSP problems:\n  ${problems.join('\n  ')}`);
  };
  return { ctx, page, fakes, done };
}

const shot = (target, file, opts = {}) => target.screenshot({ path: `${OUT}/${file}.png`, ...opts });
const stored = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), SETTINGS_KEY);
const effectiveModels = (page) => page.evaluate(async () => {
  const { settings } = await import('/js/core/settings.js');
  return [settings.model('translate'), settings.model('assist')];
});
const optionsOf = (page, label) => page.$eval(`#set-ai select[aria-label="${label}"]`, (s) => [...s.options].map((o) => ({ value: o.value, text: o.textContent })));
const toastTexts = (page) => page.$$eval('.toast .toast-msg', (els) => els.map((e) => e.textContent));
const posts = (fake, path) => fake.calls.filter((c) => c.method === 'POST' && c.path.startsWith(path));
const gets = (fake, path) => fake.calls.filter((c) => c.method === 'GET' && c.path === path);

async function booted(page) {
  await page.waitForFunction(() => document.querySelector('.library, .reader, .settings, .message-screen'), null, { timeout: 30000 });
}

/** Record the app bus's 'ai:model-change' events (same module instance as the app). */
async function watchModelChanges(page) {
  await page.evaluate(async () => {
    const { bus } = await import('/js/core/bus.js');
    window.__modelChanges = [];
    bus.on('ai:model-change', (d) => window.__modelChanges.push({ provider: d.provider, kind: d.kind, from: d.from, to: d.to, message: d.message }));
  });
}
const modelChanges = (page) => page.evaluate(() => window.__modelChanges || []);

/** Type a key into the AI section's password field and save it (Enter = blur = change). */
async function saveKey(page, key) {
  const input = page.locator('#set-ai input[aria-label="API 키"]');
  await input.fill(key);
  await input.press('Enter');
}

// ---------------------------------------------------------------------------------------------------------------

let server = null;
if (!(await serverUp())) {
  server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: REPO, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60 && !(await serverUp()); i++) await sleep(100);
  if (!(await serverUp())) throw new Error('static server did not start');
}
browser = await chromium.launch({ channel: 'msedge' });

try {
  await test('new user: AI cards in order (초대 코드 · Claude · GPT · Gemini); 자동 선택 defaults, key pages and cost notes; no request without a key', async () => {
    const d = await device();
    const { page, fakes } = d;
    await page.goto(`${APP}#/settings/ai`);
    await page.waitForSelector('#set-ai .radio-card');
    const cards = await page.locator('#set-ai .radio-card .radio-title').allInnerTexts();
    assertEqual(cards, ['키 없이 쓰기 (초대 코드)', 'Claude', 'GPT (OpenAI)', 'Gemini'], 'card order');
    const checked = await page.$eval('#set-ai input[name="provider"]:checked', (i) => i.value);
    const claude = { t: await optionsOf(page, '번역 모델'), a: await optionsOf(page, '요약·채팅·설명 모델') };
    assertEqual([claude.t[0], claude.a[0]], [{ value: '', text: '자동 선택 — Claude Haiku 5.5 (빠름·저렴)' }, { value: '', text: '자동 선택 — Claude Sonnet 5.5 (고품질)' }], 'Claude auto options');
    const claudeLink = await page.$eval('#set-ai .key-howto a', (a) => [a.href, a.target, a.rel]);
    assertEqual(claudeLink, ['https://platform.claude.com/settings/keys', '_blank', 'noopener noreferrer'], 'Claude key page');
    const claudeCost = await page.locator('#set-ai .price-hint').innerText();
    assert(/요금\(100만 토큰당\)/.test(claudeCost) && /사용량에 집계/.test(claudeCost), `Claude cost note: ${claudeCost}`);
    await shot(page.locator('#set-ai'), 'settings-ai-new-user');

    const detailOf = async (id) => {
      await page.locator(`#set-ai .radio-card[data-provider="${id}"]`).click();
      await page.waitForFunction((id) => document.querySelector('#set-ai input[name="provider"]:checked')?.value === id, id);
      return {
        link: await page.$eval('#set-ai .key-howto a', (a) => a.href),
        howto: await page.locator('#set-ai .key-howto').innerText(),
        cost: await page.locator('#set-ai .note', { hasText: '비용 미집계' }).innerText(),
        auto: (await optionsOf(page, '번역 모델'))[0].text,
      };
    };
    const gpt = await detailOf('openai');
    const gem = await detailOf('gemini');
    assertEqual([gpt.link, gem.link], ['https://platform.openai.com/api-keys', 'https://aistudio.google.com/apikey'], 'key pages');
    for (const x of [gpt, gem]) {
      assert(x.cost.includes('비용 미집계 — 각 회사 결제 화면에서 확인'), `cost note: ${x.cost}`);
      assertEqual(x.auto, '자동 선택 (키를 저장하면 고릅니다)', 'auto option before a key');
    }
    assert(gpt.howto.includes('Create new secret key') && gem.howto.includes('Create API key'), 'how-to paragraphs');
    const requests = fakes.anthropic.calls.length + fakes.openai.calls.length + fakes.gemini.calls.length;
    assertEqual(requests, 0, 'API requests without any key');
    await d.done();
    return `cards [${cards.join(' | ')}], ${checked} selected; Claude “${claude.t[0].text}” / “${claude.a[0].text}”; GPT “${gpt.cost.slice(0, 26)}…” → ${gpt.link}; Gemini → ${gem.link}; 0 API requests`;
  });

  await test('auto-pick on key save — Claude: GET /v1/models → newest Haiku (translate) / Sonnet (assist); legacy ids not offered; an explicit pick survives a reload of the list', async () => {
    const d = await device({
      anthropic: { models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-3-5-haiku-20241022', 'claude-3-haiku-20240307'] },
    });
    const { page, fakes } = d;
    await page.goto(`${APP}#/settings/ai`);
    await page.waitForSelector('#set-ai input[aria-label="API 키"]');
    await saveKey(page, CLAUDE_KEY);
    await page.waitForSelector('#set-ai .test-result.is-ok >> text=모델 7개를 불러왔습니다');
    const s = await stored(page);
    assertEqual([s.claude.apiKey, s.claude.translateModel, s.claude.assistModel, s.claude.autoModels], [CLAUDE_KEY, '', '', { translate: 'claude-haiku-5-5', assist: 'claude-sonnet-5-5' }], 'stored');
    const opts = await optionsOf(page, '번역 모델');
    assert(!opts.some((o) => /claude-3/.test(o.value)), `legacy offered: ${opts.map((o) => o.value)}`);
    assertEqual(opts.length, 6, 'options (자동 선택 + 5 current models)');
    const list = gets(fakes.anthropic, '/v1/models');
    assert(list.length === 1 && list[0].headers['x-api-key'] === CLAUDE_KEY, `GET /v1/models calls: ${list.length}`);
    assertEqual(posts(fakes.anthropic, '/v1/messages').length, 0, 'paid requests');

    // An explicit choice is kept when the list is read again.
    await page.selectOption('#set-ai select[aria-label="요약·채팅·설명 모델"]', 'claude-opus-5-5');
    await page.locator('#set-ai .btn', { hasText: '모델 목록 불러오기' }).click();
    await page.waitForFunction(() => /모델 7개를 불러왔습니다/.test(document.querySelector('#set-ai .test-result')?.textContent || '')
      && !document.querySelector('#set-ai .test-result.is-busy'));
    const after = await stored(page);
    assertEqual([after.claude.assistModel, ...(await effectiveModels(page))], ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'], 'explicit Opus kept');
    await d.done();
    return `key saved → 1 GET /v1/models (x-api-key ok), 0 POST; autoModels ${JSON.stringify(s.claude.autoModels)}; options ${opts.map((o) => o.value || '자동').join(', ')}; explicit Opus kept after 모델 목록 불러오기`;
  });

  await test('auto-pick on 테스트 — Claude: a saved model that is no longer listed and a legacy one are replaced (message says so)', async () => {
    const d = await device({
      seed: { provider: 'claude', claude: { apiKey: '', translateModel: 'claude-3-haiku-20240307', assistModel: 'claude-opus-4-1', autoModels: { translate: '', assist: '' } } },
      anthropic: { models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-3-haiku-20240307'] },
    });
    const { page, fakes } = d;
    await page.goto(`${APP}#/settings/ai`);
    await page.waitForSelector('#set-ai input[aria-label="API 키"]');
    await page.locator('#set-ai input[aria-label="API 키"]').fill(CLAUDE_KEY);
    await page.locator('#set-ai .btn', { hasText: '테스트' }).click();
    await page.waitForSelector('#set-ai .test-result.is-ok');
    const msg = (await page.locator('#set-ai .test-result.is-ok').innerText()).trim();
    assert(msg.startsWith('Claude API 키가 유효합니다.'), msg);
    assert(msg.includes('새 키로는 쓸 수 없는 이전 모델(claude-3-haiku-20240307)을 claude-haiku-5-5(으)로 바꿨습니다.'), `legacy note: ${msg}`);
    assert(msg.includes('claude-opus-4-1 모델을 쓸 수 없어 claude-sonnet-5-5(으)로 바꿨습니다.'), `unlisted note: ${msg}`);
    const s = await stored(page);
    assertEqual([s.claude.translateModel, s.claude.assistModel, s.claude.autoModels], ['', '', { translate: 'claude-haiku-5-5', assist: 'claude-sonnet-5-5' }], 'stored');
    const lists = gets(fakes.anthropic, '/v1/models').map((c) => new URLSearchParams(c.search).get('limit'));
    assertEqual(lists, ['1', '100'], 'GET /v1/models (key check, then the list)');
    await d.done();
    return `“${msg}”`;
  });

  await test('auto-pick on key save — GPT: newest Luna (translate) / Sol (assist); pro, snapshots, legacy and non-chat ids not offered; a model that disappeared goes back to 자동 선택', async () => {
    const d = await device({
      openai: { models: ['gpt-6.1-sol', 'gpt-6.1-sol-pro', 'gpt-6.1-luna', 'gpt-6-luna', 'gpt-6-luna-2026-08-01', 'gpt-5-mini', 'gpt-4.1-mini', 'text-embedding-3-small', 'whisper-1', 'gpt-realtime'] },
    });
    const { page, fakes } = d;
    await page.goto(`${APP}#/settings/ai`);
    await page.locator('#set-ai .radio-card[data-provider="openai"]').click();
    await page.waitForSelector('#set-ai input[aria-label="API 키"][placeholder="sk-…"]');
    await saveKey(page, OPENAI_KEY);
    await page.waitForSelector('#set-ai .test-result.is-ok >> text=모델');
    const first = (await page.locator('#set-ai .test-result.is-ok').innerText()).trim();
    const s = await stored(page);
    assertEqual([s.provider, s.openai.translateModel, s.openai.assistModel, s.openai.autoModels], ['openai', '', '', { translate: 'gpt-6.1-luna', assist: 'gpt-6.1-sol' }], 'stored');
    const opts = (await optionsOf(page, '번역 모델')).map((o) => o.value);
    for (const hidden of ['gpt-4.1-mini', 'text-embedding-3-small', 'whisper-1', 'gpt-realtime', 'gpt-6-luna-2026-08-01']) assert(!opts.includes(hidden), `${hidden} offered: ${opts}`);
    const auto = (await optionsOf(page, '번역 모델'))[0].text;
    assert(/^자동 선택 — GPT-6\.1 Luna/.test(auto), `auto label: ${auto}`);
    const list = gets(fakes.openai, '/v1/models');
    assert(list.length === 1 && list[0].headers.authorization === `Bearer ${OPENAI_KEY}`, `GET /v1/models: ${list.length}`);
    assertEqual(posts(fakes.openai, '/v1/responses').length, 0, 'paid requests');

    // The user picks GPT-6 Luna; later the key's list no longer has it → back to 자동 선택 (and said so).
    await page.selectOption('#set-ai select[aria-label="번역 모델"]', 'gpt-6-luna');
    assertEqual((await stored(page)).openai.translateModel, 'gpt-6-luna', 'explicit pick saved');
    fakes.openai.state.models = fakes.openai.state.models.filter((id) => id !== 'gpt-6-luna' && id !== 'gpt-6-luna-2026-08-01');
    await page.locator('#set-ai .btn', { hasText: '모델 목록 불러오기' }).click();
    await page.waitForSelector('#set-ai .test-result.is-ok >> text=gpt-6-luna 모델을 쓸 수 없어 gpt-6.1-luna(으)로 바꿨습니다.');
    const after = await stored(page);
    assertEqual([after.openai.translateModel, ...(await effectiveModels(page))], ['', 'gpt-6.1-luna', 'gpt-6.1-sol'], 'after the model disappeared');
    await d.done();
    return `“${first}”; options [${opts.join(', ')}]; auto “${auto}”; explicit gpt-6-luna removed from the list → 자동 선택 gpt-6.1-luna`;
  });

  await test('auto-pick — Gemini: newest stable Flash for both tasks (never Pro or 2.x); an old stored gemini-2.5-flash is migrated; an explicit Pro choice is kept', async () => {
    const d = await device({
      // Settings written before automatic selection (no autoModels): the old auto-pick's 2.x id, the user's own Pro.
      seed: { provider: 'gemini', gemini: { apiKey: GEMINI_KEY, translateModel: 'gemini-2.5-flash', assistModel: 'gemini-3.8-pro' } },
      gemini: { models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gemini-3.8-pro', 'gemini-3.9-flash-preview', 'text-embedding-004'] },
    });
    const { page, fakes } = d;
    await page.goto(`${APP}#/settings/ai`);
    await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key) || '{}').gemini?.autoModels?.translate === 'gemini-3.8-flash', SETTINGS_KEY);
    const s = await stored(page);
    assertEqual([s.gemini.translateModel, s.gemini.assistModel, s.gemini.autoModels], ['', 'gemini-3.8-pro', { translate: 'gemini-3.8-flash', assist: 'gemini-3.8-flash' }], 'stored');
    assertEqual(await effectiveModels(page), ['gemini-3.8-flash', 'gemini-3.8-pro'], 'models used');
    const opts = (await optionsOf(page, '번역 모델')).map((o) => o.value);
    assert(!opts.some((id) => /^gemini-2/.test(id)) && !opts.includes('text-embedding-004'), `options: ${opts}`);
    const assistSelected = await page.$eval('#set-ai select[aria-label="요약·채팅·설명 모델"]', (sel) => sel.value);
    assertEqual(assistSelected, 'gemini-3.8-pro', 'assist select shows the explicit Pro');
    const picks = await page.evaluate(async () => {
      const g = await import('/js/ai/gemini.js');
      const list = ['gemini-3.8-pro', 'gemini-3.8-flash-lite', 'gemini-3.9-flash-preview'].map((id) => ({ id }));
      return { assist: g.pickGeminiModel(list, 'assist'), translate: g.pickGeminiModel(list, 'translate') };
    });
    assertEqual(picks, { assist: 'gemini-3.9-flash-preview', translate: 'gemini-3.9-flash-preview' }, 'no stable Flash: preview Flash, still not Pro');
    // A translation request goes to the picked model.
    const r = await page.evaluate(async () => {
      const { quickTranslate } = await import('/js/ai/tasks.js');
      return quickTranslate('Delirium is common in intensive care units.');
    });
    const sent = posts(fakes.gemini, '/v1beta/models/').map((c) => c.path);
    assertEqual(sent, ['/v1beta/models/gemini-3.8-flash:generateContent'], 'request path');
    assert(gets(fakes.gemini, '/v1beta/models').every((c) => c.headers['x-goog-api-key'] === GEMINI_KEY), 'key header');
    await d.done();
    return `migrated: translate '' (2.5 dropped) → auto ${s.gemini.autoModels.translate}; explicit Pro kept for assist; options ${opts.length}; quickTranslate → ${sent[0]} (“${r.text.slice(0, 12)}…”)`;
  });

  await test('auto-pick — invite code: models from /relay/me on join (Haiku + Sonnet); the code losing Sonnet is followed on the next visit', async () => {
    const d = await device({ seed: { relay: { url: RELAY_URL } } });
    const { page, fakes } = d;
    await page.goto(`${APP}#/join/${CODES.sonnet}`);
    await page.waitForSelector('.library', { timeout: 30000 }); // a join link goes straight to the library (no welcome screen since 2026-10-19)
    const s = await stored(page);
    assertEqual([s.provider, s.relay.translateModel, s.relay.assistModel, s.relay.autoModels], ['relay', '', '', { translate: 'claude-haiku-5-5', assist: 'claude-sonnet-5-5' }], 'after join');
    assertEqual(await effectiveModels(page), ['claude-haiku-5-5', 'claude-sonnet-5-5'], 'models used');
    fakes.relay.db.get(CODES.sonnet).allowedModels = ['claude-haiku-5-5'];
    await page.reload(); // the next visit: app.js re-reads /relay/me once
    await booted(page);
    await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key) || '{}').relay?.autoModels?.assist === 'claude-haiku-5-5', SETTINGS_KEY);
    const later = await stored(page);
    assertEqual([later.relay.allowedModels, later.relay.autoModels, await effectiveModels(page)],
      [['claude-haiku-5-5'], { translate: 'claude-haiku-5-5', assist: 'claude-haiku-5-5' }, ['claude-haiku-5-5', 'claude-haiku-5-5']], 'after the owner removed Sonnet');
    await d.done();
    return `join → autoModels ${JSON.stringify(s.relay.autoModels)}; owner removes Sonnet → next visit /relay/me → assist ${later.relay.autoModels.assist}`;
  });

  await test('self-healing — translation: retired Claude model → 1 GET /v1/models, switch persisted, failed batch retried once, one toast; explicit Opus for summaries untouched', async () => {
    const d = await device({
      seed: {
        provider: 'claude', translate: { concurrency: 3 },
        claude: { apiKey: CLAUDE_KEY, translateModel: '', assistModel: 'claude-opus-5-5', autoModels: { translate: 'claude-haiku-4-5', assist: 'claude-sonnet-5-5' } },
      },
    });
    const { page, fakes } = d;
    await page.goto(`${APP}#/`);
    await booted(page);
    await watchModelChanges(page);
    const r = await page.evaluate(async () => {
      const { Translator } = await import('/js/ai/translator.js');
      const { buildSyntheticDoc } = await import('/tests/ai/synth.js');
      const t = new Translator({ doc: buildSyntheticDoc() });
      const errors = [];
      const failed = [];
      t.addEventListener('error', (e) => errors.push(e.detail));
      t.addEventListener('update', (e) => failed.push(...(e.detail?.failed || [])));
      const progress = await t.translateAll();
      const models = [...new Set(Object.values(t.toJSON().items).map((it) => it.m))];
      return { errors, failed, done: progress.done, total: progress.total, models };
    });
    await page.waitForSelector('.toast >> text=모델을 쓸 수 없어');
    await sleep(300);
    const sent = posts(fakes.anthropic, '/v1/messages');
    const byModel = sent.reduce((m, c) => ({ ...m, [c.body.model]: (m[c.body.model] || 0) + 1 }), {});
    assertEqual(sent[0].body.model, 'claude-haiku-4-5', 'first request');
    assertEqual(sent[0].status, 404, 'first answer');
    assertEqual(byModel['claude-haiku-4-5'], 1, 'requests with the retired model (no loop)');
    assert(sent.slice(1).every((c) => c.body.model === 'claude-haiku-5-5' && c.status === 200), 'every later request uses the new model');
    assertEqual(gets(fakes.anthropic, '/v1/models').length, 1, 'model list requests');
    assertEqual([r.errors.length, r.failed.length, r.done === r.total, r.models], [0, 0, true, ['claude-haiku-5-5']], 'translator outcome');
    const changes = await modelChanges(page);
    assertEqual(changes.map((c) => [c.provider, c.kind, c.from, c.to]), [['claude', 'translate', 'claude-haiku-4-5', 'claude-haiku-5-5']], 'model-change events');
    const toasts = (await toastTexts(page)).filter((t) => HEAL_TOAST.test(t));
    assertEqual(toasts, ['claude-haiku-4-5 모델을 쓸 수 없어 claude-haiku-5-5(으)로 바꿨습니다.'], 'toasts');
    const s = await stored(page);
    assertEqual([s.claude.translateModel, s.claude.assistModel, s.claude.autoModels], ['', 'claude-opus-5-5', { translate: 'claude-haiku-5-5', assist: 'claude-sonnet-5-5' }], 'persisted');
    await shot(page, 'heal-translate-toast');
    await d.done();
    return `${sent.length} POSTs: 1× claude-haiku-4-5 (404) then ${sent.length - 1}× claude-haiku-5-5; 1 GET /v1/models; ${r.done}/${r.total} done, 0 errors, 0 failed; toast “${toasts[0]}”; explicit Opus kept`;
  });

  await test('self-healing — chat stream: GPT model gone before the first chunk → healed and streamed from the new one, one toast; concurrent 404s of another model share one heal; explicit choices kept', async () => {
    const d = await device({
      seed: { provider: 'openai', openai: { apiKey: OPENAI_KEY, translateModel: 'gpt-6-luna', assistModel: 'gpt-6-sol', autoModels: { translate: '', assist: '' } } },
      openai: { models: ['gpt-6.1-sol', 'gpt-6.1-luna', 'gpt-6-luna', 'gpt-5-mini'] },
    });
    const { page, fakes } = d;
    await page.goto(`${APP}#/`);
    await booted(page);
    await watchModelChanges(page);
    const chat = await page.evaluate(async () => {
      const { chat } = await import('/js/ai/tasks.js');
      const { buildSyntheticDoc } = await import('/tests/ai/synth.js');
      const chunks = [];
      let done = null;
      for await (const piece of chat(buildSyntheticDoc(), [], '이 연구의 주요 결과는?')) {
        if (typeof piece === 'string') chunks.push(piece);
        else done = piece;
      }
      return { text: chunks.join(''), model: done?.model, usageModel: done?.usage?.model };
    });
    const first = posts(fakes.openai, '/v1/responses').map((c) => [c.body.model, Boolean(c.body.stream), c.status]);
    assertEqual(first, [['gpt-6-sol', true, 404], ['gpt-6.1-sol', true, 200]], 'stream requests');
    assertEqual([chat.text, chat.model, chat.usageModel], [ANSWER, 'gpt-6.1-sol', 'gpt-6.1-sol'], 'streamed answer');
    assertEqual(gets(fakes.openai, '/v1/models').length, 1, 'model list requests');
    let s = await stored(page);
    assertEqual([s.openai.translateModel, s.openai.assistModel, s.openai.autoModels.assist], ['gpt-6-luna', '', 'gpt-6.1-sol'], 'after the chat heal (explicit translate kept)');

    // Three translation requests in flight when GPT-6 Luna disappears: one list request, one notice, each retried once.
    fakes.openai.state.models = ['gpt-6.1-sol', 'gpt-6.1-luna', 'gpt-5-mini'];
    const par = await page.evaluate(async () => {
      const { getProvider } = await import('/js/ai/providers.js');
      const { settings } = await import('/js/core/settings.js');
      const ask = (i) => getProvider().complete({ task: 'quickTranslate', model: settings.model('translate'), messages: [{ role: 'user', content: `문장 ${i}` }], maxTokens: 500, effort: 'low' });
      const out = await Promise.all([1, 2, 3].map(ask));
      return out.map((x) => x.model);
    });
    const all = posts(fakes.openai, '/v1/responses').slice(2).map((c) => [c.body.model, c.status]);
    assertEqual(all.filter(([m]) => m === 'gpt-6-luna').map(([, st]) => st), [404, 404, 404], 'requests with the vanished model');
    assertEqual(all.filter(([m]) => m === 'gpt-6.1-luna').map(([, st]) => st), [200, 200, 200], 'retries');
    assertEqual(par, ['gpt-6.1-luna', 'gpt-6.1-luna', 'gpt-6.1-luna'], 'answered by');
    assertEqual(gets(fakes.openai, '/v1/models').length, 2, 'model list requests (one per heal)');
    await page.waitForFunction(() => document.querySelectorAll('.toast').length >= 2);
    const changes = await modelChanges(page);
    assertEqual(changes.map((c) => [c.kind, c.from, c.to]), [['assist', 'gpt-6-sol', 'gpt-6.1-sol'], ['translate', 'gpt-6-luna', 'gpt-6.1-luna']], 'model-change events');
    const toasts = (await toastTexts(page)).filter((t) => HEAL_TOAST.test(t));
    assertEqual(toasts, ['gpt-6-sol 모델을 쓸 수 없어 gpt-6.1-sol(으)로 바꿨습니다.', 'gpt-6-luna 모델을 쓸 수 없어 gpt-6.1-luna(으)로 바꿨습니다.'], 'toasts');
    s = await stored(page);
    assertEqual([s.openai.translateModel, s.openai.assistModel, s.openai.autoModels], ['', '', { translate: 'gpt-6.1-luna', assist: 'gpt-6.1-sol' }], 'persisted');
    await d.done();
    return `chat: gpt-6-sol 404 → 1 GET /v1/models → stream from ${chat.model} “${chat.text}”; 3 parallel 404s (gpt-6-luna) → 1 list, 3 retries on gpt-6.1-luna; toasts ${JSON.stringify(toasts)}`;
  });

  await test('self-healing — invite code: Sonnet retired upstream (404 passed through the relay) → chat stream retried once on Haiku, one toast', async () => {
    const d = await device({
      seed: { provider: 'relay', relay: { url: RELAY_URL, code: CODES.sonnet, name: '김간호', allowedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'] } },
      relayRetired: ['claude-sonnet-5-5'],
    });
    const { page, fakes } = d;
    await page.goto(`${APP}#/`);
    await booted(page);
    await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key) || '{}').relay?.autoModels?.assist === 'claude-sonnet-5-5', SETTINGS_KEY);
    await watchModelChanges(page);
    const r = await page.evaluate(async () => {
      const { chat } = await import('/js/ai/tasks.js');
      const { buildSyntheticDoc } = await import('/tests/ai/synth.js');
      const chunks = [];
      let done = null;
      for await (const piece of chat(buildSyntheticDoc(), [], '핵심 결과를 알려 줘')) {
        if (typeof piece === 'string') chunks.push(piece);
        else done = piece;
      }
      return { text: chunks.join(''), model: done?.model };
    });
    const served = fakes.relay.calls.filter((c) => c.method === 'POST' && c.path === '/v1/messages').map((c) => [c.body.model, c.headers['x-api-key']]);
    assertEqual(fakes.relay.retiredCalls, ['claude-sonnet-5-5'], 'requests with the retired model');
    assertEqual(served, [['claude-haiku-5-5', CODES.sonnet]], 'retry through the relay');
    assertEqual([r.text, r.model], [ANSWER, 'claude-haiku-5-5'], 'answer');
    assertEqual(fakes.relay.calls.filter((c) => c.method === 'GET' && c.path === '/v1/models').length, 1, 'model list requests');
    await page.waitForSelector('.toast >> text=모델을 쓸 수 없어');
    const toasts = (await toastTexts(page)).filter((t) => HEAL_TOAST.test(t));
    assertEqual(toasts, ['claude-sonnet-5-5 모델을 쓸 수 없어 claude-haiku-5-5(으)로 바꿨습니다.'], 'toasts');
    const s = await stored(page);
    assertEqual([s.relay.assistModel, s.relay.autoModels], ['', { translate: 'claude-haiku-5-5', assist: 'claude-haiku-5-5' }], 'persisted');
    await d.done();
    return `relay 404 “model: claude-sonnet-5-5” → 1 GET /v1/models (allowed models) → stream retried on ${r.model}; toast “${toasts[0]}”`;
  });

  await test('no healing after the first text chunk: a Gemini stream that breaks with 404 mid-answer keeps its partial text and throws not_found', async () => {
    const d = await device({
      seed: { provider: 'gemini', gemini: { apiKey: GEMINI_KEY, translateModel: '', assistModel: '', autoModels: { translate: 'gemini-3.8-flash', assist: 'gemini-3.8-flash' } } },
      gemini: { models: ['gemini-3.9-flash', 'gemini-3.8-flash'], streamError: true },
    });
    const { page, fakes } = d;
    await page.goto(`${APP}#/`);
    await booted(page);
    await watchModelChanges(page);
    const r = await page.evaluate(async () => {
      const { chat } = await import('/js/ai/tasks.js');
      const { buildSyntheticDoc } = await import('/tests/ai/synth.js');
      const chunks = [];
      try {
        for await (const piece of chat(buildSyntheticDoc(), [], '요약해 줘')) if (typeof piece === 'string') chunks.push(piece);
        return { ok: true, chunks };
      } catch (err) {
        return { ok: false, chunks, code: err.code, model: err.model, message: err.message };
      }
    });
    assertEqual([r.ok, r.code, r.model, r.chunks.length], [false, 'not_found', 'gemini-3.8-flash', 1], 'stream outcome');
    assertEqual(posts(fakes.gemini, '/v1beta/models/').length, 1, 'requests (no retry)');
    assertEqual(gets(fakes.gemini, '/v1beta/models').length, 0, 'model list requests');
    assertEqual(await modelChanges(page), [], 'model-change events');
    const s = await stored(page);
    assertEqual(s.gemini.autoModels, { translate: 'gemini-3.8-flash', assist: 'gemini-3.8-flash' }, 'settings unchanged');
    await d.done();
    return `partial “${r.chunks[0]}” kept; then ${r.code} (${r.model}) “${r.message.slice(0, 40)}…”; no list request, no switch`;
  });

  await test('no healing on other errors (403, 400, OpenAI quota) or for a model a caller asked for explicitly', async () => {
    const d = await device({
      seed: {
        provider: 'claude',
        claude: { apiKey: CLAUDE_KEY, translateModel: '', assistModel: '', autoModels: { translate: 'claude-haiku-5-5', assist: 'claude-sonnet-5-5' } },
        openai: { apiKey: OPENAI_KEY, translateModel: '', assistModel: '', autoModels: { translate: 'gpt-6-luna', assist: 'gpt-6.1-sol' } },
      },
    });
    const { page, fakes } = d;
    await page.goto(`${APP}#/`);
    await booted(page);
    await watchModelChanges(page);
    const call = (opts) => page.evaluate(async (opts) => {
      const { getProvider } = await import('/js/ai/providers.js');
      const { settings } = await import('/js/core/settings.js');
      const model = opts.model || settings.model(opts.kind || 'translate', opts.provider);
      try {
        await getProvider(opts.provider).complete({ task: opts.task || 'quickTranslate', model, messages: [{ role: 'user', content: 'x' }], maxTokens: 300 });
        return { ok: true };
      } catch (err) {
        return { code: err.code, model: err.model ?? null, message: err.message };
      }
    }, opts);
    fakes.anthropic.state.fail = () => ({ status: 403, type: 'permission_error', message: 'Your API key does not have permission to use the specified resource.' });
    const forbidden = await call({ provider: 'claude' });
    fakes.anthropic.state.fail = () => ({ status: 400, type: 'invalid_request_error', message: 'messages: text content blocks must be non-empty' });
    const bad = await call({ provider: 'claude' });
    fakes.anthropic.state.fail = null;
    const explicit = await call({ provider: 'claude', model: 'claude-mythos-1', task: 'summary' });
    fakes.openai.state.fail = () => ({ status: 429, type: 'insufficient_quota', code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' });
    const quota = await call({ provider: 'openai', kind: 'translate' });
    assertEqual([forbidden.code, bad.code, explicit.code, explicit.model, quota.code], ['permission', 'bad_request', 'not_found', 'claude-mythos-1', 'billing'], 'error codes');
    assertEqual(posts(fakes.anthropic, '/v1/messages').length, 3, 'Claude requests (no retries)');
    assertEqual(posts(fakes.openai, '/v1/responses').length, 1, 'OpenAI requests (no retries)');
    assertEqual(gets(fakes.anthropic, '/v1/models').length + gets(fakes.openai, '/v1/models').length, 0, 'model list requests');
    assertEqual(await modelChanges(page), [], 'model-change events');
    const s = await stored(page);
    assertEqual([s.claude.autoModels, s.openai.autoModels], [{ translate: 'claude-haiku-5-5', assist: 'claude-sonnet-5-5' }, { translate: 'gpt-6-luna', assist: 'gpt-6.1-sol' }], 'settings unchanged');
    assertEqual((await toastTexts(page)).filter((t) => HEAL_TOAST.test(t)), [], 'toasts');
    await d.done();
    return `403 → ${forbidden.code}; 400 → ${bad.code}; explicit claude-mythos-1 404 → ${explicit.code} (not healed); OpenAI insufficient_quota → ${quota.code}; 0 list requests, settings unchanged`;
  });

  await test('invitee: invite card with name and usage, “내 API 키 쓰기” → GPT (code kept, models picked) → back to the invite code in one click; screenshots', async () => {
    const d = await device({ seed: { relay: { url: RELAY_URL } }, viewport: { width: 1280, height: 1000 } });
    const { page, fakes } = d;
    await page.goto(`${APP}#/join/${CODES.haiku}`);
    await page.waitForSelector('.library', { timeout: 30000 }); // a join link goes straight to the library (no welcome screen since 2026-10-19)
    await page.goto(`${APP}#/settings/ai`);
    await page.waitForSelector('#set-ai .radio-card[data-provider="relay"] .radio-desc >> text=홍길동님 · 오늘 $0.03 / $0.50');
    const relayCard = (await page.locator('#set-ai .radio-card[data-provider="relay"]').innerText()).replace(/\s+/g, ' ').trim();
    const ownHead = (await page.locator('#set-ai .own-keys-head').innerText()).replace(/\s+/g, ' ');
    const ownCards = await page.locator('#set-ai .own-keys .radio-card .radio-title').allInnerTexts();
    assertEqual(ownCards, ['Claude', 'GPT (OpenAI)', 'Gemini'], 'own-key cards');
    assert(ownHead.startsWith('내 API 키 쓰기') && ownHead.includes('초대 코드는 지워지지 않아'), ownHead);
    await page.waitForSelector('#set-ai .test-result.is-ok >> text=홍길동님');
    await page.evaluate(() => document.querySelector('.settings')?.scrollTo(0, 0));
    await shot(page.locator('#set-ai'), 'settings-ai-invitee-relay');

    await page.locator('#set-ai .radio-card[data-provider="openai"]').click();
    await page.waitForSelector('#set-ai input[aria-label="API 키"][placeholder="sk-…"]');
    let s = await stored(page);
    assertEqual([s.provider, s.relay.code, s.relay.name], ['openai', CODES.haiku, '홍길동'], 'switched to GPT, code kept');
    await saveKey(page, OPENAI_KEY);
    await page.waitForSelector('#set-ai .test-result.is-ok >> text=모델');
    await page.waitForSelector('#set-ai .radio-card[data-provider="relay"] .radio-desc >> text=누르면 초대 코드로 돌아갑니다');
    const back = (await page.locator('#set-ai .radio-card[data-provider="relay"] .radio-desc').innerText()).trim();
    s = await stored(page);
    assertEqual(s.openai.autoModels, { translate: 'gpt-6-luna', assist: 'gpt-6.1-sol' }, 'GPT models picked');
    await shot(page.locator('#set-ai'), 'settings-ai-invitee-gpt');
    const viaGpt = await page.evaluate(async () => (await (await import('/js/ai/tasks.js')).quickTranslate('Pressure injury.')).text);
    const gptPosts = posts(fakes.openai, '/v1/responses').map((c) => c.body.model);
    assertEqual(gptPosts, ['gpt-6-luna'], 'GPT request');

    // One click back to the invite code.
    await page.locator('#set-ai .radio-card[data-provider="relay"]').click();
    await page.waitForSelector('#set-ai input[aria-label="초대 코드"]');
    s = await stored(page);
    assertEqual([s.provider, s.relay.code, s.openai.apiKey], ['relay', CODES.haiku, OPENAI_KEY], 'back on the invite code, own key kept');
    const codeValue = await page.inputValue('#set-ai input[aria-label="초대 코드"]');
    assertEqual(codeValue, CODES.haiku, 'code field');
    const relayBefore = fakes.relay.calls.filter((c) => c.method === 'POST' && c.path === '/v1/messages').length;
    await page.evaluate(async () => (await import('/js/ai/tasks.js')).quickTranslate('Pressure injury.'));
    const relayPosts = fakes.relay.calls.filter((c) => c.method === 'POST' && c.path === '/v1/messages').slice(relayBefore);
    assertEqual(relayPosts.map((c) => [c.headers['x-api-key'], c.body.model]), [[CODES.haiku, 'claude-haiku-5-5']], 'relay request after switching back');
    assertEqual(posts(fakes.openai, '/v1/responses').length, 1, 'no further GPT requests');
    await d.done();
    return `invite card “${relayCard}”; own keys [${ownCards.join(', ')}]; → GPT: code kept, auto ${JSON.stringify(s.openai.autoModels)}, card “${back}”, quickTranslate via ${gptPosts[0]} (“${viaGpt}”); one click back → relay POST x-api-key=${relayPosts[0].headers['x-api-key']}`;
  });

  await test('narrow screen (375 px): invitee cards and GPT key form have no horizontal overflow', async () => {
    const d = await device({
      seed: { provider: 'openai', relay: { url: RELAY_URL, code: CODES.haiku, name: '홍길동', allowedModels: ['claude-haiku-5-5'] }, openai: { apiKey: OPENAI_KEY } },
      viewport: { width: 375, height: 800 },
    });
    const { page } = d;
    await page.goto(`${APP}#/settings/ai`);
    await page.waitForSelector('#set-ai .own-keys');
    await page.waitForSelector('#set-ai .test-result.is-ok, #set-ai select[aria-label="번역 모델"] option[value="gpt-6-luna"]', { state: 'attached' });
    const overflow = await page.evaluate(() => [document.scrollingElement, ...document.querySelectorAll('.settings, #set-ai, #set-ai *')]
      .filter((e) => e && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'hidden'
        && !['SELECT', 'INPUT', 'TEXTAREA'].includes(e.tagName)) // form controls scroll their own text
      .map((e) => `${e.className || e.nodeName} ${e.scrollWidth}>${e.clientWidth}`));
    await page.setViewportSize({ width: 375, height: 2400 }); // the whole section on screen (it scrolls inside .settings)
    await page.waitForTimeout(150);
    await shot(page.locator('#set-ai'), 'settings-ai-invitee-gpt-375');
    assertEqual(overflow, [], 'horizontal overflow');
    await d.done();
    return 'invite card + 내 API 키 쓰기 + GPT detail fit 375 px';
  });

  // ─────────────────────── adversarial regressions (integration pass, 2026-10-18) ───────────────────────

  /** quickTranslate in `p`; { ok, model } or { ok: false, code, model, message }. */
  const quick = (p) => p.evaluate(async () => {
    const { quickTranslate } = await import('/js/ai/tasks.js');
    try {
      return { ok: true, model: (await quickTranslate('Delirium is common in intensive care units.')).usage?.model };
    } catch (err) {
      return { ok: false, code: err.code, model: err.model ?? null, message: err.message };
    }
  });
  const missingMemory = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('pr.models.v1') || '{}'));
  const waitFor = async (cond, what, ms = 5000) => {
    for (const t0 = Date.now(); !cond(); await sleep(50)) if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
  };

  await test('missing-model memory: a listed model that answers 404 is not picked again after a reload or in another tab; choosing it in 설정 tries it again; another key starts clean', async () => {
    const d = await device({
      seed: { provider: 'openai', openai: { apiKey: OPENAI_KEY, translateModel: '', assistModel: '', autoModels: { translate: 'gpt-6.1-luna', assist: 'gpt-6.1-sol' } } },
      // gpt-6.1-luna is listed but answers model_not_found (e.g. not enabled for the project).
      openai: { models: ['gpt-6.1-sol', 'gpt-6.1-luna', 'gpt-6-luna'], missing: new Set(['gpt-6.1-luna']) },
    });
    const { page, ctx, fakes } = d;
    await page.goto(`${APP}#/`);
    await booted(page);
    const first = await quick(page);
    assertEqual(first, { ok: true, model: 'gpt-6-luna' }, 'first call (healed)');
    const memo = await missingMemory(page);
    assertEqual(Object.keys(memo.openai?.ids || {}), ['gpt-6.1-luna'], 'remembered as missing');
    assert(/^[0-9a-f]{8}$/.test(memo.openai.cred) && !JSON.stringify(memo).includes(OPENAI_KEY), 'only a fingerprint of the key is stored');

    // Next visit: 설정 reads the key's list again (quietly). The model is still listed but must not come back.
    await page.goto(`${APP}#/settings/ai`);
    await page.reload();
    await page.waitForSelector('#set-ai select[aria-label="번역 모델"]');
    await waitFor(() => gets(fakes.openai, '/v1/models').length >= 2, 'the quiet list after the reload');
    await sleep(200);
    let s = await stored(page);
    assertEqual([s.openai.translateModel, s.openai.autoModels.translate], ['', 'gpt-6-luna'], 'after the reload + list');
    const status = await page.locator('#set-ai .test-result').first().innerText();
    assert(!/gpt-6\.1-luna/.test(status), `status line: ${status}`);

    // Another tab of the same browser: same memory, no 404 there either.
    const tab2 = await ctx.newPage();
    await tab2.goto(`${APP}#/`);
    await booted(tab2);
    const inTab2 = await tab2.evaluate(async () => (await import('/js/ai/models.js')).isModelMissing('openai', 'gpt-6.1-luna'));
    const tab2Call = await quick(tab2);
    assertEqual([inTab2, tab2Call], [true, { ok: true, model: 'gpt-6-luna' }], 'second tab');
    await tab2.close();
    const tried = () => posts(fakes.openai, '/v1/responses').filter((c) => c.body.model === 'gpt-6.1-luna').length;
    assertEqual(tried(), 1, 'requests with the missing model so far');

    // The user picks it again in 설정 (e.g. after enabling it): the mark is dropped and the model is tried once more.
    await page.selectOption('#set-ai select[aria-label="번역 모델"]', 'gpt-6.1-luna');
    assertEqual((await missingMemory(page)).openai, undefined, 'mark dropped on an explicit pick');
    const again = await quick(page);
    s = await stored(page);
    assertEqual([again, tried(), s.openai.translateModel, s.openai.autoModels.translate], [{ ok: true, model: 'gpt-6-luna' }, 2, '', 'gpt-6-luna'], 'explicit pick tried, healed again');

    // Another key has other models: the memory of the old key does not apply.
    const otherKey = await page.evaluate(async () => {
      const { settings } = await import('/js/core/settings.js');
      const m = await import('/js/ai/models.js');
      const before = m.isModelMissing('openai', 'gpt-6.1-luna');
      settings.set({ openai: { apiKey: 'sk-proj-another-key-1111' } });
      return [before, m.isModelMissing('openai', 'gpt-6.1-luna')];
    });
    assertEqual(otherKey, [true, false], 'memory per key');
    await d.done();
    return `404 model remembered (fingerprint only); reload + quiet list kept gpt-6-luna; tab 2 used gpt-6-luna without a 404; explicit re-pick → tried once more (${tried()} requests in all) → back to 자동 선택; another key → clean`;
  });

  await test('self-healing when the model list cannot be read (Claude list 401, GPT list connection failure): not_found thrown, no retry, no switch, no toast; the next call shortly after does not list again; once the list works the model is replaced', async () => {
    const d = await device({
      seed: {
        provider: 'claude',
        claude: { apiKey: CLAUDE_KEY, translateModel: '', assistModel: '', autoModels: { translate: 'claude-haiku-4-5', assist: 'claude-sonnet-5-5' } },
        openai: { apiKey: OPENAI_KEY, translateModel: '', assistModel: '', autoModels: { translate: 'gpt-6-luna', assist: 'gpt-6.1-sol' } },
      },
      anthropic: { listFail: () => json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) },
      openai: { models: ['gpt-6.1-sol', 'gpt-6.1-luna'], listFail: () => ({ abort: true }) },
    });
    const { page, fakes } = d;
    await page.goto(`${APP}#/`);
    await booted(page);
    await watchModelChanges(page);
    const call = (provider) => page.evaluate(async (provider) => {
      const { getProvider } = await import('/js/ai/providers.js');
      const { settings } = await import('/js/core/settings.js');
      try {
        const r = await getProvider(provider).complete({ task: 'quickTranslate', model: settings.model('translate', provider), messages: [{ role: 'user', content: 'x' }], maxTokens: 300 });
        return { ok: true, model: r.model };
      } catch (err) {
        return { code: err.code, model: err.model ?? null };
      }
    }, provider);
    const c = [await call('claude'), await call('claude')];
    const o = [await call('openai'), await call('openai')];
    assertEqual(c, [{ code: 'not_found', model: 'claude-haiku-4-5' }, { code: 'not_found', model: 'claude-haiku-4-5' }], 'Claude outcome');
    assertEqual(o, [{ code: 'not_found', model: 'gpt-6-luna' }, { code: 'not_found', model: 'gpt-6-luna' }], 'GPT outcome');
    assertEqual([posts(fakes.anthropic, '/v1/messages').length, gets(fakes.anthropic, '/v1/models').length], [2, 1], 'Claude requests (POST, list)');
    assertEqual([posts(fakes.openai, '/v1/responses').length, gets(fakes.openai, '/v1/models').length], [2, 1], 'GPT requests (POST, list)');
    let s = await stored(page);
    assertEqual([s.claude.autoModels.translate, s.openai.autoModels.translate], ['claude-haiku-4-5', 'gpt-6-luna'], 'settings unchanged');
    assertEqual(await modelChanges(page), [], 'model-change events');

    // A few seconds later the list is readable again: the next failing call heals.
    fakes.anthropic.state.listFail = null;
    await sleep(5200);
    const later = await call('claude');
    s = await stored(page);
    assertEqual([later, s.claude.autoModels.translate], [{ ok: true, model: 'claude-haiku-5-5' }, 'claude-haiku-5-5'], 'healed once the list works');
    assertEqual(gets(fakes.anthropic, '/v1/models').length, 2, 'Claude list requests');
    await page.waitForSelector('.toast >> text=모델을 쓸 수 없어');
    await d.done();
    return `list 401 / connection failure → not_found (no retry, no switch); 2nd call: no 2nd list; 5 s later with a readable list → ${later.model}`;
  });

  await test('a healed model that also answers 404: one retry per call (no loop); the next call heals again and reaches a working model', async () => {
    const d = await device({
      seed: { provider: 'openai', openai: { apiKey: OPENAI_KEY, translateModel: '', assistModel: '', autoModels: { translate: 'gpt-6.1-luna', assist: 'gpt-6.1-sol' } } },
      openai: { models: ['gpt-6.1-sol', 'gpt-6.1-luna', 'gpt-6-luna', 'gpt-5.4-mini'], missing: new Set(['gpt-6.1-luna', 'gpt-6-luna']) },
    });
    const { page, fakes } = d;
    await page.goto(`${APP}#/`);
    await booted(page);
    await watchModelChanges(page);
    const one = await quick(page);
    const afterOne = posts(fakes.openai, '/v1/responses').map((c) => [c.body.model, c.status]);
    assertEqual([one.ok, one.code, one.model], [false, 'not_found', 'gpt-6-luna'], 'first call');
    assertEqual(afterOne, [['gpt-6.1-luna', 404], ['gpt-6-luna', 404]], 'first call: one retry, then the error');
    const two = await quick(page);
    const afterTwo = posts(fakes.openai, '/v1/responses').slice(2).map((c) => [c.body.model, c.status]);
    assertEqual([two, afterTwo], [{ ok: true, model: 'gpt-5.4-mini' }, [['gpt-6-luna', 404], ['gpt-5.4-mini', 200]]], 'second call');
    assertEqual(gets(fakes.openai, '/v1/models').length, 2, 'one list per heal');
    const changes = (await modelChanges(page)).map((c) => [c.from, c.to]);
    assertEqual(changes, [['gpt-6.1-luna', 'gpt-6-luna'], ['gpt-6-luna', 'gpt-5.4-mini']], 'model-change events');
    const s = await stored(page);
    assertEqual(s.openai.autoModels.translate, 'gpt-5.4-mini', 'persisted');
    // A third call goes straight to the working model.
    assertEqual(await quick(page), { ok: true, model: 'gpt-5.4-mini' }, 'third call');
    assertEqual(posts(fakes.openai, '/v1/responses').length, 5, 'POSTs in all');
    await d.done();
    return `call 1: ${afterOne.map(([m, st]) => `${m} ${st}`).join(' → ')} → not_found; call 2: ${afterTwo.map(([m, st]) => `${m} ${st}`).join(' → ')}; call 3 direct`;
  });

  await test('keys without a usable model: GPT list of non-chat ids and Gemini list of speech/embedding ids → one clear Korean error before any paid request (concurrent calls share one list); legacy- or preview-only lists still pick a model', async () => {
    const d = await device({
      seed: {
        provider: 'openai',
        openai: { apiKey: OPENAI_KEY, translateModel: '', assistModel: '', autoModels: { translate: '', assist: '' } },
        gemini: { apiKey: GEMINI_KEY, translateModel: '', assistModel: '', autoModels: { translate: '', assist: '' } },
      },
      openai: { models: ['whisper-1', 'text-embedding-3-small', 'gpt-image-2', 'gpt-realtime', 'tts-1'] },
      gemini: { models: ['gemini-3.8-flash-tts', 'text-embedding-004', 'gemini-3.8-flash-image'] },
    });
    const { page, fakes } = d;
    await page.goto(`${APP}#/`);
    await booted(page);
    const both = await page.evaluate(async () => {
      const { quickTranslate } = await import('/js/ai/tasks.js');
      const one = () => quickTranslate('Pressure injury.').then(() => ({ ok: true }), (err) => ({ code: err.code, fatal: err.fatal, message: err.message }));
      return Promise.all([one(), one()]);
    });
    assertEqual(both.map((r) => [r.code, r.fatal]), [['not_found', true], ['not_found', true]], 'GPT outcome');
    assert(/이 API 키로 쓸 수 있는 GPT \(OpenAI\) 모델을 찾지 못했습니다/.test(both[0].message), both[0].message);
    assertEqual([gets(fakes.openai, '/v1/models').length, posts(fakes.openai, '/v1/responses').length], [1, 0], 'GPT: one shared list, no POST');
    await page.evaluate(async () => (await import('/js/core/settings.js')).settings.set({ provider: 'gemini' }));
    const gem = await quick(page);
    assertEqual([gem.ok, gem.code], [false, 'not_found'], 'Gemini outcome');
    assert(/Gemini/.test(gem.message), gem.message);
    assertEqual(posts(fakes.gemini, '/v1beta/models/').length, 0, 'Gemini: no generateContent');

    // Lists with only older or preview models still give a model (an old project may only have those).
    const picks = await page.evaluate(async () => {
      const g = await import('/js/ai/gemini.js');
      const o = await import('/js/ai/openai.js');
      const ids = (a) => a.map((id) => ({ id }));
      const legacy = ids(['gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-preview-tts']);
      const preview = ids(['gemini-3.9-pro-preview', 'gemini-3.9-flash-preview', 'gemini-3.9-flash-lite-preview']);
      const speech = ids(['gemini-3.8-flash-tts', 'gemini-3.8-flash-image', 'gemini-2.5-flash-preview-tts']);
      return {
        gemLegacy: [g.pickGeminiModel(legacy, 'translate'), g.pickGeminiModel(legacy, 'assist')],
        gemPreview: [g.pickGeminiModel(preview, 'translate'), g.pickGeminiModel(preview, 'assist')],
        gemSpeech: g.pickGeminiModel(speech, 'translate'),
        gptLegacy: [o.pickOpenAiModel(ids(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-nano', 'whisper-1']), 'translate'), o.pickOpenAiModel(ids(['gpt-4o', 'gpt-4o-mini']), 'assist')],
        gptPreview: o.pickOpenAiModel(ids(['gpt-4.5-preview', 'gpt-4o-mini-search-preview', 'o1-preview']), 'assist'),
      };
    });
    assertEqual(picks, {
      gemLegacy: ['gemini-2.5-flash', 'gemini-2.5-flash'],
      gemPreview: ['gemini-3.9-flash-preview', 'gemini-3.9-flash-preview'],
      gemSpeech: '',
      gptLegacy: ['gpt-4o-mini', 'gpt-4o'],
      gptPreview: 'gpt-4.5-preview',
    }, 'picks on legacy / preview / speech-only lists');
    await d.done();
    return `GPT non-chat list → “${both[0].message.slice(0, 44)}…” ×2 with 1 list, 0 POST; Gemini speech-only → not_found, 0 POST; picks ${JSON.stringify(picks)}`;
  });

  await test('models a key or code may not use are healed too: relay 403 “이 초대 코드로는 … 쓸 수 없습니다” (stale tab) → Haiku; OpenAI 403 “must be verified to use the model” → another GPT model', async () => {
    const d = await device({
      seed: {
        provider: 'relay',
        relay: { url: RELAY_URL, code: CODES.sonnet, name: '김간호', allowedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'] },
        openai: { apiKey: OPENAI_KEY, translateModel: '', assistModel: '', autoModels: { translate: 'gpt-6-luna', assist: 'gpt-6.1-sol' } },
      },
      openai: {
        models: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'],
        fail: (call) => (call.body?.model === 'gpt-6.1-sol'
          ? { status: 403, type: 'invalid_request_error', message: 'Your organization must be verified to use the model `gpt-6.1-sol`. Please go to: https://platform.openai.com/settings/organization/general and click on Verify Organization.' }
          : null),
      },
    });
    const { page, fakes } = d;
    await page.goto(`${APP}#/`);
    await booted(page);
    await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key) || '{}').relay?.autoModels?.assist === 'claude-sonnet-5-5', SETTINGS_KEY);
    await watchModelChanges(page);
    // The owner limits the code to Haiku while this tab is open (it still asks for Sonnet).
    fakes.relay.db.get(CODES.sonnet).allowedModels = ['claude-haiku-5-5'];
    const summary = await page.evaluate(async () => {
      const { summarize } = await import('/js/ai/tasks.js');
      const { buildSyntheticDoc } = await import('/tests/ai/synth.js');
      try { const r = await summarize(buildSyntheticDoc()); return { ok: true, model: r.model }; } catch (err) { return { ok: false, code: err.code, message: err.message }; }
    });
    const relayPosts = fakes.relay.calls.filter((c) => c.method === 'POST' && c.path === '/v1/messages').map((c) => [c.body.model, c.status]);
    assertEqual(summary, { ok: true, model: 'claude-haiku-5-5' }, 'relay summary');
    assertEqual(relayPosts.map(([m]) => m), ['claude-sonnet-5-5', 'claude-haiku-5-5'], 'relay requests');
    await page.waitForFunction((key) => JSON.stringify(JSON.parse(localStorage.getItem(key) || '{}').relay?.allowedModels) === '["claude-haiku-5-5"]', SETTINGS_KEY);
    let s = await stored(page);
    assertEqual([s.relay.assistModel, s.relay.autoModels.assist], ['', 'claude-haiku-5-5'], 'relay persisted');

    await page.evaluate(async () => (await import('/js/core/settings.js')).settings.set({ provider: 'openai' }));
    const gpt = await page.evaluate(async () => {
      const { summarize } = await import('/js/ai/tasks.js');
      const { buildSyntheticDoc } = await import('/tests/ai/synth.js');
      try { const r = await summarize(buildSyntheticDoc()); return { ok: true, model: r.model }; } catch (err) { return { ok: false, code: err.code, message: err.message }; }
    });
    const gptPosts = posts(fakes.openai, '/v1/responses').map((c) => [c.body.model, c.status]);
    assertEqual([gpt, gptPosts], [{ ok: true, model: 'gpt-6-sol' }, [['gpt-6.1-sol', 403], ['gpt-6-sol', 200]]], 'GPT summary');
    s = await stored(page);
    assertEqual(s.openai.autoModels.assist, 'gpt-6-sol', 'GPT persisted');
    const changes = (await modelChanges(page)).map((c) => [c.provider, c.from, c.to]);
    assertEqual(changes, [['relay', 'claude-sonnet-5-5', 'claude-haiku-5-5'], ['openai', 'gpt-6.1-sol', 'gpt-6-sol']], 'model-change events');
    await d.done();
    return `relay: sonnet 403 → haiku (allowedModels re-read: ${JSON.stringify(s.relay.allowedModels)}); GPT: gpt-6.1-sol 403 (verification) → gpt-6-sol`;
  });

  await test('switching provider in another tab during a translation: later batches go to the new provider with its automatically picked model; the run completes without errors', async () => {
    const d = await device({
      seed: {
        provider: 'claude', translate: { concurrency: 1 },
        claude: { apiKey: CLAUDE_KEY, translateModel: '', assistModel: '', autoModels: { translate: 'claude-haiku-5-5', assist: 'claude-sonnet-5-5' } },
        openai: { apiKey: OPENAI_KEY, translateModel: '', assistModel: '', autoModels: { translate: '', assist: '' } },
      },
      anthropic: { delayMs: 250 },
      openai: { delayMs: 60 },
    });
    const { page, ctx, fakes } = d;
    await page.goto(`${APP}#/`);
    await booted(page);
    await page.evaluate(async () => {
      const { Translator } = await import('/js/ai/translator.js');
      const { buildSyntheticDoc } = await import('/tests/ai/synth.js');
      const t = new Translator({ doc: buildSyntheticDoc() });
      window.__run = { errors: [], failed: [] };
      t.addEventListener('error', (e) => window.__run.errors.push(e.detail));
      t.addEventListener('update', (e) => window.__run.failed.push(...(e.detail?.failed || [])));
      window.__run.promise = t.translateAll().then((progress) => {
        window.__run.progress = progress;
        window.__run.models = Object.values(t.toJSON().items).map((it) => it.m);
      });
    });
    await waitFor(() => posts(fakes.anthropic, '/v1/messages').filter((c) => c.status === 200).length >= 2, 'two Claude batches', 15000);
    const tab2 = await ctx.newPage();
    await tab2.goto(`${APP}#/`);
    await booted(tab2);
    await tab2.evaluate(async () => (await import('/js/core/settings.js')).settings.set({ provider: 'openai' }));
    await tab2.close();
    await page.waitForFunction(() => window.__run.progress, null, { timeout: 60000 });
    const r = await page.evaluate(() => ({ ...window.__run, promise: undefined }));
    const claude = posts(fakes.anthropic, '/v1/messages');
    const gpt = posts(fakes.openai, '/v1/responses');
    assert(claude.length >= 2 && gpt.length >= 2, `requests: Claude ${claude.length}, GPT ${gpt.length}`);
    assert(gpt.every((c) => c.body.model === 'gpt-6-luna' && c.status === 200), `GPT models: ${gpt.map((c) => c.body.model)}`);
    assertEqual(gets(fakes.openai, '/v1/models').length, 1, 'GPT model list (picked once on first use)');
    assertEqual([r.errors.length, r.failed.length, r.progress.done === r.progress.total], [0, 0, true], 'translator outcome');
    const used = [...new Set(r.models)].sort();
    assertEqual(used, ['claude-haiku-5-5', 'gpt-6-luna'], 'models in the translation file');
    const s = await stored(page);
    assertEqual([s.provider, s.openai.autoModels.translate], ['openai', 'gpt-6-luna'], 'stored');
    await d.done();
    return `${claude.length} batches on Claude, then ${gpt.length} on GPT (gpt-6-luna, listed once); ${r.progress.done}/${r.progress.total} done, 0 errors`;
  });

  await test('?mock=1 session with a saved invite code and keys: 설정 and the library send nothing AI-related to the relay or any AI API (공용 서재 storage may ask GET /shared); the mock answers', async () => {
    const d = await device({
      seed: {
        provider: 'relay',
        relay: { url: RELAY_URL, code: CODES.haiku, name: '홍길동', allowedModels: ['claude-haiku-5-5'] },
        openai: { apiKey: OPENAI_KEY }, claude: { apiKey: CLAUDE_KEY }, gemini: { apiKey: GEMINI_KEY },
      },
    });
    const { page, fakes } = d;
    await page.goto(`${ORIGIN}/index.html?mock=1#/settings/ai`);
    await page.waitForSelector('#set-ai .radio-card');
    await sleep(800);
    await page.goto(`${ORIGIN}/index.html?mock=1#/`);
    await booted(page);
    const answer = await page.evaluate(async () => (await (await import('/js/ai/tasks.js')).quickTranslate('Pressure injury.')).text);
    await sleep(300);
    // 공용 서재 (docs/SHARED.md) is storage, like 내 서재's GitHub sync, which also runs in mock sessions: its GET /shared
    // may reach the relay. Nothing AI-related may (no /relay/me, no /v1/*).
    const relayAi = fakes.relay.calls.filter((c) => !c.path.startsWith('/shared'));
    const sent = relayAi.length + fakes.anthropic.calls.length + fakes.openai.calls.length + fakes.gemini.calls.length;
    assertEqual(sent, 0, 'requests to the relay / AI APIs');
    assert(fakes.relay.calls.every((c) => c.method === 'GET' && c.path === '/shared'), `relay calls: ${fakes.relay.calls.map((c) => `${c.method} ${c.path}`)}`);
    assert(answer.startsWith('〔번역〕') || /번역/.test(answer), `mock answer: ${answer}`);
    const s = await stored(page);
    assertEqual([s.provider, s.relay.code], ['relay', CODES.haiku], 'stored settings untouched (mock is session-only)');
    await d.done();
    return `0 AI requests (relay storage calls: ${fakes.relay.calls.map((c) => `${c.method} ${c.path}`).join(', ') || 'none'}); mock answer “${answer.slice(0, 30)}”; stored provider still ${s.provider}`;
  });
  await test('two tabs: 설정 open in one tab follows a provider picked in the other, and its cards still switch back', async () => {
    const d = await device({ seed: { provider: 'claude', claude: { apiKey: CLAUDE_KEY }, openai: { apiKey: OPENAI_KEY } } });
    const { page, ctx } = d;
    await page.goto(`${APP}#/settings/ai`);
    await page.waitForSelector('#set-ai input[aria-label="API 키"][placeholder="sk-ant-…"]');
    const tab2 = await ctx.newPage();
    await tab2.goto(`${APP}#/`);
    await booted(tab2);
    await tab2.evaluate(async () => (await import('/js/core/settings.js')).settings.set({ provider: 'openai' }));
    await page.waitForFunction(() => document.querySelector('#set-ai input[name="provider"]:checked')?.value === 'openai');
    await page.waitForSelector('#set-ai input[aria-label="API 키"][placeholder="sk-…"]');
    // The Claude card is not stuck as "checked": one click switches back, in both tabs.
    await page.locator('#set-ai .radio-card[data-provider="claude"]').click();
    await page.waitForSelector('#set-ai input[aria-label="API 키"][placeholder="sk-ant-…"]');
    const there = await tab2.evaluate(async () => (await import('/js/core/settings.js')).settings.get().provider);
    await tab2.close();
    assertEqual([(await stored(page)).provider, there], ['claude', 'claude'], 'provider after switching back');
    await d.done();
    return 'tab 2 → GPT: tab 1 settings re-rendered on GPT; Claude card click → Claude in both tabs';
  });
} finally {
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  await browser.close();
  server?.kill();
  const failed = results.filter((r) => r.result !== 'pass');
  console.log(`\nmodels: ${results.length - failed.length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}
