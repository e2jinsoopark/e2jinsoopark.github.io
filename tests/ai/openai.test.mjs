// OpenAI (GPT) provider in a real browser (Edge) against a Playwright-routed https://api.openai.com: exact
// Responses API request bodies, canned JSON and SSE answers in the documented shapes, every error mapping, abort,
// listModels/testKey and the default-model picker on realistic model lists. No paid calls (no key exists here).
// Own static server on port 8171; results → C:/Users/dindoo/Projects/pr-tools/out/ai/openai.results.json.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { CORS, OUT_DIR, recordRoute, sse } from './lib.mjs';
import { parseTranslationUserMessage, TRANSLATION_SCHEMA } from '../../js/ai/prompts.js';

const PORT = 8171;
const ORIGIN = `http://localhost:${PORT}`;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = 'https://api.openai.com/**';
const KEY = 'sk-proj-test-0000';
const LUNA = 'gpt-6-luna';
const SOL = 'gpt-6.1-sol';

// ───────────────────────────── canned API answers ─────────────────────────────

const USAGE = {
  input_tokens: 3000, input_tokens_details: { cached_tokens: 2000, cache_write_tokens: 500 },
  output_tokens: 120, output_tokens_details: { reasoning_tokens: 40 }, total_tokens: 3120,
};
const MAPPED_USAGE = (model) => ({ model, inputTokens: 500, outputTokens: 120, cacheReadTokens: 2000, cacheWriteTokens: 500 });

/** A Response object as in the API reference example (status, output items, usage). */
function response({ model = LUNA, text = 'OK', status = 'completed', reason = null, refusal = null, usage = USAGE, error = null, output } = {}) {
  return {
    id: 'resp_test', object: 'response', created_at: 1792325061, status,
    completed_at: status === 'completed' ? 1792325062 : null, error,
    incomplete_details: reason ? { reason } : null, instructions: null, max_output_tokens: null, model,
    output: output ?? [
      { id: 'rs_1', type: 'reasoning', summary: [] },
      { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
        content: refusal ? [{ type: 'refusal', refusal }] : [{ type: 'output_text', text, annotations: [], logprobs: [] }] },
    ],
    parallel_tool_calls: true, previous_response_id: null, reasoning: { effort: 'low', summary: null }, store: false,
    text: { format: { type: 'text' } }, tool_choice: 'auto', tools: [], truncation: 'disabled', usage, metadata: {},
  };
}

