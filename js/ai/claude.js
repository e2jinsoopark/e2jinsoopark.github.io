// Claude provider via the official @anthropic-ai/sdk, imported lazily from jsDelivr (VENDOR.anthropicSdk).
//
// Request shape (current Claude API):
// - never send `thinking`: Haiku/Sonnet/Opus 5.5 think adaptively by default, and {type:'disabled'} is a 400 on
//   Sonnet 5.5 / Opus 5.5. Depth and cost are controlled with output_config.effort instead.
// - JSON answers use output_config.format = { type: 'json_schema', schema }.
// - system is always an array of text blocks; blocks marked `cache: true` get cache_control (prompt caching).
// - non-streaming calls on Sonnet 5.5 / Opus 5.5 opt into server-side refusal fallback (beta).
import { CLAUDE_MODELS, VENDOR } from '../core/config.js';
import { settings } from '../core/settings.js';
import { aiError, throwIfAborted } from './providers.js';

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);
const MAX_RETRIES = 2; // the SDK retries 408/409/429/5xx, connection errors and timeouts
const REQUEST_TIMEOUT_MIN_MS = 120_000;
const REQUEST_TIMEOUT_MAX_MS = 600_000;
const DEFAULT_MAX_TOKENS = 16000;
// The SDK refuses non-streaming requests whose max_tokens implies > 10 min of generation (~21K tokens).
const MAX_NONSTREAMING_TOKENS = 20000;

const NO_CREDIT_MESSAGE = 'Claude API 크레딧이 없거나 부족합니다. Claude Console(platform.claude.com) → Billing에서 크레딧을 충전하세요. '
  + 'Claude Max 요금제라면 claude.ai에서 API 크레딧을 Console 조직에 연결하고, 크레딧이 연결된 그 조직에서 만든 API 키를 쓰세요.';

let sdkPromise = null;
let clientCache = { apiKey: '', client: null };
// Set when the fallback beta was rejected (400) and the same request then succeeded without it.
let fallbackBetaRejected = false;

/** Lazily import the SDK module (namespace with `default` = Anthropic and the typed error classes). */
export async function loadSdk() {
  sdkPromise ||= import(VENDOR.anthropicSdk).catch((err) => {
    sdkPromise = null;
    console.warn('[ai] failed to load Anthropic SDK', err);
    throw aiError('Claude 연결 모듈(SDK)을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.', {
      code: 'network', cause: err,
    });
  });
  return sdkPromise;
}

/** For tests: forget the cached client and the remembered fallback-beta rejection. */
export function resetClaudeState() {
  clientCache = { apiKey: '', client: null };
  fallbackBetaRejected = false;
}

/** True after the server-side fallback beta was rejected once in this session. */
export function isFallbackBetaDisabled() {
  return fallbackBetaRejected;
}

/**
 * Translate provider-neutral options into Messages API params (exported for tests).
 * @param {{ model: string, system?: string | { text: string, cache?: boolean }[], messages: object[],
 *           json?: object, maxTokens?: number, effort?: 'low'|'medium'|'high' }} opts
 */
export function buildParams({ model, system, messages, json, maxTokens, effort, cacheMessages = false }) {
  if (!model) throw aiError('Claude 모델이 선택되지 않았습니다. 설정에서 모델을 선택해 주세요.', { code: 'bad_request' });
  const params = { model, max_tokens: maxTokens || DEFAULT_MAX_TOKENS, messages: (messages || []).map(toApiMessage) };
  const sys = toSystemBlocks(system);
  if (sys.length) params.system = sys;
  const outputConfig = {};
  if (effort) outputConfig.effort = effort;
  if (json) outputConfig.format = { type: 'json_schema', schema: json };
  if (Object.keys(outputConfig).length) params.output_config = outputConfig;
  // Multi-turn chat: top-level automatic caching puts a second breakpoint on the conversation tail, so the
  // earlier turns are read from cache on the next question instead of being billed in full every time.
  if (cacheMessages) params.cache_control = { type: 'ephemeral' };
  return params;
}

