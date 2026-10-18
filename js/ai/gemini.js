// Gemini provider over the REST API (no SDK). Key is sent as the x-goog-api-key header, never in the URL.
import { settings } from '../core/settings.js';
import { sleep } from '../core/util.js';
import { aiError, throwIfAborted } from './providers.js';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MAX_TOKENS = 16000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 20_000;
const REFUSAL_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);
// Keywords of the OpenAPI 3.0 subset that responseSchema accepts.
const SCHEMA_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'properties', 'required', 'items',
  'minItems', 'maxItems', 'minimum', 'maximum', 'propertyOrdering', 'anyOf']);

/**
 * JSON Schema → Gemini responseSchema: drop additionalProperties and other unsupported keywords, upper-case type
 * names, ["string","null"] → { type: 'STRING', nullable: true }, and pin property order to the schema's order.
 */
export function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(key)) continue;
    if (key === 'type') {
      const types = Array.isArray(value) ? value : [value];
      const main = types.find((t) => t !== 'null') || 'string';
      out.type = String(main).toUpperCase();
      if (types.includes('null')) out.nullable = true;
    } else if (key === 'properties') {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)]));
    } else if (key === 'items' || key === 'anyOf') {
      out[key] = toGeminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  if (out.type === 'OBJECT' && out.properties && !out.propertyOrdering) out.propertyOrdering = Object.keys(out.properties);
  return out;
}

/** Provider-neutral options → generateContent request body (exported for tests). */
export function buildBody({ system, messages, json, maxTokens }) {
  const body = { contents: (messages || []).map(toContent) };
  const sys = systemText(system);
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };
  const generationConfig = { maxOutputTokens: maxTokens || DEFAULT_MAX_TOKENS };
  if (json) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = toGeminiSchema(json);
  }
  body.generationConfig = generationConfig;
  return body;
}

