// In-process fake of api.anthropic.com for relay tests. Records every request (method, url, headers, raw body)
// and answers with canned JSON or SSE. Never talks to the real Anthropic API.
//
//   const fake = await startFakeUpstream({ port: 8788 });
//   fake.reply(jsonReply(text));            // next request gets exactly these bytes
//   fake.reply(sseReply(events, { holdAfter: 2, until: promise }));
//   fake.requests                            // [{ method, url, headers, raw, body, at }]
import http from 'node:http';

/** SSE wire text for [eventName, data] pairs, as Anthropic sends it. */
export function sseText(events) {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** A canned non-streaming Message (JSON object). */
export function message({ model = 'claude-haiku-5-5', text = 'OK', usage = {}, ...over } = {}) {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
    ...over,
  };
}

/** Canned stream events: message_start (with usage), text deltas, message_delta (final usage), message_stop. */
export function streamEvents({ model = 'claude-sonnet-5-5', chunks = ['안녕', '하세요'], startUsage = {}, deltaUsage = {} } = {}) {
  return [
    ['message_start', { type: 'message_start', message: {
      id: 'msg_fake_s', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0, ...startUsage },
    } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['ping', { type: 'ping' }],
    ...chunks.map((text) => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }]),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 42, ...deltaUsage } }],
    ['message_stop', { type: 'message_stop' }],
  ];
}

/** Handler answering with exactly `text` (default: JSON 200 with Anthropic-like headers). */
export function jsonReply(text, { status = 200, headers = {} } = {}) {
  return (call, res) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'request-id': 'req_fake_json',
      'anthropic-organization-id': 'org-secret-should-not-leak',
      ...headers,
    });
    res.end(text);
  };
}

/**
 * Handler streaming `events` as SSE. With `holdAfter`, writes that many events, then waits for `until` (a promise)
 * before writing the rest; `onHold` / `onEnd` report progress; the socket closing early ends the wait.
 */
export function sseReply(events, { holdAfter = 0, until = null, onHold = null, onEnd = null, onClose = null, end = true } = {}) {
  return async (call, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'request-id': 'req_fake_sse',
      'anthropic-organization-id': 'org-secret-should-not-leak',
    });
    let closed = false;
    res.on('close', () => {
      closed = true;
      onClose?.(Date.now());
    });
    const texts = events.map((e) => sseText([e]));
    const first = holdAfter ? texts.slice(0, holdAfter) : texts;
    for (const t of first) res.write(t);
    if (holdAfter) {
      onHold?.(Date.now());
      await Promise.race([until, new Promise((r) => res.on('close', r))]);
      if (!closed) for (const t of texts.slice(holdAfter)) res.write(t);
    }
    if (end && !closed) res.end();
    onEnd?.(Date.now(), closed);
  };
}

/** Default answer: a small Message (or stream) for whatever model was asked for. */
function defaultReply(call, res) {
  const model = call.body?.model || 'claude-haiku-5-5';
  if (call.body?.stream) return sseReply(streamEvents({ model, startUsage: { cache_read_input_tokens: 0 } }))(call, res);
  return jsonReply(JSON.stringify(message({ model })))(call, res);
}

/**
 * @param {{ port: number }} opts
 * @returns {Promise<{ url: string, requests: object[], reply(handler: Function): void, reset(): void, close(): Promise<void> }>}
 */
export async function startFakeUpstream({ port }) {
  const requests = [];
  const queue = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    const call = { method: req.method, url: req.url, headers: { ...req.headers }, raw, body, at: Date.now() };
    requests.push(call);
    const handler = queue.shift() || defaultReply;
    try {
      await handler(call, res);
    } catch (err) {
      console.error('[fake-upstream] handler failed', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"api_error","message":"fake handler failed"}}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reply(handler) { queue.push(handler); },
    reset() { requests.length = 0; queue.length = 0; },
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