/** Per-request timeout: bounded by the output size, so a dead connection fails in minutes, not 10 min × retries. */
function requestTimeoutMs(maxTokens) {
  return Math.min(REQUEST_TIMEOUT_MAX_MS, Math.max(REQUEST_TIMEOUT_MIN_MS, 30_000 + (maxTokens || DEFAULT_MAX_TOKENS) * 12));
}

export const claudeProvider = {
  id: 'claude',
  label: 'Claude (Anthropic)',

  async complete(opts) {
    throwIfAborted(opts.signal);
    const { client, sdk } = await getClient();
    const params = buildParams({ ...opts, maxTokens: Math.min(opts.maxTokens || DEFAULT_MAX_TOKENS, MAX_NONSTREAMING_TOKENS) });
    let message;
    try {
      message = await createMessage(client, sdk, params, opts.signal);
    } catch (err) {
      throw toKoreanError(err, sdk, { model: params.model, signal: opts.signal });
    }
    return readMessage(message, { json: Boolean(opts.json), model: params.model });
  },

  async *stream(opts) {
    throwIfAborted(opts.signal);
    const { client, sdk } = await getClient();
    const params = buildParams(opts);
    // Sonnet 5.5 / Opus 5.5: the server-side refusal fallback works on streams too (the retry happens on the
    // same stream; a `fallback` content block marks it and is ignored here, only text deltas are yielded).
    let useBeta = FALLBACK_MODELS.has(params.model) && !fallbackBetaRejected;
    let stream = null;
    let finished = false;
    let started = false;
    try {
      for (;;) {
        stream = useBeta
          ? client.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, { signal: opts.signal })
          : client.messages.stream(params, { signal: opts.signal });
        try {
          for await (const event of stream) {
            if (!started) {
              started = true;
              // The beta was rejected (400 before any event) but the plain request is now running: remember it.
              if (!useBeta && FALLBACK_MODELS.has(params.model) && !fallbackBetaRejected) {
                fallbackBetaRejected = true;
                console.warn('[ai] server-side fallback beta rejected on a stream; continuing without it');
              }
            }
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
              yield { type: 'text', text: event.delta.text };
            }
          }
          break;
        } catch (err) {
          // A 400 arrives before any event: the same request without the beta tells beta vs genuine bad request.
          if (useBeta && !started && err instanceof sdk.BadRequestError && !opts.signal?.aborted) {
            useBeta = false;
            continue;
          }
          throw err;
        }
      }
      const message = await stream.finalMessage();
      finished = true;
      const usage = toUsage(message, params.model);
      if (message.stop_reason === 'refusal') throw refusalError(message, usage);
      yield { type: 'done', usage, stopReason: message.stop_reason };
    } catch (err) {
      finished = true;
      const out = toKoreanError(err, sdk, { model: params.model, signal: opts.signal });
      // Stopped or failed mid-answer: the prompt and the streamed part are billed — carry the usage so far.
      if (!out.usage && stream?.currentMessage?.usage) out.usage = toUsage(stream.currentMessage, params.model);
      throw out;
    } finally {
      // The consumer stopped early (break / return): close the HTTP stream.
      if (!finished) stream?.abort();
    }
  },

  async listModels() {
    const { client, sdk } = await getClient();
    const known = new Map(CLAUDE_MODELS.map((m) => [m.id, m.label]));
    try {
      const out = [];
      for await (const m of client.models.list({ limit: 100 })) {
        if (String(m.id).startsWith('claude-')) out.push({ id: m.id, label: known.get(m.id) || m.display_name || m.id });
      }
      return out.length ? out : CLAUDE_MODELS.map((m) => ({ ...m }));
    } catch (err) {
      throw toKoreanError(err, sdk, {});
    }
  },

  async testKey() {
    try {
      const { client, sdk } = await getClient();
      try {
        await client.models.list({ limit: 1 }); // free: lists models, no tokens billed
      } catch (err) {
        throw toKoreanError(err, sdk, {});
      }
      return {
        ok: true,
        message: 'Claude API 키가 유효합니다. (크레딧 잔액은 확인하지 않습니다. 번역할 때 크레딧 오류가 나면 Claude Console의 Billing을 확인하세요.)',
      };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },
};