/** An SSE body: response.created … deltas … response.<final> (event: lines included, like the API). */
function streamBody({ model = SOL, chunks = [], final = 'completed', reason = null, usage = USAGE, refusal = null,
  commentary = null, error = null, crlf = false, cut = false, errorEvent = null } = {}) {
  let seq = 0;
  const events = [];
  const push = (type, data) => events.push([type, { type, sequence_number: seq++, ...data }]);
  const resp = (status, extra = {}) => ({ id: 'resp_s', object: 'response', created_at: 1792325061, status, model, output: [], usage: null, error: null, incomplete_details: null, ...extra });
  push('response.created', { response: resp('in_progress') });
  push('response.in_progress', { response: resp('in_progress') });
  if (commentary) {
    push('response.output_item.added', { output_index: 0, item: { id: 'msg_c', type: 'message', role: 'assistant', status: 'in_progress', phase: 'commentary', content: [] } });
    push('response.output_text.delta', { item_id: 'msg_c', output_index: 0, content_index: 0, delta: commentary, logprobs: [] });
  }
  push('response.output_item.added', { output_index: 1, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', phase: 'final_answer', content: [] } });
  push('response.content_part.added', { item_id: 'msg_1', output_index: 1, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  for (const delta of chunks) push('response.output_text.delta', { item_id: 'msg_1', output_index: 1, content_index: 0, delta, logprobs: [], obfuscation: 'Zq3' });
  if (errorEvent) push('error', errorEvent);
  if (refusal) {
    push('response.refusal.delta', { item_id: 'msg_1', output_index: 1, content_index: 0, delta: refusal });
    push('response.refusal.done', { item_id: 'msg_1', output_index: 1, content_index: 0, refusal });
  }
  push('response.output_text.done', { item_id: 'msg_1', output_index: 1, content_index: 0, text: chunks.join(''), logprobs: [] });
  if (!cut) push(`response.${final}`, { response: resp(final, { usage: final === 'failed' ? null : usage, incomplete_details: reason ? { reason } : null, error }) });
  return sse(events, { crlf });
}

const apiError = (status, message, { type = 'invalid_request_error', code = null, param = null } = {}) => ({
  status, json: { error: { message, type, param, code } },
});

// ───────────────────────────── realistic model lists ─────────────────────────────

/** "All models" page (2026-10-18): current + deprecated text models, plus non-chat ids the key also lists. */
const DOCS_TEXT = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.2', 'gpt-5.2-pro', 'gpt-5', 'gpt-5-mini',
  'gpt-5-nano', 'gpt-5-pro', 'o3-pro', 'o3'];
const DOCS_DEPRECATED_TEXT = ['gpt-5.4-nano', 'gpt-5.1', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o-mini', 'gpt-4.1-nano', 'o4-mini',
  'o1-pro', 'gpt-4.5-preview', 'o3-mini', 'o1', 'o1-mini', 'o1-preview', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo', 'gpt-4',
  'gpt-4-turbo-preview'];
const NON_CHAT = ['gpt-5.6-cyber', 'gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-live-1', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini',
  'gpt-realtime-translate', 'gpt-live-transcribe', 'gpt-realtime-whisper', 'gpt-audio-1.5', 'gpt-transcribe', 'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe', 'gpt-4o-transcribe-diarize', 'whisper-1', 'gpt-4o-mini-tts', 'gpt-oss-120b', 'text-embedding-3-large',
  'text-embedding-3-small', 'text-embedding-ada-002', 'omni-moderation-latest', 'gpt-5.3-codex', 'gpt-5.1-codex-max', 'gpt-5-codex',
  'codex-mini-latest', 'gpt-5.3-chat-latest', 'gpt-5-chat-latest', 'chatgpt-4o-latest', 'chat-latest', 'o3-deep-research',
  'o4-mini-deep-research', 'computer-use-preview', 'gpt-4o-search-preview', 'gpt-4o-mini-search-preview', 'gpt-4o-audio-preview',
  'gpt-4o-realtime-preview', 'gpt-3.5-turbo-instruct', 'babbage-002', 'davinci-002', 'dall-e-3', 'tts-1-hd', 'sora-2',
  'gpt-daybreak-red-latest', 'gpt-5-search-api'];
const SNAPSHOTS = ['gpt-5-2025-08-07', 'gpt-5-mini-2025-08-07', 'gpt-4o-2024-08-06', 'gpt-4.1-2025-04-14', 'o3-2025-04-16', 'gpt-4-0613'];
const FINE_TUNE = 'ft:gpt-4o-mini-2024-07-18:acme::AbC123';
const FULL_LIST = [...DOCS_TEXT, ...DOCS_DEPRECATED_TEXT, ...NON_CHAT, ...SNAPSHOTS, FINE_TUNE];

const modelsBody = (ids, shutdown = {}) => ({
  object: 'list',
  data: ids.map((id, i) => ({ id, object: 'model', created: 1700000000 + i, owned_by: id.startsWith('ft:') ? 'acme' : 'system', shutdown_date: shutdown[id] ?? null })),
});

// ───────────────────────────── page helpers ─────────────────────────────

async function useOpenAi(page, extra = {}) {
  await page.evaluate(async ({ key, extra }) => {
    const { settings } = await import('/js/core/settings.js');
    settings.set({ provider: 'openai', openai: { apiKey: key, translateModel: 'gpt-6-luna', assistModel: 'gpt-6.1-sol', ...extra } });
  }, { key: KEY, extra });
}

/** complete() in the page; returns the result or { error: {code, message, fatal, model, status, usage, partialText} }. */
const callComplete = (page, opts) => page.evaluate(async (opts) => {
  const { openaiProvider } = await import('/js/ai/openai.js');
  const P = await import('/js/ai/prompts.js');
  const o = { ...opts };
  if (o.json === 'TRANSLATION') o.json = P.TRANSLATION_SCHEMA;
  try {
    return await openaiProvider.complete(o);
  } catch (e) {
    return { error: { code: e.code, message: e.message, fatal: e.fatal, model: e.model ?? null, status: e.status ?? null, usage: e.usage ?? null, partialText: e.partialText ?? null, name: e.name, category: e.category ?? null, streamUnsupported: e.streamUnsupported ?? null } };
  }
}, opts);

/** stream() in the page; returns { events, error }. */
const callStream = (page, opts) => page.evaluate(async (opts) => {
  const { openaiProvider } = await import('/js/ai/openai.js');
  const events = [];
  try {
    for await (const ev of openaiProvider.stream(opts)) events.push(ev);
    return { events, error: null };
  } catch (e) {
    return { events, error: { code: e.code, message: e.message, fatal: e.fatal, model: e.model ?? null, usage: e.usage ?? null, name: e.name } };
  }
}, opts);

const Q = [{ role: 'user', content: 'Q' }];
const hangul = (s) => /[가-힣]/.test(s || '');

// ───────────────────────────── tests ─────────────────────────────

const tests = [
  {
    name: 'complete() JSON on GPT-6 Luna: exact Responses body (developer blocks + cache breakpoint, strict json_schema, effort, token reserve, store:false)',
    fn: async ({ page }) => {
      await useOpenAi(page);
      const answer = { translations: [{ id: 'p1-0', ko: '서론' }] };
      const calls = await recordRoute(page, API, () => ({ json: response({ text: JSON.stringify(answer) }) }));
      const r = await page.evaluate(async () => {
        const { openaiProvider } = await import('/js/ai/openai.js');
        const P = await import('/js/ai/prompts.js');
        const system = P.translationSystem({ meta: { title: 'T', abstract: 'A' } }, { glossary: [{ src: 'delirium', tgt: '섬망' }] });
        const out = await openaiProvider.complete({
          model: 'gpt-6-luna', system,
          messages: [{ role: 'user', content: P.translationUserMessage({ items: [{ sid: 'p1-0', kind: 'heading', text: 'Introduction' }] }) }],
          json: P.TRANSLATION_SCHEMA, maxTokens: 16000, effort: 'low', task: 'translate',
        });
        return { out, system };
      });
      assert.equal(calls.length, 1);
      const c = calls[0];
      assert.equal(c.method, 'POST');
      assert.equal(c.url, 'https://api.openai.com/v1/responses');
      assert.equal(c.headers.authorization, `Bearer ${KEY}`);
      assert.equal(c.headers['content-type'], 'application/json');
      assert.equal(c.headers['openai-organization'], undefined);
      const b = c.body;
      assert.deepEqual(Object.keys(b).sort(), ['input', 'max_output_tokens', 'model', 'prompt_cache_options', 'reasoning', 'store', 'text'].sort());
      assert.equal(b.model, LUNA);
      assert.equal(b.store, false);
      assert.equal(b.max_output_tokens, 16000 + 4000, 'maxTokens + low-effort reasoning reserve');
      assert.deepEqual(b.reasoning, { effort: 'low' });
      assert.deepEqual(b.text, { format: { type: 'json_schema', name: 'answer', schema: TRANSLATION_SCHEMA, strict: true } });
      assert.deepEqual(b.prompt_cache_options, { mode: 'explicit' });
      assert.equal(b.input.length, 2);
      assert.equal(b.input[0].role, 'developer');
      assert.deepEqual(b.input[0].content.map((p) => p.type), ['input_text', 'input_text']);
      assert.equal(b.input[0].content[0].text, r.system[0].text);
      assert.equal(b.input[0].content[0].prompt_cache_breakpoint, undefined, 'rules block: no breakpoint (cache:false)');
      assert.deepEqual(b.input[0].content[1].prompt_cache_breakpoint, { mode: 'explicit' });
      assert.match(b.input[0].content[1].text, /delirium → 섬망/);
      assert.equal(b.input[1].role, 'user');
      assert.equal(b.input[1].content.length, 1);
      assert.equal(b.input[1].content[0].type, 'input_text');
      assert.match(b.input[1].content[0].text, /<s id="p1-0" kind="heading">Introduction<\/s>/);
      assert.equal(b.input[1].content[0].prompt_cache_breakpoint, undefined);
      for (const k of ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'instructions', 'stream', 'messages', 'response_format', 'task']) assert.ok(!(k in b), `unexpected ${k}`);
      assert.deepEqual(r.out.json, answer);
      assert.equal(r.out.stopReason, 'end_turn');
      assert.equal(r.out.model, LUNA);
      assert.deepEqual(r.out.usage, MAPPED_USAGE(LUNA));
      return `POST /v1/responses keys=${Object.keys(b).join(',')}; max_output_tokens=${b.max_output_tokens}; developer[1].prompt_cache_breakpoint=explicit; usage=${JSON.stringify(r.out.usage)}`;
    },
  },
  {
    name: 'older models: GPT-5 mini → effort, prompt_cache_key but no cache options; GPT-4.1 mini → no reasoning, no reserve; image part → input_image data URL; assistant turn → string (phase only on GPT-5.3+)',
    fn: async ({ page }) => {
      await useOpenAi(page);
      const calls = await recordRoute(page, API, (c) => ({ json: response({ model: c.body.model, text: '설명입니다.' }) }));
      const messages = [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }, { type: 'text', text: 'explain this figure' }] },
      ];
      const a = await callComplete(page, { model: 'gpt-5-mini', system: [{ text: 'rules' }, { text: 'paper', cache: true }], messages, maxTokens: 8000, effort: 'medium' });
      const b = await callComplete(page, { model: 'gpt-4.1-mini', system: 'plain system', messages: Q, maxTokens: 8000, effort: 'medium' });
      const o = await callComplete(page, { model: 'o3', system: 'x', messages: Q, maxTokens: 1000, effort: 'high' });
      const pro = await callComplete(page, { model: 'gpt-5.5-pro', system: 'x', messages: Q, maxTokens: 1000, effort: 'low' });
      assert.equal(a.text, '설명입니다.');
      const [ba, bb, bo, bp] = calls.map((c) => c.body);
      assert.deepEqual(ba.reasoning, { effort: 'medium' });
      assert.equal(ba.max_output_tokens, 8000 + 8000);
      assert.ok(!('prompt_cache_options' in ba), 'GPT-5 < 5.6: no explicit cache options');
      assert.ok(ba.input[0].content.every((p) => !('prompt_cache_breakpoint' in p)));
      assert.match(ba.prompt_cache_key, /^pr-[0-9a-f]{8}$/, 'GPT-5 < 5.6: a stable prompt_cache_key for the cached block');
      assert.ok(!('prompt_cache_key' in bb), 'no cache:true block → no prompt_cache_key');
      assert.deepEqual(ba.input.map((m) => m.role), ['developer', 'user', 'assistant', 'user']);
      assert.deepEqual(ba.input[2], { role: 'assistant', content: 'first answer' });
      assert.deepEqual(ba.input[3].content[0], { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'high' });
      assert.deepEqual(ba.input[3].content[1], { type: 'input_text', text: 'explain this figure' });
      assert.ok(!('reasoning' in bb), 'GPT-4.1 is not a reasoning model');
      assert.equal(bb.max_output_tokens, 8000);
      assert.deepEqual(bb.input[0], { role: 'developer', content: [{ type: 'input_text', text: 'plain system' }] });
      assert.deepEqual(bo.reasoning, { effort: 'high' });
      assert.equal(bo.max_output_tokens, 1000 + 16000);
      assert.ok(!('reasoning' in bp), 'pro models: effort left to the model');
      assert.equal(bp.max_output_tokens, 1000 + 16000, 'pro models reason at high effort: high reserve');
      assert.ok(!o.error && !pro.error);
      // Same cached block, another request (another question): same key, so both reach the same cache.
      await callComplete(page, { model: 'gpt-5-mini', system: [{ text: 'rules' }, { text: 'paper', cache: true }], messages: Q, maxTokens: 100 });
      await callComplete(page, { model: 'gpt-5-mini', system: [{ text: 'rules' }, { text: 'another paper', cache: true }], messages: Q, maxTokens: 100 });
      const [same, other] = calls.slice(4).map((c) => c.body.prompt_cache_key);
      assert.equal(same, ba.prompt_cache_key, 'same prefix → same key');
      assert.notEqual(other, ba.prompt_cache_key, 'another paper → another key');
      // GPT-5.3+ assistant turns carry phase 'final_answer' (the reference asks to resend it).
      await callComplete(page, { model: 'gpt-5.5', system: 'x', messages, maxTokens: 100 });
      assert.deepEqual(calls.at(-1).body.input[2], { role: 'assistant', content: 'first answer', phase: 'final_answer' });
      return `gpt-5-mini: effort=medium, max_output_tokens=${ba.max_output_tokens}, no cache options, prompt_cache_key=${ba.prompt_cache_key} (stable per prefix); gpt-4.1-mini: no reasoning, ${bb.max_output_tokens}; o3: ${JSON.stringify(bo.reasoning)}; pro: no reasoning; image=${ba.input[3].content[0].image_url}; gpt-5.5 assistant turn phase=final_answer`;
    },
  },
  {
    name: 'stream(): SSE with event: lines (CRLF) → text deltas only (commentary skipped), done with usage; chat tail gets a cache breakpoint',
    fn: async ({ page }) => {
      await useOpenAi(page);
      const chunks = ['논문에 ', '따르면 ', '감소하였다.'];
      const calls = await recordRoute(page, API, () => ({ contentType: 'text/event-stream', body: streamBody({ chunks, commentary: '(생각 정리 중)', crlf: true }) }));
      const r = await callStream(page, {
        model: SOL, system: [{ text: 'rules' }, { text: 'paper', cache: true }],
        messages: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }],
        maxTokens: 32000, effort: 'medium', cacheMessages: true, json: { type: 'object' },
      });
      assert.equal(r.error, null, JSON.stringify(r.error));
      const b = calls[0].body;
      assert.equal(b.stream, true);
      assert.ok(!('text' in b), 'no json format on streams');
      assert.ok(!('stream_options' in b), 'usage comes with response.completed; no stream option needed');
      assert.equal(b.max_output_tokens, 32000 + 8000);
      assert.deepEqual(b.prompt_cache_options, { mode: 'explicit' });
      assert.deepEqual(b.input[0].content[1].prompt_cache_breakpoint, { mode: 'explicit' });
      assert.equal(b.input[1].content[0].prompt_cache_breakpoint, undefined, 'earlier user turn: no breakpoint');
      assert.deepEqual(b.input[3].content[0], { type: 'input_text', text: 'q2', prompt_cache_breakpoint: { mode: 'explicit' } });
      assert.deepEqual(b.input[2], { role: 'assistant', content: 'a1', phase: 'final_answer' });
      assert.ok(!('prompt_cache_key' in b), 'GPT-5.6+: explicit breakpoints, no prompt_cache_key');
      assert.deepEqual(r.events.filter((e) => e.type === 'text').map((e) => e.text), chunks);
      assert.deepEqual(r.events.at(-1), { type: 'done', usage: MAPPED_USAGE(SOL), stopReason: 'end_turn' });
      return `${r.events.length - 1} text events (commentary dropped) + done ${JSON.stringify(r.events.at(-1).usage)}; breakpoints: paper block + last user turn`;
    },
  },
  {
    name: 'stream(): incomplete → stopReason max_tokens; refusal deltas → refusal; error event / failed → mapped; cut stream → network',
    fn: async ({ page }) => {
      await useOpenAi(page);
      let mode = 'incomplete';
      const bodies = {
        incomplete: () => streamBody({ chunks: ['잘린 ', '답'], final: 'incomplete', reason: 'max_output_tokens' }),
        refusal: () => streamBody({ chunks: [], refusal: "I'm sorry, I cannot assist with that request." }),
        filter: () => streamBody({ chunks: ['a'], final: 'incomplete', reason: 'content_filter' }),
        errorEvent: () => streamBody({ chunks: ['부분'], errorEvent: { code: 'rate_limit_exceeded', message: 'Rate limit reached', param: null }, cut: true }),
        failed: () => streamBody({ chunks: [], final: 'failed', error: { code: 'server_error', message: 'The model failed to generate a response.' } }),
        cut: () => streamBody({ chunks: ['중간에 '], cut: true }),
      };
      await recordRoute(page, API, () => ({ contentType: 'text/event-stream', body: bodies[mode]() }));
      const out = {};
      for (const m of Object.keys(bodies)) {
        mode = m;
        out[m] = await callStream(page, { model: SOL, messages: Q, maxTokens: 1000 });
      }
      assert.equal(out.incomplete.error, null);
      assert.equal(out.incomplete.events.at(-1).stopReason, 'max_tokens');
      assert.equal(out.refusal.error.code, 'refusal');
      assert.deepEqual(out.refusal.error.usage, MAPPED_USAGE(SOL), 'refused answer is billed: usage carried');
      assert.equal(out.filter.error.code, 'refusal');
      assert.equal(out.errorEvent.error.code, 'rate_limit');
      assert.deepEqual(out.errorEvent.events.map((e) => e.text), ['부분'], 'partial text was yielded before the error');
      assert.equal(out.failed.error.code, 'server');
      assert.equal(out.cut.error.code, 'network');
      for (const m of ['refusal', 'filter', 'errorEvent', 'failed', 'cut']) assert.ok(hangul(out[m].error.message), m);
      return Object.entries(out).map(([k, v]) => `${k}→${v.error?.code || v.events.at(-1).stopReason}`).join(', ');
    },
  },
  {
    name: 'complete() response states: refusal part, incomplete JSON (max_tokens + partialText + usage), incomplete text, content_filter, failed, invalid JSON',
    fn: async ({ page }) => {
      await useOpenAi(page);
      let mode = 'refusal';
      const answers = {
        refusal: () => response({ refusal: "I'm sorry, I cannot assist with that request." }),
        cutJson: () => response({ status: 'incomplete', reason: 'max_output_tokens', text: '{"translations":[{"id":"p1-0","ko":"서론"},{"id":"p1' }),
        cutText: () => response({ status: 'incomplete', reason: 'max_output_tokens', text: '긴 요약의 앞부분' }),
        filter: () => response({ status: 'incomplete', reason: 'content_filter', text: '' }),
        failed: () => response({ status: 'failed', error: { code: 'server_error', message: 'The model failed to generate a response.' }, output: [] }),
        badJson: () => response({ text: '{"translations": [' }),
      };
      await recordRoute(page, API, () => ({ json: answers[mode]() }));
      const out = {};
      for (const m of Object.keys(answers)) {
        mode = m;
        out[m] = await callComplete(page, { model: LUNA, messages: Q, maxTokens: 4000, json: m === 'cutText' ? undefined : 'TRANSLATION' });
      }
      assert.equal(out.refusal.error.code, 'refusal');
      assert.deepEqual(out.refusal.error.usage, MAPPED_USAGE(LUNA));
      assert.equal(out.cutJson.error.code, 'max_tokens');
      assert.match(out.cutJson.error.partialText, /^\{"translations":\[\{"id":"p1-0","ko":"서론"\}/);
      assert.deepEqual(out.cutJson.error.usage, MAPPED_USAGE(LUNA));
      assert.equal(out.cutText.error, undefined);
      assert.equal(out.cutText.stopReason, 'max_tokens');
      assert.equal(out.cutText.text, '긴 요약의 앞부분');
      assert.equal(out.filter.error.code, 'refusal');
      assert.equal(out.filter.error.category, 'content_filter');
      assert.equal(out.failed.error.code, 'server');
      assert.equal(out.badJson.error.code, 'parse');
      assert.deepEqual(out.badJson.error.usage, MAPPED_USAGE(LUNA));
      return Object.entries(out).map(([k, v]) => `${k}→${v.error?.code || `text/${v.stopReason}`}`).join(', ');
    },
  },
  {
    name: 'HTTP errors: 401/403/404/model_not_found/429 quota·credit·spend/400/context/invalid_prompt → Korean codes; not_found carries err.model',
    fn: async ({ page }) => {
      await useOpenAi(page);
      let mode = '';
      const cases = {
        badKey: [apiError(401, 'Incorrect API key provided: sk-proj-****0000.', { code: 'invalid_api_key' }), 'auth', true],
        region: [apiError(403, 'Country, region, or territory not supported', { type: 'request_forbidden', code: 'unsupported_country_region_territory' }), 'permission', true],
        verify: [apiError(403, 'Your organization must be verified to use the model `gpt-6-luna`.'), 'not_found', true],
        verifyStream: [apiError(403, 'Your organization must be verified to stream this model.'), 'bad_request', false],
        noAccess: [apiError(403, 'Project `proj_abc` does not have access to model `gpt-6-luna`', { code: 'model_not_found' }), 'not_found', true],
        missing: [apiError(404, 'The model `gpt-6-luna` does not exist or you do not have access to it.', { code: 'model_not_found' }), 'not_found', true],
        missing400: [apiError(400, 'The requested model does not exist.', { code: 'model_not_found', param: 'model' }), 'not_found', true],
        quota: [apiError(429, 'You exceeded your current quota, please check your plan and billing details.', { type: 'insufficient_quota', code: 'insufficient_quota' }), 'billing', true],
        credit: [apiError(429, 'Your organization has no prepaid credits remaining.', { type: 'insufficient_quota', code: 'credit_balance_exhausted' }), 'billing', true],
        spend: [apiError(429, 'Project spend limit reached.', { type: 'insufficient_quota', code: 'project_spend_limit_exceeded' }), 'billing', true],
        bad: [apiError(400, "Unsupported parameter: 'temperature' is not supported with this model.", { param: 'temperature', code: 'unsupported_parameter' }), 'bad_request', false],
        context: [apiError(400, 'Your input exceeds the context window of this model.', { code: 'context_length_exceeded', param: 'input' }), 'bad_request', false],
        flagged: [apiError(400, 'Invalid prompt: your prompt was flagged as potentially violating our usage policy.', { code: 'invalid_prompt' }), 'refusal', false],
      };
      const calls = await recordRoute(page, API, () => cases[mode][0]);
      const out = {};
      for (const m of Object.keys(cases)) {
        mode = m;
        out[m] = (await callComplete(page, { model: LUNA, messages: Q, maxTokens: 1000 })).error;
      }
      for (const [m, [, code, fatal]] of Object.entries(cases)) {
        assert.equal(out[m].code, code, `${m}: ${JSON.stringify(out[m])}`);
        assert.equal(out[m].fatal, fatal, `${m} fatal`);
        assert.ok(hangul(out[m].message), `${m} Korean`);
      }
      for (const m of ['noAccess', 'missing', 'missing400', 'verify']) assert.equal(out[m].model, LUNA, `${m} model`);
      assert.equal(out.verifyStream.streamUnsupported, true, '403 about streaming → stream() falls back to one request');
      assert.match(out.quota.message, /Billing/);
      assert.match(out.quota.message, /platform\.openai\.com/);
      assert.match(out.spend.message, /Limits/);
      assert.match(out.verify.message, /조직 인증/);
      assert.match(out.bad.message, /상세: Unsupported parameter/);
      assert.equal(calls.length, Object.keys(cases).length, 'none of these is retried');
      return Object.entries(out).map(([k, v]) => `${k}→${v.code}`).join(', ') + `; quota: "${out.quota.message.slice(0, 60)}…"`;
    },
  },
  {
    name: 'real API quirk: POST answer unreadable (401 sent without CORS headers → fetch TypeError) → diagnosed via GET /v1/models: auth / not_found / network',
    fn: async ({ page }) => {
      await useOpenAi(page);
      let listMode = 'badkey';
      const seen = [];
      await page.route(API, async (route) => {
        const req = route.request();
        seen.push(`${req.method()} ${new URL(req.url()).pathname}`);
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: CORS, body: 'ok' });
        if (req.method() === 'POST') {
          // api.openai.com answers a bad-key POST with a 401 lacking Access-Control-Allow-Origin (curl, 2026-10-18), which
          // the page sees as a fetch TypeError. Playwright adds CORS headers to fulfilled responses, so the TypeError is
          // produced directly.
          return route.abort('failed');
        }
        if (listMode === 'badkey') {
          return route.fulfill({ status: 401, headers: CORS, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Incorrect API key provided: sk-proj-****0000.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }) });
        }
        return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(modelsBody(['gpt-6.1-sol', 'gpt-5-mini'])) });
      });
      const auth = (await callComplete(page, { model: LUNA, messages: Q, maxTokens: 100 })).error;
      const authStream = (await callStream(page, { model: LUNA, messages: Q, maxTokens: 100 })).error;
      listMode = 'ok';
      const missing = (await callComplete(page, { model: LUNA, messages: Q, maxTokens: 100 })).error;
      const network = (await callComplete(page, { model: 'gpt-5-mini', messages: Q, maxTokens: 100 })).error;
      assert.equal(auth.code, 'auth');
      assert.equal(auth.fatal, true);
      assert.equal(authStream.code, 'auth');
      assert.equal(missing.code, 'not_found');
      assert.equal(missing.model, LUNA);
      assert.equal(network.code, 'network', 'listed model + unreadable POST answer → network');
      const probes = seen.filter((s) => s === 'GET /v1/models').length;
      assert.equal(probes, 4, `one probe per failed POST: ${seen.join(' | ')}`);
      return `POST blocked (no CORS) → probe → ${auth.code}; stream → ${authStream.code}; unlisted model → ${missing.code}(${missing.model}); listed → ${network.code}; requests: ${seen.filter((s) => !s.startsWith('OPTIONS')).join(', ')}`;
    },
  },
  {
    name: 'network failure → network; page CSP without api.openai.com → CSP message (no request leaves)',
    fn: async ({ page }) => {
      await useOpenAi(page);
      const calls = await recordRoute(page, API, () => ({ abort: 'internetdisconnected' }));
      const net = (await callComplete(page, { model: LUNA, messages: Q, maxTokens: 100 })).error;
      const listed = await page.evaluate(async () => {
        const { openaiProvider } = await import('/js/ai/openai.js');
        try { await openaiProvider.listModels(); return null; } catch (e) { return { code: e.code, message: e.message }; }
      });
      const before = calls.length;
      await page.evaluate(() => {
        const meta = document.createElement('meta');
        meta.httpEquiv = 'Content-Security-Policy';
        meta.content = "connect-src 'self' https://api.anthropic.com";
        document.head.append(meta);
      });
      const csp = (await callComplete(page, { model: LUNA, messages: Q, maxTokens: 100 })).error;
      assert.equal(net.code, 'network');
      assert.match(net.message, /인터넷 연결/);
      assert.equal(listed.code, 'network');
      assert.equal(csp.code, 'network');
      assert.match(csp.message, /보안 정책\(CSP\)/);
      assert.match(csp.message, /api\.openai\.com/);
      assert.equal(calls.length, before, 'CSP-blocked request never reaches the network');
      return `offline → "${net.message}"; CSP → "${csp.message.slice(0, 50)}…"`;
    },
  },
  {
    name: 'retries: rate limit with "try again in 0.05s" (×3 then rate_limit), 429→200, 503 overloaded→200, 500×3 → server',
    fn: async ({ page }) => {
      await useOpenAi(page);
      let script = [];
      const calls = await recordRoute(page, API, () => script.shift() || { json: response({ text: 'OK' }) });
      const rate = apiError(429, 'Rate limit reached for gpt-6-luna in organization org-x on tokens per min (TPM): Limit 2000000, Used 1999000, Requested 3000. Please try again in 0.05s.', { type: 'tokens', code: 'rate_limit_exceeded' });
      script = [rate, rate, rate];
      let t = Date.now();
      const exhausted = await callComplete(page, { model: LUNA, messages: Q, maxTokens: 100 });
      const exhaustedMs = Date.now() - t;
      const n1 = calls.length;
      script = [rate];
      const recovered = await callComplete(page, { model: LUNA, messages: Q, maxTokens: 100 });
      const n2 = calls.length - n1;
      script = [apiError(503, 'The model is currently overloaded.', { type: 'service_unavailable_error', code: 'server_is_overloaded' })];
      const overloaded = await callComplete(page, { model: LUNA, messages: Q, maxTokens: 100 });
      const n3 = calls.length - n1 - n2;
      const boom = apiError(500, 'The server had an error while processing your request.', { type: 'server_error' });
      script = [boom, boom, boom];
      t = Date.now();
      const server = await callComplete(page, { model: LUNA, messages: Q, maxTokens: 100 });
      const serverMs = Date.now() - t;
      const n4 = calls.length - n1 - n2 - n3;
      assert.equal(n1, 3);
      assert.equal(exhausted.error.code, 'rate_limit');
      assert.equal(exhausted.error.fatal, false);
      assert.ok(exhaustedMs < 3000, `hinted waits are short (${exhaustedMs} ms)`);
      assert.equal(n2, 2);
      assert.equal(recovered.text, 'OK');
      assert.equal(n3, 2);
      assert.equal(overloaded.text, 'OK');
      assert.equal(n4, 3);
      assert.equal(server.error.code, 'server');
      assert.ok(serverMs >= 2900, `backoff 1 s + 2 s (${serverMs} ms)`);
      return `rate×3→${exhausted.error.code} in ${exhaustedMs} ms; 429→200 (${n2} calls); 503→200 (${n3}); 500×3→${server.error.code} after ${serverMs} ms`;
    },
  },
  {
    name: 'explicit-cache 400 → same request without cache options once, remembered for the model; a genuine 400 fails twice as bad_request',
    fn: async ({ page }) => {
      await useOpenAi(page);
      let genuine = false;
      const calls = await recordRoute(page, API, (c) => {
        if (genuine) return apiError(400, "Invalid value for 'input'.", { param: 'input' });
        return c.body.prompt_cache_options
          ? apiError(400, "Unknown parameter: 'prompt_cache_options'.", { param: 'prompt_cache_options', code: 'unknown_parameter' })
          : { json: response({ model: c.body.model, text: 'OK' }) };
      });
      const opts = { model: SOL, system: [{ text: 'rules' }, { text: 'paper', cache: true }], messages: Q, maxTokens: 100 };
      const first = await callComplete(page, opts);
      const second = await callComplete(page, opts);
      const shapes = calls.map((c) => Boolean(c.body.prompt_cache_options) && c.body.input[0].content.some((p) => p.prompt_cache_breakpoint));
      genuine = true;
      const before = calls.length;
      const bad = await callComplete(page, { ...opts, model: 'gpt-6-astra' });
      assert.equal(first.text, 'OK');
      assert.equal(second.text, 'OK');
      assert.deepEqual(shapes, [true, false, false], 'with → without (fallback) → without (remembered)');
      assert.equal(bad.error.code, 'bad_request');
      assert.equal(calls.length - before, 2, 'a genuinely bad request is sent twice, then reported');
      assert.match(bad.error.message, /상세: Invalid value/);
      return `requests with cache options: ${JSON.stringify(shapes)}; genuine 400 → ${bad.error.code} after 2 requests`;
    },
  },
  {
    name: 'stream refused for an unverified organization (400 param stream) → one non-streaming request, yielded whole; remembered',
    fn: async ({ page }) => {
      await useOpenAi(page);
      const calls = await recordRoute(page, API, (c) => (c.body.stream
        ? apiError(400, 'Your organization must be verified to stream this model. Please go to: https://platform.openai.com/settings/organization/general and click on Verify Organization.', { param: 'stream', code: 'unsupported_value' })
        : { json: response({ model: SOL, text: '스트리밍 없이 받은 답' }) }));
      const a = await callStream(page, { model: SOL, messages: Q, maxTokens: 1000 });
      const b = await callStream(page, { model: SOL, messages: Q, maxTokens: 1000 });
      assert.equal(a.error, null, JSON.stringify(a.error));
      assert.deepEqual(a.events, [{ type: 'text', text: '스트리밍 없이 받은 답' }, { type: 'done', usage: MAPPED_USAGE(SOL), stopReason: 'end_turn' }]);
      assert.deepEqual(b.events, a.events);
      assert.deepEqual(calls.map((c) => Boolean(c.body.stream)), [true, false, false]);
      return `requests stream flags ${JSON.stringify(calls.map((c) => Boolean(c.body.stream)))}; events ${JSON.stringify(a.events.map((e) => e.type))}`;
    },
  },
  {
    name: 'abort: pre-aborted → no request; in-flight complete() and stream() → aborted (no diagnostic probe); consumer break closes the stream',
    fn: async ({ page }) => {
      await useOpenAi(page);
      const calls = await recordRoute(page, API, (c) => (c.body?.stream
        ? { contentType: 'text/event-stream', body: streamBody({ chunks: ['하나 ', '둘 ', '셋'] }) }
        : { json: response({ text: 'late' }), delayMs: 1500 }));
      const r = await page.evaluate(async () => {
        const { openaiProvider } = await import('/js/ai/openai.js');
        const grab = async (fn) => { try { await fn(); return null; } catch (e) { return { code: e.code, name: e.name }; } };
        const pre = new AbortController();
        pre.abort();
        const preC = await grab(() => openaiProvider.complete({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Q' }], signal: pre.signal }));
        const preS = await grab(async () => { for await (const _ of openaiProvider.stream({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Q' }], signal: pre.signal })) { /* none */ } });
        const mid = new AbortController();
        setTimeout(() => mid.abort(), 200);
        const t = performance.now();
        const midC = await grab(() => openaiProvider.complete({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Q' }], signal: mid.signal }));
        const midMs = performance.now() - t;
        const s = new AbortController();
        const got = [];
        const midS = await grab(async () => {
          for await (const ev of openaiProvider.stream({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'Q' }], signal: s.signal })) {
            got.push(ev.text);
            if (got.length === 1) s.abort();
          }
        });
        const kept = [];
        for await (const ev of openaiProvider.stream({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'Q' }] })) {
          kept.push(ev.text);
          if (kept.length === 2) break;
        }
        return { preC, preS, midC, midMs, midS, got, kept };
      });
      assert.deepEqual(r.preC, { code: 'aborted', name: 'AbortError' });
      assert.deepEqual(r.preS, { code: 'aborted', name: 'AbortError' });
      assert.deepEqual(r.midC, { code: 'aborted', name: 'AbortError' });
      assert.ok(r.midMs < 1200, `aborted before the delayed answer (${Math.round(r.midMs)} ms)`);
      assert.deepEqual(r.midS, { code: 'aborted', name: 'AbortError' });
      assert.deepEqual(r.got, ['하나 ']);
      assert.deepEqual(r.kept, ['하나 ', '둘 ']);
      const methods = calls.map((c) => c.method);
      assert.ok(methods.every((m) => m === 'POST'), `no GET /v1/models probe after an abort: ${methods}`);
      assert.equal(calls.length, 3, 'pre-aborted calls sent nothing');
      return `pre-aborted → ${r.preC.code}/${r.preS.code} (0 requests); mid complete → ${r.midC.code} in ${Math.round(r.midMs)} ms; mid stream → ${r.midS.code} after ${JSON.stringify(r.got)}; break after ${r.kept.length} chunks ok`;
    },
  },
  {
    name: 'listModels(): GET /v1/models → text chat models only, newest first, snapshots behind aliases hidden, shutdown dates honoured; testKey()',
    fn: async ({ page }) => {
      await useOpenAi(page);
      const shutdown = { 'gpt-4o': '2099-10-23', 'gpt-4-turbo': '2026-03-01', 'gpt-6-sol': '2099-01-15' };
      const calls = await recordRoute(page, API, () => ({ json: modelsBody(FULL_LIST, shutdown) }));
      const r = await page.evaluate(async () => {
        const { openaiProvider } = await import('/js/ai/openai.js');
        const models = await openaiProvider.listModels();
        return {
          models,
          test: await openaiProvider.testKey(),
          translate: openaiProvider.pickDefaultModel(models, 'translate'),
          assist: openaiProvider.pickDefaultModel(models, 'assist'),
          legacy6sol: openaiProvider.isLegacyModel('gpt-6-sol'),
        };
      });
      const ids = r.models.map((m) => m.id);
      assert.ok(calls.every((c) => c.method === 'GET' && c.url === 'https://api.openai.com/v1/models' && c.headers.authorization === `Bearer ${KEY}`));
      for (const id of NON_CHAT) assert.ok(!ids.includes(id), `non-chat listed: ${id}`);
      for (const id of SNAPSHOTS) assert.ok(!ids.includes(id), `snapshot with alias listed: ${id}`);
      assert.ok(!ids.includes('gpt-4-turbo'), 'past shutdown date → gone');
      assert.ok(ids.includes(FINE_TUNE));
      assert.equal(ids.at(-1), FINE_TUNE);
      assert.deepEqual(ids.slice(0, 7), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
      assert.ok(ids.indexOf('gpt-5.5') < ids.indexOf('gpt-5') && ids.indexOf('gpt-5') < ids.indexOf('gpt-4.1') && ids.indexOf('gpt-4.1') < ids.indexOf('o3'));
      const label = (id) => r.models.find((m) => m.id === id)?.label;
      assert.equal(label('gpt-6-luna'), 'GPT-6 Luna (빠름·저렴)');
      assert.equal(label('gpt-6.1-sol'), 'GPT-6.1 Sol (고품질)');
      assert.equal(label('gpt-6-astra'), 'GPT-6 Astra (최고 품질·비쌈)');
      assert.equal(label('gpt-5-mini'), 'GPT-5 mini (빠름·저렴)');
      assert.equal(label('gpt-4o'), 'GPT-4o (종료 예정 2099-10-23)');
      assert.equal(label('gpt-4.1'), 'GPT-4.1 (이전 세대)');
      assert.equal(label('gpt-6-sol'), 'GPT-6 Sol (종료 예정 2099-01-15)');
      assert.equal(r.legacy6sol, true, 'announced shutdown → legacy');
      assert.equal(r.translate, LUNA);
      assert.equal(r.assist, SOL);
      assert.equal(r.test.ok, true);
      assert.match(r.test.message, /키가 확인되었습니다\(사용 가능한 모델 \d+개\)/);
      assert.equal(r.test.models.length, r.models.length);
      return `${FULL_LIST.length} ids → ${ids.length} chat models; first ${ids.slice(0, 4).join(', ')}; pick translate=${r.translate}, assist=${r.assist}; testKey: "${r.test.message.slice(0, 40)}…"`;
    },
  },
  {
    name: 'default-model picker on realistic lists (current docs, GPT-5 era, 5.6 era, future, snapshots only, legacy only, junk, o-series) + isLegacyModel',
    fn: async ({ page }) => {
      await useOpenAi(page);
      const lists = {
        docs: [...DOCS_TEXT, ...DOCS_DEPRECATED_TEXT, ...NON_CHAT, ...SNAPSHOTS, FINE_TUNE],
        gpt5Era: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-pro', 'gpt-4o', 'gpt-4o-mini', 'o3', 'whisper-1'],
        era56: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5-mini', 'text-embedding-3-small'],
        future: ['gpt-7-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'],
        future2: ['gpt-7-astra', 'gpt-7-sol', 'gpt-7-luna', 'gpt-6.1-sol', 'gpt-6-luna'],
        minor: ['gpt-6.9-luna', 'gpt-6.10-luna', 'gpt-6.9-sol', 'gpt-6.10-sol'],
        snapshotsOnly: ['gpt-5-mini-2025-08-07', 'gpt-5-2025-08-07', 'gpt-5-mini-2025-06-01'],
        legacyOnly: ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo', 'whisper-1', 'dall-e-3'],
        junk: ['whisper-1', 'dall-e-3', 'text-embedding-3-small', 'gpt-image-2', 'gpt-realtime-2.1', 'babbage-002'],
        oSeries: ['o3', 'o3-pro', 'o1'],
        proOnly: ['gpt-5.5-pro'],
        empty: [],
      };
      const r = await page.evaluate(async (lists) => {
        const o = await import('/js/ai/openai.js');
        const picks = {};
        for (const [k, ids] of Object.entries(lists)) {
          picks[k] = { translate: o.pickOpenAiModel(ids.map((id) => ({ id, label: id })), 'translate'), assist: o.pickOpenAiModel(ids, 'assist') };
        }
        const legacy = Object.fromEntries(['gpt-4o', 'gpt-4.1-mini', 'gpt-3.5-turbo', 'gpt-4', 'o1', 'o1-mini', 'o3-mini', 'o4-mini', 'gpt-5.1',
          'gpt-5.4-nano', 'gpt-5.3-codex', 'gpt-5-chat-latest', 'gpt-4.5-preview', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5', 'gpt-5-mini',
          'gpt-5.5', 'gpt-5.4-mini', 'o3', 'o3-pro', 'ft:gpt-4o-mini-2024-07-18:acme::AbC123', 'claude-haiku-5-5', 'mock', '']
          .map((id) => [id, o.openaiProvider.isLegacyModel(id)]));
        const chat = Object.fromEntries(['gpt-6-luna', 'o3', 'gpt-4o-mini-tts', 'gpt-5.6-cyber', 'gpt-5-chat-latest', 'o4-mini-deep-research', 'gpt-image-2', 'gpt-oss-120b']
          .map((id) => [id, o.isChatModel(id)]));
        const snapLabel = o.modelLabel('gpt-5-mini-2025-08-07');
        return { picks, legacy, chat, snapLabel };
      }, lists);
      const expect = {
        docs: { translate: 'gpt-6-luna', assist: 'gpt-6.1-sol' },
        gpt5Era: { translate: 'gpt-5.4-mini', assist: 'gpt-5.5' },
        era56: { translate: 'gpt-5.6-luna', assist: 'gpt-5.6-sol' },
        future: { translate: 'gpt-6-luna', assist: 'gpt-6.1-sol' },
        future2: { translate: 'gpt-7-luna', assist: 'gpt-7-sol' },
        minor: { translate: 'gpt-6.10-luna', assist: 'gpt-6.10-sol' },
        snapshotsOnly: { translate: 'gpt-5-mini-2025-08-07', assist: 'gpt-5-2025-08-07' },
        legacyOnly: { translate: 'gpt-4o-mini', assist: 'gpt-4o' },
        junk: { translate: '', assist: '' },
        oSeries: { translate: 'o3', assist: 'o3' },
        proOnly: { translate: 'gpt-5.5-pro', assist: 'gpt-5.5-pro' },
        empty: { translate: '', assist: '' },
      };
      assert.deepEqual(r.picks, expect);
      const legacyTrue = ['gpt-4o', 'gpt-4.1-mini', 'gpt-3.5-turbo', 'gpt-4', 'o1', 'o1-mini', 'o3-mini', 'o4-mini', 'gpt-5.1', 'gpt-5.4-nano', 'gpt-5.3-codex', 'gpt-5-chat-latest', 'gpt-4.5-preview'];
      for (const [id, v] of Object.entries(r.legacy)) assert.equal(v, legacyTrue.includes(id), `isLegacyModel(${id})`);
      assert.deepEqual(r.chat, { 'gpt-6-luna': true, o3: true, 'gpt-4o-mini-tts': false, 'gpt-5.6-cyber': false, 'gpt-5-chat-latest': false, 'o4-mini-deep-research': false, 'gpt-image-2': false, 'gpt-oss-120b': false });
      assert.equal(r.snapLabel, 'GPT-5 mini (스냅숏 2025-08-07 · 빠름·저렴)');
      return Object.entries(r.picks).map(([k, v]) => `${k}: ${v.translate || '∅'} / ${v.assist || '∅'}`).join('; ');
    },
  },
  {
    name: 'missing key → no_key without a request (complete/stream/listModels/testKey); missing model → bad_request',
    fn: async ({ page }) => {
      await useOpenAi(page, { apiKey: '' });
      const calls = await recordRoute(page, API, () => ({ json: {} }));
      const r = await page.evaluate(async () => {
        const { openaiProvider } = await import('/js/ai/openai.js');
        const grab = async (fn) => { try { await fn(); return null; } catch (e) { return { code: e.code, message: e.message, fatal: e.fatal }; } };
        const complete = await grab(() => openaiProvider.complete({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Q' }] }));
        const stream = await grab(async () => { for await (const _ of openaiProvider.stream({ model: 'gpt-6-luna', messages: [] })) { /* none */ } });
        const list = await grab(() => openaiProvider.listModels());
        const test = await openaiProvider.testKey();
        const { settings } = await import('/js/core/settings.js');
        settings.set({ openai: { apiKey: 'sk-proj-test-0000' } });
        const noModel = await grab(() => openaiProvider.complete({ model: '', messages: [{ role: 'user', content: 'Q' }] }));
        return { complete, stream, list, test, noModel };
      });
      for (const k of ['complete', 'stream', 'list']) {
        assert.equal(r[k].code, 'no_key', k);
        assert.equal(r[k].fatal, true);
        assert.match(r[k].message, /OpenAI API 키가 없습니다/);
      }
      assert.equal(r.test.ok, false);
      assert.match(r.test.message, /API 키가 없습니다/);
      assert.equal(r.noModel.code, 'bad_request');
      assert.equal(calls.length, 0);
      return `no_key ×3 + testKey "${r.test.message}"; empty model → ${r.noModel.code}; 0 requests`;
    },
  },
  {
    name: 'testKey(): bad key (GET /v1/models 401) → ok:false with a Korean message; key with no chat models → ok:false',
    fn: async ({ page }) => {
      await useOpenAi(page);
      let mode = 'bad';
      await recordRoute(page, API, () => (mode === 'bad'
        ? apiError(401, 'Incorrect API key provided: sk-proj-****0000.', { code: 'invalid_api_key' })
        : { json: modelsBody(['whisper-1', 'dall-e-3', 'text-embedding-3-small']) }));
      const run = () => page.evaluate(async () => (await import('/js/ai/openai.js')).openaiProvider.testKey());
      const bad = await run();
      mode = 'empty';
      const empty = await run();
      assert.equal(bad.ok, false);
      assert.match(bad.message, /OpenAI API 키가 올바르지 않습니다/);
      assert.equal(empty.ok, false);
      assert.match(empty.message, /GPT 텍스트 모델이 없습니다/);
      return `bad → "${bad.message}"; empty → "${empty.message.slice(0, 40)}…"`;
    },
  },
  {
    name: 'Translator end to end through openaiProvider (routed): every translatable sentence done, stable cached developer prefix, strict schema',
    fn: async ({ page }) => {
      await useOpenAi(page);
      const calls = await recordRoute(page, API, (c) => {
        const user = c.body.input.findLast((m) => m.role === 'user').content.map((p) => p.text).join('\n');
        const { items } = parseTranslationUserMessage(user);
        const json = { translations: items.map((it) => ({ id: it.sid, ko: `〔번역〕 ${it.text}` })) };
        return { json: response({ model: c.body.model, text: JSON.stringify(json) }) };
      });
      const r = await page.evaluate(async () => {
        const { Translator } = await import('/js/ai/translator.js');
        const { openaiProvider } = await import('/js/ai/openai.js');
        const { buildSyntheticDoc } = await import('/tests/ai/synth.js');
        const doc = buildSyntheticDoc({ pages: 4 });
        const t = new Translator({ doc, provider: openaiProvider, save: async () => {} });
        const progress = await t.translateAll();
        return { progress, sample: [...t.translations.entries()].slice(0, 2) };
      });
      assert.ok(calls.length >= 2, `${calls.length} batches`);
      assert.equal(r.progress.done, r.progress.total);
      assert.equal(r.progress.failed, 0);
      const prefix = JSON.stringify(calls[0].body.input[0]);
      assert.ok(calls.every((c) => JSON.stringify(c.body.input[0]) === prefix), 'identical developer message for every batch');
      assert.ok(calls.every((c) => c.body.model === LUNA && c.body.reasoning?.effort === 'low' && c.body.text.format.strict === true && c.body.store === false));
      assert.ok(calls.every((c) => c.body.input[0].content.filter((p) => p.prompt_cache_breakpoint).length === 1));
      return `${calls.length} batches, ${r.progress.done}/${r.progress.total} done; sample ${JSON.stringify(r.sample[0]).slice(0, 80)}`;
    },
  },
];

// ───────────────────────────── runner (port 8171) ─────────────────────────────

async function isUp() {
  try {
    return (await fetch(`${ORIGIN}/tests/ai/harness.html`)).ok;
  } catch {
    return false;
  }
}

async function startServer() {
  if (await isUp()) return () => {};
  const proc = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: REPO_ROOT, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 50 && !(await isUp()); i++) await new Promise((r) => setTimeout(r, 100));
  if (!(await isUp())) throw new Error('static server did not start');
  return () => proc.kill();
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stop = await startServer();
  const browser = await chromium.launch({ channel: 'msedge' });
  const results = [];
  const logLines = [];
  try {
    for (const t of tests) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const consoleLines = [];
      page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
      page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
      const started = Date.now();
      let result;
      try {
        await page.goto(`${ORIGIN}/tests/ai/harness.html`);
        await page.waitForFunction(() => window.__harnessReady === true);
        const evidence = await t.fn({ page, context });
        result = { name: t.name, result: 'pass', evidence: String(evidence ?? 'ok'), ms: Date.now() - started };
      } catch (err) {
        result = { name: t.name, result: 'fail', evidence: String(err?.stack || err), ms: Date.now() - started };
      }
      results.push(result);
      const mark = result.result === 'pass' ? 'PASS' : 'FAIL';
      console.log(`${mark} openai › ${t.name} (${result.ms} ms)\n     ${result.evidence}`);
      if (result.result !== 'pass' && consoleLines.length) console.log(`     console:\n       ${consoleLines.slice(-15).join('\n       ')}`);
      logLines.push(`${mark} ${t.name}`, ...consoleLines.map((l) => `    ${l}`));
      await context.close();
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(OUT_DIR, 'openai.results.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'openai.log'), logLines.join('\n'));
  const failed = results.filter((r) => r.result !== 'pass').length;
  console.log(`\nopenai: ${results.length - failed}/${results.length} passed`);
  return failed;
}

process.exitCode = (await run()) ? 1 : 0;