export const geminiProvider = {
  id: 'gemini',
  label: 'Gemini (Google)',

  async complete(opts) {
    throwIfAborted(opts.signal);
    const model = modelId(opts.model);
    const res = await request(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', body: buildBody(opts), signal: opts.signal, model,
    });
    const data = await res.json().catch((err) => {
      throw aiError('Gemini 응답을 읽지 못했습니다. 다시 시도해 주세요.', { code: 'parse', cause: err });
    });
    return readResponse(data, { model, json: Boolean(opts.json) });
  },

  async *stream(opts) {
    throwIfAborted(opts.signal);
    const model = modelId(opts.model);
    const res = await request(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST', body: buildBody({ ...opts, json: undefined }), signal: opts.signal, model,
    });
    let usageMeta = null;
    let finishReason = null;
    try {
      for await (const chunk of readSse(res.body)) {
        if (chunk.error) throw httpErrorFromBody(chunk.error.code || 500, { error: chunk.error }, model);
        if (chunk.promptFeedback?.blockReason) throw blockedError(chunk.promptFeedback.blockReason);
        const cand = chunk.candidates?.[0];
        const text = partsText(cand);
        if (text) yield { type: 'text', text };
        if (cand?.finishReason) finishReason = cand.finishReason;
        if (chunk.usageMetadata) usageMeta = chunk.usageMetadata;
      }
    } catch (err) {
      throw toKoreanNetworkError(err, opts.signal);
    }
    if (REFUSAL_REASONS.has(finishReason)) throw blockedError(finishReason);
    yield { type: 'done', usage: toUsage(usageMeta, model), stopReason: stopReasonOf(finishReason) };
  },

  async listModels() {
    const out = [];
    let pageToken = '';
    do {
      const url = `${GEMINI_BASE}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await request(url, { method: 'GET' });
      const data = await res.json().catch((err) => {
        throw aiError('Gemini 모델 목록을 읽지 못했습니다. 다시 시도해 주세요.', { code: 'parse', cause: err });
      });
      for (const m of data.models || []) {
        if (!(m.supportedGenerationMethods || []).includes('generateContent')) continue;
        const id = String(m.name || '').replace(/^models\//, '');
        if (id) out.push({ id, label: m.displayName ? `${m.displayName} (${id})` : id });
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return out;
  },

  async testKey() {
    try {
      const models = await geminiProvider.listModels();
      return { ok: true, message: `Gemini API 키가 확인되었습니다(사용 가능한 모델 ${models.length}개).` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },
};

// ───────────────────────────── HTTP ─────────────────────────────

function apiKey() {
  const key = String(settings.get().gemini?.apiKey || '').trim();
  if (!key) throw aiError('Gemini API 키가 없습니다. 설정에서 API 키를 입력해 주세요.', { code: 'no_key' });
  return key;
}

function modelId(model) {
  const id = String(model || '').replace(/^models\//, '');
  if (!id) throw aiError('Gemini 모델이 선택되지 않았습니다. 설정에서 모델을 선택해 주세요.', { code: 'bad_request' });
  return id;
}

/** fetch with Korean errors; retries 5xx and short 429 waits (per-minute limits) up to MAX_ATTEMPTS. */
async function request(url, { method, body, signal, model }) {
  const key = apiKey();
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'x-goog-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err) {
      throw toKoreanNetworkError(err, signal);
    }
    if (res.ok) return res;
    const data = await res.json().catch(() => null);
    const err = httpErrorFromBody(res.status, data, model);
    const wait = retryDelayMs(res.status, data, attempt);
    if (attempt >= MAX_ATTEMPTS || wait == null) throw err;
    console.warn('[ai] Gemini', res.status, `retrying in ${wait} ms`);
    await abortableSleep(wait, signal);
  }
}

function retryDelayMs(status, data, attempt) {
  if (status >= 500) return 1000 * 2 ** (attempt - 1);
  if (status !== 429) return null;
  const info = (data?.error?.details || []).find((d) => String(d['@type'] || '').endsWith('RetryInfo'));
  const seconds = parseFloat(String(info?.retryDelay || ''));
  if (!Number.isFinite(seconds)) return null; // daily quota exhausted: retrying now cannot help
  const ms = Math.ceil(seconds * 1000);
  return ms <= MAX_RETRY_DELAY_MS ? ms : null;
}

function httpErrorFromBody(status, data, model) {
  const e = data?.error || {};
  const reasons = (e.details || []).map((d) => d.reason).filter(Boolean);
  const make = (message, code) => {
    console.warn('[ai] Gemini error', status, e.status || '', e.message || '');
    return aiError(message, { code, status });
  };
  if (reasons.includes('API_KEY_INVALID') || status === 401) {
    return make('Gemini API 키가 올바르지 않습니다. 설정에서 키를 다시 확인해 주세요.', 'auth');
  }
  if (status === 403) {
    return make('이 API 키로 Gemini API를 사용할 권한이 없습니다. Google AI Studio에서 키와 API 사용 설정을 확인해 주세요.', 'permission');
  }
  if (status === 404) {
    return make(`Gemini 모델을 찾을 수 없습니다${model ? `(${model})` : ''}. 설정에서 모델을 다시 선택해 주세요.`, 'not_found');
  }
  if (status === 429) {
    return make('Gemini 사용 한도를 초과했습니다. 무료 등급은 하루 요청 수(일일 할당량)와 분당 요청 수가 제한되어 있어, 일일 할당량을 다 쓰면 다음 날(태평양 시간 자정) 초기화될 때까지 기다려야 합니다. 잠시 후 다시 시도하거나 동시 번역 수를 줄여 주세요.', 'quota');
  }
  if (status >= 500) return make('Gemini 서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.', 'server');
  if (status === 400) {
    return make(`Gemini가 요청을 처리할 수 없습니다(잘못된 요청).${e.message ? ` 상세: ${e.message}` : ''}`, 'bad_request');
  }
  return make(`Gemini API 오류가 발생했습니다(HTTP ${status}).`, 'unknown');
}

function toKoreanNetworkError(err, signal) {
  if (err?.name === 'AiError') return err;
  if (signal?.aborted || err?.name === 'AbortError') return aiError('요청을 취소했습니다.', { code: 'aborted', cause: err });
  console.warn('[ai] Gemini network error', err);
  return aiError('Gemini 서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.', { code: 'network', cause: err });
}

/** Parse a text/event-stream body into JSON payloads of its `data:` lines. */
async function* readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = done ? '' : events.pop();
      for (const ev of events) {
        const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        try {
          yield JSON.parse(data);
        } catch (err) {
          console.warn('[ai] Gemini: unparsable SSE chunk', data.slice(0, 120), err);
        }
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

// ───────────────────────────── responses ─────────────────────────────

function readResponse(data, { model, json }) {
  if (data?.promptFeedback?.blockReason) throw blockedError(data.promptFeedback.blockReason);
  const cand = data?.candidates?.[0];
  const usage = toUsage(data?.usageMetadata, model);
  if (!cand) throw aiError('Gemini가 빈 응답을 반환했습니다. 다시 시도해 주세요.', { code: 'unknown', usage });
  if (REFUSAL_REASONS.has(cand.finishReason)) throw blockedError(cand.finishReason, usage);
  const text = partsText(cand);
  const stopReason = stopReasonOf(cand.finishReason);
  if (stopReason === 'max_tokens' && json) {
    throw aiError('응답이 최대 길이에 도달해 잘렸습니다. 더 작은 단위로 나누어 다시 요청합니다.', {
      code: 'max_tokens', usage, partialText: text,
    });
  }
  const out = { text, usage, stopReason, model };
  if (json) {
    try {
      out.json = JSON.parse(text);
    } catch (err) {
      console.warn('[ai] Gemini returned invalid JSON', text.slice(0, 200));
      throw aiError('AI 응답(JSON)을 해석하지 못했습니다. 다시 시도해 주세요.', { code: 'parse', usage, cause: err });
    }
  }
  return out;
}

function partsText(cand) {
  return (cand?.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
}

function stopReasonOf(finishReason) {
  if (finishReason === 'MAX_TOKENS') return 'max_tokens';
  if (REFUSAL_REASONS.has(finishReason)) return 'refusal';
  return 'end_turn';
}

function blockedError(reason, usage) {
  return aiError(`Gemini가 안전 정책에 따라 응답을 차단했습니다(${reason}). 내용을 바꾸거나 다른 모델로 다시 시도해 주세요.`, {
    code: 'refusal', category: reason, usage,
  });
}

/** Gemini usageMetadata → provider-neutral usage. Thinking tokens are billed as output. */
function toUsage(meta, model) {
  const m = meta || {};
  const cached = m.cachedContentTokenCount || 0;
  return {
    model,
    inputTokens: Math.max(0, (m.promptTokenCount || 0) - cached),
    outputTokens: (m.candidatesTokenCount || 0) + (m.thoughtsTokenCount || 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

function toContent(m) {
  const role = m.role === 'assistant' ? 'model' : 'user';
  if (typeof m.content === 'string') return { role, parts: [{ text: m.content }] };
  return {
    role,
    parts: (m.content || []).map((p) => (p.type === 'image'
      ? { inlineData: { mimeType: p.mediaType || 'image/png', data: p.data } }
      : { text: String(p.text ?? '') })),
  };
}

function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => b?.text || '').filter(Boolean).join('\n\n');
}

function abortableSleep(ms, signal) {
  throwIfAborted(signal);
  if (!signal) return sleep(ms);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(aiError('요청을 취소했습니다.', { code: 'aborted' })); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