// ───────────────────────────── internals ─────────────────────────────

async function getClient() {
  const apiKey = String(settings.get().claude?.apiKey || '').trim();
  if (!apiKey) throw aiError('Claude API 키가 없습니다. 설정에서 API 키를 입력해 주세요.', { code: 'no_key' });
  const sdk = await loadSdk();
  if (clientCache.apiKey !== apiKey || !clientCache.client) {
    const Anthropic = sdk.default;
    clientCache = { apiKey, client: new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: MAX_RETRIES }) };
  }
  return { client: clientCache.client, sdk };
}

/**
 * Non-streaming create. On Sonnet 5.5 / Opus 5.5 opt into server-side refusal fallback; if that request is a 400
 * and the identical request without the beta succeeds, the beta is the problem — remember and skip it from now on.
 * (No error-message matching: a genuinely bad request fails the second time too and is reported as such.)
 */
async function createMessage(client, sdk, params, signal) {
  const options = { signal, timeout: requestTimeoutMs(params.max_tokens) };
  if (!FALLBACK_MODELS.has(params.model) || fallbackBetaRejected) {
    return client.messages.create(params, options);
  }
  try {
    return await client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, options);
  } catch (err) {
    if (!(err instanceof sdk.BadRequestError)) throw err;
    const message = await client.messages.create(params, options);
    fallbackBetaRejected = true;
    console.warn('[ai] server-side fallback beta rejected; continuing without it:', err.message);
    return message;
  }
}

function readMessage(message, { json, model }) {
  const usage = toUsage(message, model);
  if (message.stop_reason === 'refusal') throw refusalError(message, usage);
  const text = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (message.stop_reason === 'max_tokens' && json) {
    throw aiError('응답이 최대 길이에 도달해 잘렸습니다. 더 작은 단위로 나누어 다시 요청합니다.', {
      code: 'max_tokens', usage, partialText: text,
    });
  }
  const out = { text, usage, stopReason: message.stop_reason, model: message.model || model };
  if (json) {
    try {
      out.json = JSON.parse(text);
    } catch (err) {
      console.warn('[ai] Claude returned invalid JSON', text.slice(0, 200));
      throw aiError('AI 응답(JSON)을 해석하지 못했습니다. 다시 시도해 주세요.', { code: 'parse', usage, cause: err });
    }
  }
  return out;
}

function refusalError(message, usage) {
  const category = message.stop_details?.category ?? null;
  console.warn('[ai] Claude refusal', category, message.stop_details?.explanation);
  return aiError(
    'Claude가 안전 정책에 따라 이 요청에 대한 응답을 거절했습니다. 내용을 바꾸거나 설정에서 다른 모델을 선택해 다시 시도해 주세요.',
    { code: 'refusal', category, usage },
  );
}

/**
 * Usage of the returned message. With server-side fallback, `usage.iterations` lists every attempt (each billed at
 * its own model's rates); they are kept as `parts` so costUsd() can price them individually.
 */
function toUsage(message, requestedModel) {
  const u = message?.usage || {};
  const usage = {
    model: message?.model || requestedModel,
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0,
    cacheWriteTokens: u.cache_creation_input_tokens || 0,
  };
  const iterations = Array.isArray(u.iterations) ? u.iterations : [];
  if (iterations.length > 1) {
    usage.parts = iterations.map((it) => ({
      model: it.model || usage.model,
      inputTokens: it.input_tokens || 0,
      outputTokens: it.output_tokens || 0,
      cacheReadTokens: it.cache_read_input_tokens || 0,
      cacheWriteTokens: it.cache_creation_input_tokens || 0,
    }));
  }
  // Served by another model (refusal fallback, sticky routing): keep the requested one for unknown-price estimates.
  if (requestedModel && (usage.model !== requestedModel || usage.parts?.some((p) => p.model !== requestedModel))) {
    usage.requestedModel = requestedModel;
  }
  return usage;
}

