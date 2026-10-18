// Passes an upstream Messages API response body through unchanged while reading its token usage.
// Streams (SSE) are forwarded chunk by chunk as they arrive; nothing is buffered on the way to the client.

/** A JSON body larger than this is still forwarded, but its usage is not read (Messages replies are far smaller). */
const MAX_JSON_CHARS = 16 * 1024 * 1024;
const USAGE_EVENTS = new Set(['message_start', 'message_delta']);

/**
 * @typedef {import('./pricing.js').UsagePart} UsagePart
 * @typedef {{ model: string, parts: UsagePart[], complete: boolean }} MeterResult
 *   `parts` has one entry per billed attempt (several after a server-side refusal fallback);
 *   `complete` is false when the stream was cut off (client went away, upstream error).
 */

/**
 * @param {ReadableStream<Uint8Array>} body upstream response body
 * @param {string} contentType upstream content-type
 * @param {string} requestedModel used when the reply names no model
 * @returns {{ body: ReadableStream<Uint8Array>, finished: Promise<MeterResult | null> }}
 */
export function meterBody(body, contentType, requestedModel) {
  const meter = /text\/event-stream/i.test(contentType || '') ? new SseMeter() : new JsonMeter();
  const decoder = new TextDecoder();
  const feed = (text) => {
    try {
      meter.push(text);
    } catch (err) {
      console.error('[relay] usage meter failed', err); // never break the passthrough over accounting
    }
  };
  const { readable, writable } = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      feed(decoder.decode(chunk, { stream: true }));
    },
    flush() {
      feed(decoder.decode());
    },
  });
  const finished = body.pipeTo(writable).then(() => true, () => false).then((complete) => {
    try {
      return meter.result(requestedModel, complete);
    } catch (err) {
      console.error('[relay] usage meter failed', err);
      return null;
    }
  });
  return { body: readable, finished };
}

/** Collects a JSON body and reads `model` + `usage` at the end. */
class JsonMeter {
  constructor() {
    this.text = '';
    this.overflow = false;
  }

  push(text) {
    if (this.overflow) return;
    this.text += text;
    if (this.text.length > MAX_JSON_CHARS) {
      this.overflow = true;
      this.text = '';
    }
  }

  result(requestedModel, complete) {
    if (this.overflow || !this.text) return null;
    let message;
    try {
      message = JSON.parse(this.text);
    } catch {
      return null;
    }
    if (!message || typeof message !== 'object' || !message.usage) return null;
    const model = message.model || requestedModel;
    return { model, parts: usageParts(model, message.usage), complete };
  }
}

/**
 * Reads `message_start.message.usage` and the last `message_delta.usage` out of an SSE stream. Only those two
 * event types are JSON-parsed (the many content deltas are skipped by name), keeping CPU time per stream low.
 */
class SseMeter {
  constructor() {
    this.buffer = '';
    this.model = '';
    this.usage = null;
  }

  push(text) {
    this.buffer += text;
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.onEvent(block);
    }
  }

  onEvent(block) {
    let name = '';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (name ? !USAGE_EVENTS.has(name) : !/"type"\s*:\s*"message_(start|delta)"/.test(data.join(''))) return;
    let event;
    try {
      event = JSON.parse(data.join('\n'));
    } catch {
      return;
    }
    if (event?.type === 'message_start' && event.message) {
      this.model = event.message.model || this.model;
      this.usage = { ...(event.message.usage || {}) };
    } else if (event?.type === 'message_delta' && event.usage) {
      // message_delta carries cumulative counts; any field it reports replaces the message_start value.
      this.usage ||= {};
      for (const [k, v] of Object.entries(event.usage)) if (v != null) this.usage[k] = v;
    }
  }

  result(requestedModel, complete) {
    if (this.buffer.trim()) this.onEvent(this.buffer);
    this.buffer = '';
    if (!this.usage) return null;
    const model = this.model || requestedModel;
    return { model, parts: usageParts(model, this.usage), complete };
  }
}

/**
 * Billed attempts of one reply. With a server-side refusal fallback, `usage.iterations` lists every attempt (each
 * billed at its own model's rates) while the top-level usage covers only the attempt that produced the reply.
 * @returns {UsagePart[]}
 */
export function usageParts(model, usage) {
  const iterations = Array.isArray(usage?.iterations) ? usage.iterations : [];
  if (iterations.length > 1) return iterations.map((it) => toPart(it?.model || model, it || {}));
  return [toPart(model, usage || {})];
}

function toPart(model, u) {
  return {
    model,
    inputTokens: count(u.input_tokens),
    outputTokens: count(u.output_tokens),
    cacheReadTokens: count(u.cache_read_input_tokens),
    cacheWriteTokens: count(u.cache_creation_input_tokens),
  };
}

function count(v) {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}
