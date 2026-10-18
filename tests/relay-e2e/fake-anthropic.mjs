// Fake api.anthropic.com for tests/relay-e2e: the local relay Worker forwards the paper reader's real requests here.
// Never talks to the real Anthropic API.
//   - translation batches (output_config.format with the translations schema) → schema-valid Korean JSON, one entry
//     per <s id> of the batch: "〔중계 번역〕 " + the English source (numbers kept, so no fidelity warnings);
//   - other non-streaming requests (요약) → the six-heading Korean Markdown summary citing sentence ids of the paper;
//   - streaming requests (채팅) → a Korean answer as SSE, one delta every `control.streamDelayMs`.
// Usage is estimated from the text (≈ 4 characters per input token, 2 per output token, caching ignored) so the
// relay's budgets see realistic numbers. `control.extraInputTokens` is added to translation batches to reach a small
// daily limit within a few batches. Every call is recorded with its reported usage and its price.
import http from 'node:http';
import { parseTranslationUserMessage } from '../../js/ai/prompts.js';
import { costUsd } from '../../relay/src/pricing.js';
import { sseText } from '../../relay/test/fake-upstream.mjs';

export const TRANSLATION_PREFIX = '〔중계 번역〕 ';
export const SUMMARY_HEADINGS = ['한 줄 요약', '연구 목적', '연구 방법', '주요 결과', '제한점', '임상·연구적 시사점'];
const CHAT_PARTS = ['중계 서버를 ', '거친 답변입니다. ', '이 연구는 ', '중환자실 간호사를 ', '대상으로 ', '수행되었습니다', '{cite}.'];

/**
 * @typedef {{ n: number, at: number, method: string, path: string, search: string, headers: Record<string, string>,
 *             body: any, kind: 'translate' | 'summary' | 'chat' | 'other', model: string, ids: string[],
 *             parts: string[] | null, text: string, usage: { input_tokens: number, output_tokens: number },
 *             usd: number, closedEarly: boolean }} FakeCall
 *   `parts`: the streamed deltas (chat only); `usd`: the price of `usage` with the relay's own price table.
 */

/**
 * @param {{ port: number }} opts
 * @returns {Promise<{ url: string, calls: FakeCall[], control: { latencyMs: number, streamDelayMs: number,
 *   extraInputTokens: number }, close(): Promise<void> }>}
 */
export async function startFakeAnthropic({ port }) {
  const control = { latencyMs: 120, streamDelayMs: 60, extraInputTokens: 0 };
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://fake');
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `fake: no ${req.method} ${url.pathname}` } }));
      return;
    }
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
    const call = describe(body, control);
    Object.assign(call, {
      n: calls.length + 1, at: Date.now(), method: req.method, path: url.pathname, search: url.search,
      headers: { ...req.headers }, body, closedEarly: false,
    });
    calls.push(call);
    res.on('close', () => { if (!res.writableEnded) call.closedEarly = true; });
    try {
      if (body?.stream) await streamReply(call, res, control);
      else await jsonReply(call, res, control);
    } catch (err) {
      console.error('[fake-anthropic] reply failed', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"api_error","message":"fake reply failed"}}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    control,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** Kind, answer text and usage of one request. */
function describe(body, control) {
  const model = String(body?.model || 'claude-haiku-5-5');
  const system = systemText(body?.system);
  const user = lastUserText(body?.messages);
  const inputChars = system.length + (body?.messages || []).reduce((n, m) => n + contentText(m.content).length, 0);
  const schema = body?.output_config?.format?.schema;
  let kind = 'other';
  let ids = [];
  let parts = null;
  let text;
  if (schema?.properties?.translations) {
    kind = 'translate';
    const { items } = parseTranslationUserMessage(user);
    ids = items.map((it) => it.sid);
    text = JSON.stringify({ translations: items.map((it) => ({ id: it.sid, ko: `${TRANSLATION_PREFIX}${it.text}` })) });
  } else if (body?.stream) {
    kind = 'chat';
    const cite = paperIds(system)[3];
    parts = CHAT_PARTS.map((p) => p.replace('{cite}', cite ? ` [${cite}]` : ''));
    text = parts.join('');
  } else if (!schema) {
    kind = 'summary';
    text = summaryMarkdown(paperIds(system));
  } else {
    text = JSON.stringify({ items: [] });
  }
  const usage = {
    input_tokens: Math.ceil(inputChars / 4) + (kind === 'translate' ? control.extraInputTokens : 0),
    output_tokens: Math.ceil(text.length / 2),
  };
  const usd = costUsd({ model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
  return { kind, model, ids, parts, text, usage, usd };
}

async function jsonReply(call, res, control) {
  await sleep(control.latencyMs);
  const message = {
    id: `msg_e2e_${call.n}`, type: 'message', role: 'assistant', model: call.model,
    content: [{ type: 'text', text: call.text }], stop_reason: 'end_turn', stop_sequence: null, usage: call.usage,
  };
  res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_e2e_${call.n}` });
  res.end(JSON.stringify(message));
}

async function streamReply(call, res, control) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'request-id': `req_e2e_${call.n}` });
  const write = (name, data) => { if (!res.destroyed) res.write(sseText([[name, data]])); };
  write('message_start', { type: 'message_start', message: {
    id: `msg_e2e_${call.n}`, type: 'message', role: 'assistant', model: call.model, content: [], stop_reason: null,
    stop_sequence: null, usage: { input_tokens: call.usage.input_tokens, output_tokens: 1 },
  } });
  write('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const text of call.parts || [call.text]) {
    await sleep(control.streamDelayMs);
    write('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  }
  write('content_block_stop', { type: 'content_block_stop', index: 0 });
  write('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: call.usage.output_tokens } });
  write('message_stop', { type: 'message_stop' });
  res.end();
}

function summaryMarkdown(ids) {
  const c = (i) => (ids.length ? ` [${ids[Math.min(i, ids.length - 1)]}]` : '');
  const lines = [
    '이 논문은 중환자실 간호사의 업무를 조사한 연구이다(중계 서버 테스트 요약)',
    '연구의 배경과 목적을 설명한다',
    '횡단적 조사연구 설계를 사용하였다',
    '주요 결과는 **41%**에서 통계적으로 유의하였다(p < .05)',
    '저자들이 밝힌 제한점을 정리한다',
    '간호 실무에 대한 시사점을 제시한다',
  ];
  return SUMMARY_HEADINGS.map((h, i) => `## ${h}\n${i ? '- ' : ''}${lines[i]}${c(i)}.`).join('\n\n');
}

/** Sentence ids of the paper text in the system prompt ("[p3-12] …" lines), in order. */
function paperIds(system) {
  return [...new Set([...system.matchAll(/^\[(p\d+-\d+)\]/gm)].map((m) => m[1]))];
}

function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => b?.text || '').join('\n');
}

function contentText(content) {
  if (typeof content === 'string') return content;
  return (content || []).map((p) => (p?.type === 'text' ? p.text : '')).join('\n');
}

function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return contentText(messages[i].content);
  }
  return '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