function toApiMessage(m) {
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  if (typeof m.content === 'string') return { role, content: m.content };
  return {
    role,
    content: (m.content || []).map((p) =>
      p.type === 'image'
        ? { type: 'image', source: { type: 'base64', media_type: p.mediaType || 'image/png', data: p.data } }
        : { type: 'text', text: String(p.text ?? '') }),
  };
}

function toSystemBlocks(system) {
  if (!system) return [];
  if (typeof system === 'string') return [{ type: 'text', text: system }];
  return system
    .filter((b) => b && b.text)
    .map((b) => (b.cache
      ? { type: 'text', text: b.text, cache_control: { type: 'ephemeral' } }
      : { type: 'text', text: b.text }));
}

/** Map SDK errors (by class, most specific first) to Korean aiErrors. */
function toKoreanError(err, sdk, { model, signal } = {}) {
  if (err?.name === 'AiError' || (err?.code && 'fatal' in err)) return err; // already ours
  const detail = err?.error?.error?.message || err?.message || '';
  const make = (message, code, extra = {}) => {
    console.warn('[ai] Claude error', code, err?.status ?? '', detail);
    return aiError(message, { code, status: err?.status, cause: err, ...extra });
  };
  if (err instanceof sdk.APIUserAbortError || signal?.aborted) return aiError('요청을 취소했습니다.', { code: 'aborted', cause: err });
  if (err instanceof sdk.APIConnectionTimeoutError) {
    return make('Claude 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.', 'timeout');
  }
  if (err instanceof sdk.APIConnectionError) {
    return make('Claude 서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.', 'network');
  }
  if (err instanceof sdk.AuthenticationError) {
    return make('Claude API 키가 올바르지 않습니다. 설정에서 키를 다시 확인해 주세요.', 'auth');
  }
  if (err instanceof sdk.PermissionDeniedError) {
    return make('이 API 키로는 요청한 Claude 모델이나 기능을 사용할 권한이 없습니다. Anthropic Console에서 권한을 확인해 주세요.', 'permission');
  }
  if (err instanceof sdk.NotFoundError) {
    return make(`Claude 모델을 찾을 수 없습니다${model ? `(${model})` : ''}. 설정에서 모델을 다시 선택해 주세요.`, 'not_found');
  }
  if (err instanceof sdk.RateLimitError) {
    return make('Claude 요청 한도(분당 요청·토큰 수)를 초과했습니다. 잠시 후 다시 시도하거나 설정에서 동시 번역 수를 줄여 주세요.', 'rate_limit');
  }
  if (err instanceof sdk.BadRequestError) {
    // No API credit is reported as a 400 ("Your credit balance is too low …"): a setup problem, not a bad request.
    if (/credit balance/i.test(detail)) return make(NO_CREDIT_MESSAGE, 'billing');
    return make(`Claude가 요청을 처리할 수 없습니다(잘못된 요청).${detail ? ` 상세: ${detail}` : ''}`, 'bad_request');
  }
  if (err instanceof sdk.InternalServerError) {
    const overloaded = err.status === 529;
    return make(overloaded
      ? 'Claude 서버가 일시적으로 과부하 상태입니다. 잠시 후 다시 시도해 주세요.'
      : 'Claude 서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.', 'server');
  }
  if (err instanceof sdk.APIError) {
    if (err.status === 402) return make(NO_CREDIT_MESSAGE, 'billing');
    if (err.status === 413) return make('요청이 너무 큽니다. 더 짧은 내용으로 다시 시도해 주세요.', 'bad_request');
    return make(`Claude API 오류가 발생했습니다${err.status ? `(HTTP ${err.status})` : ''}. 잠시 후 다시 시도해 주세요.`, 'unknown');
  }
  return make('Claude 요청 중 알 수 없는 오류가 발생했습니다.', 'unknown');
}
