// OpenAI (GPT) provider over the Responses API (POST /v1/responses) with plain fetch — no SDK.
// Why Responses and not Chat Completions, and the evidence for every request field: docs/notes/openai.md.
//
// Request shape (OpenAI API docs, read 2026-10-18):
// - system blocks → one `developer` input message of input_text parts (top-level `instructions` cannot carry a
//   prompt-cache breakpoint); user parts → input_text / input_image (data URL); assistant turns → plain strings.
// - `store: false` always (both Responses and, for new accounts, Chat Completions store by default).
// - JSON answers: text.format = { type: 'json_schema', name, schema, strict: true }.
// - effort → reasoning.effort on reasoning models (GPT-5 and later, o-series); never temperature/top_p.
// - max_output_tokens counts reasoning tokens too, so reasoning models get a reserve on top of maxTokens.
// - GPT-5.6 and later: prompt_cache_options.mode 'explicit' + prompt_cache_breakpoint on the blocks marked
//   cache:true (and on the conversation tail for chat), so only the shared prefix is written to the cache.
//   Earlier models: a stable prompt_cache_key per cached prefix (routes its requests to the same cache).
// - Assistant turns of the history carry phase 'final_answer' on GPT-5.3 and later (the reference asks to resend it).
// - Streams: SSE `response.output_text.delta` … `response.completed` (usage arrives there; no stream option needed).
//
// Browser quirk (observed with curl, 2026-10-18): a POST with an invalid key is answered 401 WITHOUT
// Access-Control-Allow-Origin, so the browser only sees a network error. GET /v1/models does send CORS headers
// on 401, so a failed POST is diagnosed with one free GET /v1/models (bad key → auth, model missing → not_found).
import { settings } from '../core/settings.js';
import { hash, sleep } from '../core/util.js';
import { aiError, throwIfAborted } from './providers.js';
import { isRelayOriginAllowed } from './relay.js';

export const OPENAI_BASE = 'https://api.openai.com/v1';

const DEFAULT_MAX_TOKENS = 16000;
const MAX_OUTPUT_TOKENS = 128000; // GPT-5.6 / GPT-6 models' documented output limit
/** Extra max_output_tokens for reasoning models (reasoning tokens count against the cap), by effort. */
const REASONING_RESERVE = Object.freeze({ low: 4000, medium: 8000, high: 16000 });
const EFFORTS = new Set(['low', 'medium', 'high']);
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 20_000;
const REQUEST_TIMEOUT_MIN_MS = 120_000;
const REQUEST_TIMEOUT_MAX_MS = 600_000;
const STREAM_IDLE_TIMEOUT_MS = 300_000; // reasoning can be silent for a while before the first text delta
const PROBE_TIMEOUT_MS = 10_000;
const MAX_CACHE_BREAKPOINTS = 4; // "Each request can create up to four cache writes."
const JSON_FORMAT_NAME = 'answer';

/** Tier words in model ids, cheapest first. 'standard' = no tier word (gpt-5.5, o3). */
const TIER_WORDS = new Set(['nano', 'mini', 'luna', 'terra', 'sol', 'astra', 'pro']);
/** Order inside one version in listModels(): most capable first, the slow/expensive pro variants after. */
const LIST_TIER_ORDER = ['astra', 'sol', 'standard', 'terra', 'luna', 'mini', 'nano', 'pro', 'other'];
/**
 * Default-model search: tier classes tried in order; inside a class the newest version wins.
 * translate = the fast/cheap tier, assist = the standard tier (pro variants are never a default).
 */
const PICK_CLASSES = Object.freeze({
  translate: [['luna', 'mini'], ['nano'], ['terra'], ['sol', 'standard'], ['astra']],
  assist: [['sol', 'standard'], ['terra'], ['astra'], ['luna', 'mini'], ['nano']],
});
/** Tie-breakers only (same version and class): the models page's current recommendation (2026-10-18). */
const DOCS_RECOMMENDED = Object.freeze({ translate: ['gpt-6-luna'], assist: ['gpt-6.1-sol'] });
/** Words of ids that are not general text chat models (audio, realtime, images, search, codex, …). */
const NON_CHAT_WORDS = new Set(['audio', 'realtime', 'tts', 'transcribe', 'whisper', 'image', 'search', 'codex',
  'instruct', 'cyber', 'diarize', 'translate', 'live', 'moderation', 'embedding', 'computer']);
const NON_CHAT_PARTS = ['deep-research', 'chat-latest', 'search-api'];
/** Listed as deprecated on the "All models" page (2026-10-18) without a rule below catching them. */
const DEPRECATED_IDS = new Set(['gpt-5.4-nano']);
const DEPRECATED_VERSIONS = [[5, 1]]; // the whole GPT-5.1 family
const TIER_HINTS = {
  nano: '가장 저렴', mini: '빠름·저렴', luna: '빠름·저렴', terra: '균형', standard: '고품질', sol: '고품질',
  astra: '최고 품질·비쌈', pro: '최고 품질·매우 비쌈·느림',
};
const BILLING_CODES = new Set(['insufficient_quota', 'credit_balance_exhausted', 'billing_hard_limit_reached',
  'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded']);

const NO_KEY_MESSAGE = 'OpenAI API 키가 없습니다. 설정에서 API 키를 입력해 주세요.';
const AUTH_MESSAGE = 'OpenAI API 키가 올바르지 않습니다. 설정에서 키를 다시 확인해 주세요.';
const NO_CREDIT_MESSAGE = 'OpenAI API 크레딧이 없거나 부족합니다. OpenAI 대시보드(platform.openai.com) → Settings → Billing에서 '
  + '크레딧을 충전하세요. ChatGPT Plus·Pro 구독과 API 크레딧은 별개입니다.';
const SPEND_LIMIT_MESSAGE = 'OpenAI 조직 또는 프로젝트에 정한 사용 한도(spend limit)에 도달했습니다. OpenAI 대시보드(platform.openai.com) → '
  + 'Settings → Limits에서 한도를 늘리거나 해제하세요.';
const USAGE_LIMIT_MESSAGE = 'OpenAI가 이 조직에 정한 사용 한도에 도달했습니다. OpenAI 대시보드(platform.openai.com) → Settings → Limits에서 '
  + '한도 상향을 요청하세요.';
const VERIFY_MESSAGE = '이 OpenAI 모델(또는 스트리밍)을 쓰려면 조직 인증(Organization verification)이 필요합니다. OpenAI 대시보드 '
  + '(platform.openai.com) → Settings → Organization → General에서 인증하거나 설정에서 다른 모델을 선택해 주세요.';
const NETWORK_MESSAGE = 'OpenAI 서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.';
const CSP_MESSAGE = '이 앱의 보안 정책(CSP)이 OpenAI API(api.openai.com) 연결을 막았습니다. 앱 관리자가 index.html의 connect-src에 '
  + 'https://api.openai.com을 추가해야 합니다.';
const ABORT_MESSAGE = '요청을 취소했습니다.';
const TIMEOUT_MESSAGE = 'OpenAI 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.';
const CUT_OFF_MESSAGE = '응답이 최대 길이에 도달해 잘렸습니다. 더 작은 단위로 나누어 다시 요청합니다.';

// Per page load: models whose explicit prompt-cache options were rejected (400) while the same request then
// succeeded without them; models that may not stream for this organization (verification); shutdown dates
// announced by the last GET /v1/models.
const state = { cacheRejected: new Set(), noStreaming: new Set(), shutdown: new Map() };

/** For tests: forget the remembered rejections and shutdown dates. */
export function resetOpenAiState() {
  state.cacheRejected.clear();
  state.noStreaming.clear();
  state.shutdown.clear();
}

// ───────────────────────────── model ids ─────────────────────────────

/**
 * @typedef {{ id: string, alias: string, base: string, family: 'gpt'|'o'|'other', version: number[],
 *             versionText: string, rest: string[], tier: string, snapshot: string, fineTuned: boolean }} ModelInfo
 */

/**
 * Parse an OpenAI model id: 'gpt-6.1-sol' → family gpt, version [6,1], tier sol; 'gpt-5-mini-2025-08-07' →
 * tier mini, snapshot 2025-08-07, alias gpt-5-mini; 'o3-pro' → family o, tier pro; 'ft:gpt-4o:org::x' → fineTuned.
 * @param {string} id
 * @returns {ModelInfo}
 */
export function parseModelId(id) {
  const raw = String(id || '');
  const fineTuned = raw.startsWith('ft:');
  const base = fineTuned ? raw.slice(3).split(':')[0] : raw;
  const snap = /-(\d{4}-\d{2}-\d{2}|\d{4})$/.exec(base);
  const alias = snap ? base.slice(0, snap.index) : base;
  const info = { id: raw, alias, base, family: 'other', version: [], versionText: '', rest: [], tier: 'other', snapshot: snap ? snap[1] : '', fineTuned };
  let m = /^gpt-(\d+)(?:\.(\d+))?(o?)(?:-(.+))?$/.exec(alias);
  if (m) {
    Object.assign(info, { family: 'gpt', version: [Number(m[1]), Number(m[2] || 0)], versionText: `${m[1]}${m[2] ? `.${m[2]}` : ''}${m[3]}` });
    info.rest = m[4] ? m[4].split('-') : [];
    if (m[3]) info.version.push(0.5); // gpt-4o sorts after gpt-4
  } else if ((m = /^o(\d+)(?:-(.+))?$/.exec(alias))) {
    Object.assign(info, { family: 'o', version: [Number(m[1]), 0], versionText: `o${m[1]}` });
    info.rest = m[2] ? m[2].split('-') : [];
  } else {
    return info;
  }
  info.tier = info.rest.find((w) => TIER_WORDS.has(w)) || (info.rest.length ? 'other' : 'standard');
  return info;
}

/** True for general text chat models (GPT and o-series), false for audio, realtime, image, embedding, codex, … */
export function isChatModel(id) {
  const info = parseModelId(id);
  if (info.family === 'other') return false;
  if (info.rest.some((w) => NON_CHAT_WORDS.has(w))) return false;
  return !NON_CHAT_PARTS.some((p) => info.alias.includes(p));
}

/**
 * Ids a new API key typically cannot use (deprecated or shut down): GPT-3.5/GPT-4 families (4o, 4.1, 4.5),
 * o1 and the o-series minis, ChatGPT aliases, codex and preview models, the deprecated GPT-5.1 family, and every
 * id for which the last GET /v1/models announced a shutdown date. Fine-tuned models are the user's own: never legacy.
 * @param {string} id
 */
export function isLegacyOpenAiModel(id) {
  const info = parseModelId(id);
  if (state.shutdown.has(info.id) || state.shutdown.has(info.alias)) return true;
  if (info.fineTuned || info.family === 'other') return false;
  if (DEPRECATED_IDS.has(info.alias)) return true;
  if (info.rest.some((w) => w === 'preview' || w === 'codex') || info.alias.includes('chat-latest')) return true;
  if (info.family === 'o') return info.version[0] === 1 || info.tier === 'mini';
  if (info.version[0] < 5) return true;
  return DEPRECATED_VERSIONS.some((v) => compareVersions(info.version, v) === 0);
}

/** Reasoning models (their reasoning tokens count against max_output_tokens): GPT-5 and later, the o-series. */
export function isReasoningModel(model) {
  const info = parseModelId(model);
  if (info.family === 'o') return true;
  return info.family === 'gpt' && info.version[0] >= 5 && !info.alias.includes('chat');
}

/**
 * Models that get our `reasoning.effort` levels: reasoning models except o1 and the pro variants (pro models are
 * built to run at high effort, so their effort is left to the model's default rather than risking a 400).
 */
export function supportsReasoningEffort(model) {
  const info = parseModelId(model);
  if (info.tier === 'pro' || !isReasoningModel(model)) return false;
  return info.family !== 'o' || info.version[0] >= 3;
}

/** prompt_cache_options / prompt_cache_breakpoint exist for GPT-5.6 and later. */
export function supportsExplicitCaching(model) {
  const info = parseModelId(model);
  return info.family === 'gpt' && !info.fineTuned && compareVersions(info.version, [5, 6]) >= 0;
}

/**
 * Models that label assistant messages with `phase` (commentary / final_answer). The Responses reference asks to
 * resend it on assistant input messages "for models like gpt-5.3-codex and beyond"; older models do not use it.
 */
export function usesMessagePhase(model) {
  const info = parseModelId(model);
  return info.family === 'gpt' && !info.fineTuned && compareVersions(info.version, [5, 3]) >= 0;
}

/**
 * Sort ids for the model dropdown: GPT before o-series before fine-tunes, newest version first, then by tier
 * (Astra, Sol, standard, Terra, Luna/mini, nano, pro), aliases before their dated snapshots (newest first).
 * @param {string[]} ids
 */
export function sortOpenAiModels(ids) {
  const familyRank = { gpt: 0, o: 1, other: 2 };
  return [...ids].sort((a, b) => {
    const x = parseModelId(a);
    const y = parseModelId(b);
    return (Number(x.fineTuned) - Number(y.fineTuned))
      || (familyRank[x.family] - familyRank[y.family])
      || compareVersions(y.version, x.version)
      || (LIST_TIER_ORDER.indexOf(x.tier) - LIST_TIER_ORDER.indexOf(y.tier))
      || (Number(Boolean(x.snapshot)) - Number(Boolean(y.snapshot)))
      || y.snapshot.localeCompare(x.snapshot)
      || a.localeCompare(b);
  });
}

/**
 * Default model for a task from the live model list (never a fixed id): the newest model of the cheapest fitting
 * tier class for 'translate' (Luna / mini), of the standard class for 'assist' (Sol / plain GPT-N). Legacy models,
 * pro variants, fine-tunes and dated snapshots whose alias is listed are skipped; '' for an empty list.
 * @param {({ id: string } | string)[]} models
 * @param {'translate'|'assist'} [kind]
 */
export function pickOpenAiModel(models, kind = 'translate') {
  const ids = (models || []).map((m) => (typeof m === 'string' ? m : m?.id)).filter((id) => typeof id === 'string' && id);
  const all = new Set(ids);
  const chat = ids.filter((id) => {
    const info = parseModelId(id);
    return isChatModel(id) && !info.fineTuned && !(info.snapshot && all.has(info.alias));
  });
  const usable = chat.filter((id) => !isLegacyOpenAiModel(id));
  const legacy = chat.filter((id) => isLegacyOpenAiModel(id));
  const classes = PICK_CLASSES[kind] || PICK_CLASSES.translate;
  const recommended = DOCS_RECOMMENDED[kind] || DOCS_RECOMMENDED.translate;
  const search = (candidates) => {
    for (const tiers of classes) {
      const found = candidates.map(parseModelId).filter((info) => info.family === 'gpt' && tiers.includes(info.tier));
      if (!found.length) continue;
      found.sort((x, y) => compareVersions(y.version, x.version)
        || (Number(recommended.includes(y.alias)) - Number(recommended.includes(x.alias)))
        || (tiers.indexOf(x.tier) - tiers.indexOf(y.tier))
        || (Number(Boolean(x.snapshot)) - Number(Boolean(y.snapshot)))
        || y.snapshot.localeCompare(x.snapshot)
        || x.id.localeCompare(y.id));
      return found[0].id;
    }
    // No GPT model of a known tier: another chat model (e.g. o3), pro variants last.
    const notPro = candidates.filter((id) => parseModelId(id).tier !== 'pro');
    return sortOpenAiModels(notPro)[0] || sortOpenAiModels(candidates)[0] || '';
  };
  // Legacy models only when the key has nothing newer (an old project may still run them); never a non-chat id.
  return search(usable) || search(legacy);
}

/** Dropdown label, e.g. 'GPT-6 Luna (빠름·저렴)', 'GPT-5 mini (스냅숏 2025-08-07 · 이전 세대)'. */
export function modelLabel(id) {
  const info = parseModelId(id);
  if (info.fineTuned) return `미세 조정 모델 (${info.id})`;
  if (info.family === 'other') return info.id;
  const words = info.rest.map((w) => (['sol', 'luna', 'terra', 'astra'].includes(w) ? w[0].toUpperCase() + w.slice(1) : w));
  const name = [info.family === 'gpt' ? `GPT-${info.versionText}` : info.versionText, ...words].join(' ');
  const hints = [];
  if (info.snapshot) hints.push(`스냅숏 ${info.snapshot}`);
  const shutdown = state.shutdown.get(info.id) || state.shutdown.get(info.alias);
  if (shutdown) hints.push(`종료 예정 ${shutdown}`);
  else if (isLegacyOpenAiModel(info.id)) hints.push('이전 세대');
  else if (info.family === 'o') hints.push('추론 모델');
  else if (TIER_HINTS[info.tier]) hints.push(TIER_HINTS[info.tier]);
  return hints.length ? `${name} (${hints.join(' · ')})` : name;
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ───────────────────────────── request body ─────────────────────────────

/**
 * Provider-neutral options → Responses API request body (exported for tests).
 * @param {{ model: string, system?: string | { text: string, cache?: boolean }[], messages: object[], json?: object,
 *           maxTokens?: number, effort?: 'low'|'medium'|'high', cacheMessages?: boolean }} opts
 * @param {{ stream?: boolean, explicitCache?: boolean }} [mode] explicitCache: send cache breakpoints when the
 *   model supports them (default true)
 */
export function buildRequest({ model, system, messages, json, maxTokens, effort, cacheMessages = false }, { stream = false, explicitCache = true } = {}) {
  if (!model) throw aiError('OpenAI 모델이 선택되지 않았습니다. 설정에서 모델 목록을 불러와 모델을 선택해 주세요.', { code: 'bad_request' });
  const reasoning = supportsReasoningEffort(model);
  const level = EFFORTS.has(effort) ? effort : null;
  // Without an effort of ours the model runs at its default: medium, high for the pro variants.
  const reserveLevel = reasoning ? (level || 'medium') : parseModelId(model).tier === 'pro' ? 'high' : 'medium';
  const reserve = isReasoningModel(model) ? REASONING_RESERVE[reserveLevel] : 0;
  const caching = explicitCache && supportsExplicitCaching(model);
  let breakpoints = 0;
  const mark = (part) => {
    if (!caching || breakpoints >= MAX_CACHE_BREAKPOINTS) return part;
    breakpoints += 1;
    return { ...part, prompt_cache_breakpoint: { mode: 'explicit' } };
  };

  const input = [];
  const sys = systemBlocks(system);
  if (sys.length) {
    // Room for the conversation-tail breakpoint is kept when one is wanted.
    const sysLimit = MAX_CACHE_BREAKPOINTS - (cacheMessages ? 1 : 0);
    input.push({
      role: 'developer',
      content: sys.map((b) => {
        const part = { type: 'input_text', text: b.text };
        return b.cache && breakpoints < sysLimit ? mark(part) : part;
      }),
    });
  }
  const phase = usesMessagePhase(model);
  const turns = (messages || []).map((m) => toInputMessage(m, { phase }));
  if (cacheMessages) {
    // Chat: the earlier turns are re-sent with every question; cache the prompt up to the latest user text.
    const last = turns.findLastIndex((t) => t.role === 'user');
    const parts = last >= 0 ? turns[last].content : null;
    const at = parts ? parts.findLastIndex((p) => p.type === 'input_text') : -1;
    if (at >= 0) parts[at] = mark(parts[at]);
  }
  input.push(...turns);

  const body = {
    model,
    input,
    max_output_tokens: Math.min(MAX_OUTPUT_TOKENS, (maxTokens || DEFAULT_MAX_TOKENS) + reserve),
    store: false,
  };
  if (reasoning && level) body.reasoning = { effort: level };
  if (json) body.text = { format: { type: 'json_schema', name: JSON_FORMAT_NAME, schema: structuredClone(json), strict: true } };
  if (breakpoints) body.prompt_cache_options = { mode: 'explicit' };
  // Before GPT-5.6 caching is implicit and "prompt_cache_key is important for optimizing cache hit rates": one stable
  // key per shared prefix (the paper / abstract block), so a paper's batches and questions reach the same cache.
  const cached = supportsExplicitCaching(model) ? '' : sys.filter((b) => b.cache).map((b) => b.text).join('\n');
  if (cached) body.prompt_cache_key = `pr-${hash(cached)}`;
  if (stream) body.stream = true;
  return body;
}

function systemBlocks(system) {
  if (!system) return [];
  if (typeof system === 'string') return system ? [{ text: system }] : [];
  return system.filter((b) => b && b.text).map((b) => ({ text: String(b.text), cache: Boolean(b.cache) }));
}

function toInputMessage(m, { phase = false } = {}) {
  if (m.role === 'assistant') {
    const text = typeof m.content === 'string' ? m.content
      : (m.content || []).filter((p) => p.type === 'text').map((p) => String(p.text ?? '')).join('\n');
    // Our history keeps only the answers the user saw: final answers, never commentary.
    return phase ? { role: 'assistant', content: text, phase: 'final_answer' } : { role: 'assistant', content: text };
  }
  const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []);
  return {
    role: 'user',
    content: parts.map((p) => (p.type === 'image'
      ? { type: 'input_image', image_url: `data:${p.mediaType || 'image/png'};base64,${p.data}`, detail: 'high' }
      : { type: 'input_text', text: String(p.text ?? '') })),
  };
}

// ───────────────────────────── provider ─────────────────────────────

export const openaiProvider = {
  id: 'openai',
  label: 'GPT (OpenAI)',

  /**
   * @param {{ model: string, system?: string | object[], messages: object[], json?: object, maxTokens?: number,
   *           effort?: 'low'|'medium'|'high', signal?: AbortSignal, cacheMessages?: boolean }} opts
   * @returns {Promise<{ text: string, json?: unknown, usage: object, stopReason: string, model: string }>}
   */
  async complete(opts) {
    throwIfAborted(opts.signal);
    const key = apiKey();
    const timeoutMs = requestTimeoutMs(buildRequest(opts).max_output_tokens);
    const { res, call } = await postResponse(key, opts, { stream: false, timeoutMs });
    let data;
    try {
      data = JSON.parse(await res.text());
    } catch (err) {
      throw bodyFailure(err, opts.signal, call, 'OpenAI 응답을 읽지 못했습니다. 다시 시도해 주세요.');
    } finally {
      call.done();
    }
    return readResponse(data, { model: opts.model, json: Boolean(opts.json) });
  },

  /**
   * Streamed text: yields { type:'text', text } … then { type:'done', usage, stopReason }.
   * @param {object} opts same as complete(), without `json`
   */
  async *stream(opts) {
    throwIfAborted(opts.signal);
    const key = apiKey();
    const textOpts = { ...opts, json: undefined };
    if (state.noStreaming.has(opts.model)) {
      yield* completeAsStream(textOpts);
      return;
    }
    let opened;
    try {
      opened = await postResponse(key, textOpts, { stream: true, timeoutMs: STREAM_IDLE_TIMEOUT_MS });
    } catch (err) {
      if (!err?.streamUnsupported) throw err;
      // This organization may not stream the model (unverified): answer in one piece instead.
      state.noStreaming.add(opts.model);
      console.warn('[ai] OpenAI: streaming refused for', opts.model, '— falling back to a non-streaming request');
      yield* completeAsStream(textOpts);
      return;
    }
    const { res, call } = opened;
    const phases = new Map();
    let final = null;
    let refusal = '';
    let text = '';
    try {
      for await (const ev of readSse(res.body, call.refresh)) {
        // Events already buffered must not be yielded after a cancel.
        throwIfAborted(opts.signal);
        switch (ev?.type) {
          case 'response.output_item.added':
            if (ev.item?.id) phases.set(ev.item.id, ev.item.phase || null);
            break;
          case 'response.output_text.delta':
            if (phases.get(ev.item_id) !== 'commentary' && ev.delta) {
              text += ev.delta;
              yield { type: 'text', text: ev.delta };
            }
            break;
          case 'response.refusal.delta':
            refusal += ev.delta || '';
            break;
          case 'response.refusal.done':
            refusal = ev.refusal || refusal;
            break;
          case 'response.completed':
          case 'response.incomplete':
          case 'response.failed':
            final = ev.response || {};
            break;
          case 'error':
            throw streamEventError(ev, opts.model);
          default:
            break;
        }
        if (final) break;
      }
    } catch (err) {
      throw bodyFailure(err, opts.signal, call, NETWORK_MESSAGE);
    } finally {
      call.abort(); // closes the HTTP stream when the consumer stopped early; no-op once it has ended
      call.done();
    }
    if (!final) {
      throw aiError('OpenAI 응답이 중간에 끊겼습니다. 다시 시도해 주세요.', { code: 'network', partialText: text });
    }
    const usage = toUsage(final.usage, final.model || opts.model);
    if (final.status === 'failed') throw responseFailedError(final.error, usage, opts.model);
    const reason = final.incomplete_details?.reason;
    if (reason === 'content_filter') throw refusalError('content_filter', '', usage);
    if (refusal && !text) throw refusalError(null, refusal, usage);
    yield { type: 'done', usage, stopReason: final.status === 'incomplete' ? 'max_tokens' : 'end_turn' };
  },

  /**
   * Text chat models of this key, newest first (GET /v1/models; shut-down models are left out).
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<{ id: string, label: string }[]>}
   */
  async listModels({ signal } = {}) {
    throwIfAborted(signal);
    const key = apiKey();
    const data = await getModels(key, signal);
    const today = new Date().toISOString().slice(0, 10);
    const ids = [];
    state.shutdown.clear();
    for (const m of Array.isArray(data?.data) ? data.data : []) {
      const id = typeof m?.id === 'string' ? m.id : '';
      if (!id) continue;
      const shutdown = typeof m.shutdown_date === 'string' ? m.shutdown_date.slice(0, 10) : '';
      if (shutdown) state.shutdown.set(id, shutdown);
      if (shutdown && shutdown <= today) continue;
      if (isChatModel(id)) ids.push(id);
    }
    // A dated snapshot is listed only when its alias is not (the alias always points at the current snapshot).
    const all = new Set(ids);
    const shown = ids.filter((id) => {
      const info = parseModelId(id);
      return !info.snapshot || info.fineTuned || !all.has(info.alias);
    });
    return sortOpenAiModels(shown).map((id) => ({ id, label: modelLabel(id) }));
  },

  pickDefaultModel: (models, kind) => pickOpenAiModel(models, kind),
  isLegacyModel: (id) => isLegacyOpenAiModel(id),

  /**
   * Checks the key with the free GET /v1/models (no tokens billed; credit is not checked).
   * @returns {Promise<{ ok: boolean, message: string, models?: { id: string, label: string }[] }>}
   */
  async testKey() {
    try {
      const models = await openaiProvider.listModels();
      if (!models.length) {
        return { ok: false, models, message: '키는 확인되었지만 이 키로 쓸 수 있는 GPT 텍스트 모델이 없습니다. OpenAI 대시보드에서 프로젝트의 모델 권한을 확인해 주세요.' };
      }
      return {
        ok: true,
        models,
        message: `OpenAI API 키가 확인되었습니다(사용 가능한 모델 ${models.length}개). 크레딧 잔액은 확인하지 않습니다. 번역할 때 크레딧 오류가 나면 OpenAI 대시보드의 Billing을 확인하세요.`,
      };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },
};

/** Non-streaming request whose answer is yielded in one piece (stream fallback). */
async function* completeAsStream(opts) {
  const r = await openaiProvider.complete(opts);
  if (r.text) yield { type: 'text', text: r.text };
  yield { type: 'done', usage: r.usage, stopReason: r.stopReason };
}

// ───────────────────────────── HTTP ─────────────────────────────

function apiKey() {
  const key = String(settings.get().openai?.apiKey || '').trim();
  if (!key) throw aiError(NO_KEY_MESSAGE, { code: 'no_key' });
  return key;
}

function requestTimeoutMs(maxOutputTokens) {
  return Math.min(REQUEST_TIMEOUT_MAX_MS, Math.max(REQUEST_TIMEOUT_MIN_MS, 30_000 + maxOutputTokens * 12));
}

/**
 * POST /v1/responses. With explicit cache breakpoints, a 400 is retried once without them; if that succeeds the
 * model is remembered as not accepting them (a genuinely bad request fails twice and is reported as such).
 */
async function postResponse(key, opts, { stream, timeoutMs }) {
  const explicitCache = !state.cacheRejected.has(opts.model);
  const body = buildRequest(opts, { stream, explicitCache });
  const send = (b) => request(`${OPENAI_BASE}/responses`, { key, body: b, signal: opts.signal, timeoutMs, model: opts.model });
  try {
    return await send(body);
  } catch (err) {
    if (!body.prompt_cache_options || err?.status !== 400 || err.code !== 'bad_request' || err.streamUnsupported) throw err;
    const out = await send(buildRequest(opts, { stream, explicitCache: false }));
    state.cacheRejected.add(opts.model);
    console.warn('[ai] OpenAI: explicit prompt caching rejected for', opts.model, '— continuing without it:', err.message);
    return out;
  }
}

async function getModels(key, signal) {
  const { res, call } = await request(`${OPENAI_BASE}/models`, { key, method: 'GET', signal, timeoutMs: 30_000 });
  try {
    return JSON.parse(await res.text());
  } catch (err) {
    throw bodyFailure(err, signal, call, 'OpenAI 모델 목록을 읽지 못했습니다. 다시 시도해 주세요.');
  } finally {
    call.done();
  }
}

/**
 * fetch with Korean errors. Retries 5xx and rate limits (not billing) up to MAX_ATTEMPTS: the wait comes from the
 * error message ("Please try again in 1.2s"; Retry-After is not readable cross-origin) or exponential backoff.
 * Returns the open response plus its abort handle; the caller reads the body and then calls call.done().
 */
async function request(url, { key, method = 'POST', body, signal, timeoutMs, model }) {
  for (let attempt = 1; ; attempt++) {
    const call = linkedAbort(signal, timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: call.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch (err) {
      call.done();
      if (signal?.aborted && !call.timedOut) throw aiError(ABORT_MESSAGE, { code: 'aborted', cause: err });
      if (call.timedOut) throw aiError(TIMEOUT_MESSAGE, { code: 'timeout', cause: err });
      // A POST error answer without CORS headers (e.g. 401 for a bad key) looks like a network failure here.
      throw method === 'POST' ? await diagnoseFailure(key, model, err, signal) : networkError(err);
    }
    if (res.ok) return { res, call };
    const data = await readErrorBody(res);
    call.done();
    const err = httpError(res.status, data, model);
    const wait = retryDelayMs(err, attempt);
    if (attempt >= MAX_ATTEMPTS || wait == null) throw err;
    console.warn('[ai] OpenAI', res.status, `retrying in ${wait} ms`);
    await abortableSleep(wait, signal);
  }
}

async function readErrorBody(res) {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 300) } };
  }
}

function retryDelayMs(err, attempt) {
  if (err.code === 'server') return 1000 * 2 ** (attempt - 1);
  if (err.code !== 'rate_limit') return null;
  const hinted = parseRetryHint(err.detail);
  if (hinted == null) return 1000 * 2 ** attempt;
  return hinted <= MAX_RETRY_DELAY_MS ? hinted + 250 : null;
}

/** "Please try again in 1.234s" / "in 500ms" / "in 1m30s" → ms (null when absent). */
function parseRetryHint(message) {
  const m = /try again in ((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i.exec(String(message || ''));
  if (!m) return null;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let ms = 0;
  for (const [, n, u] of m[1].matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/gi)) ms += Number(n) * unit[u.toLowerCase()];
  return Math.ceil(ms);
}

/**
 * Why a POST failed without a readable answer: the page CSP, then one free GET /v1/models with the same key
 * (401 → bad key; the model missing from the list → not_found), else a plain network error.
 */
async function diagnoseFailure(key, model, cause, signal) {
  if (!isRelayOriginAllowed(`${OPENAI_BASE}/responses`)) {
    console.warn('[ai] OpenAI blocked by the page CSP (connect-src)', cause);
    return aiError(CSP_MESSAGE, { code: 'network', cause });
  }
  const call = linkedAbort(signal, PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${OPENAI_BASE}/models`, {
      headers: { authorization: `Bearer ${key}` }, signal: call.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    const data = await readErrorBody(res);
    if (res.status === 401 || res.status === 403) return httpError(res.status, data, model);
    if (res.ok && model && Array.isArray(data?.data) && !data.data.some((m) => m?.id === model)) {
      return notFoundError(model, 404);
    }
  } catch (err) {
    if (signal?.aborted) return aiError(ABORT_MESSAGE, { code: 'aborted', cause: err });
  } finally {
    call.done();
  }
  return networkError(cause);
}

function networkError(cause) {
  console.warn('[ai] OpenAI network error', cause);
  return aiError(NETWORK_MESSAGE, { code: 'network', cause });
}

/** Error while reading a response body (stream or JSON). */
function bodyFailure(err, signal, call, message) {
  if (err?.name === 'AiError' || err?.code === 'aborted') return err;
  if (signal?.aborted && !call.timedOut) return aiError(ABORT_MESSAGE, { code: 'aborted', cause: err });
  if (call.timedOut) return aiError(TIMEOUT_MESSAGE, { code: 'timeout', cause: err });
  if (err instanceof SyntaxError) {
    console.warn('[ai] OpenAI: unreadable response body', err);
    return aiError(message, { code: 'parse', cause: err });
  }
  return networkError(err);
}

/** An AbortController following `outer`, aborted after `timeoutMs` of inactivity (refresh() restarts the clock). */
function linkedAbort(outer, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  };
  const onAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener('abort', onAbort, { once: true });
  arm();
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    refresh: arm,
    abort: () => controller.abort(),
    done: () => { clearTimeout(timer); outer?.removeEventListener('abort', onAbort); },
  };
}

function abortableSleep(ms, signal) {
  throwIfAborted(signal);
  if (!signal) return sleep(ms);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(aiError(ABORT_MESSAGE, { code: 'aborted' })); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Parse a text/event-stream body into the JSON payloads of its `data:` lines (`event:` lines are redundant). */
async function* readSse(body, onChunk) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      onChunk?.();
      buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = done ? '' : events.pop();
      for (const ev of events) {
        const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data || data === '[DONE]') continue;
        try {
          yield JSON.parse(data);
        } catch (err) {
          console.warn('[ai] OpenAI: unparsable SSE event', data.slice(0, 120), err);
        }
      }
    }
  } finally {
    if (done) reader.releaseLock();
    else reader.cancel().catch(() => {});
  }
}

// ───────────────────────────── errors ─────────────────────────────

function notFoundError(model, status) {
  console.warn('[ai] OpenAI model not found', model, status);
  return aiError(`OpenAI 모델을 찾을 수 없거나 이 API 키로는 쓸 수 없습니다${model ? `(${model})` : ''}. 설정에서 모델 목록을 다시 불러와 다른 모델을 선택해 주세요.`, {
    code: 'not_found', status, model: model || null,
  });
}

/** HTTP error answer → Korean aiError. `detail` keeps OpenAI's own message (for logs and retry hints). */
function httpError(status, data, model) {
  const e = data?.error && typeof data.error === 'object' ? data.error : {};
  const code = String(e.code || '');
  const type = String(e.type || '');
  const detail = String(e.message || '');
  const make = (message, errCode, extra = {}) => {
    console.warn('[ai] OpenAI error', status, type, code, detail);
    return aiError(message, { code: errCode, status, detail, apiCode: code || null, ...extra });
  };
  // Streaming some models needs a verified organization (400, param 'stream'); stream() then falls back to one
  // non-streaming request.
  const streamUnsupported = e.param === 'stream' || (/stream/i.test(detail) && /verif/i.test(detail));
  if (streamUnsupported && [400, 403, 422].includes(status)) return make(VERIFY_MESSAGE, 'bad_request', { streamUnsupported: true });
  // A missing, retired or not-permitted model ("model_not_found" comes as 404, and as 403 for a project without
  // access to it).
  if (code === 'model_not_found' || status === 404) return notFoundError(model, status);
  if (status === 401 || code === 'invalid_api_key') {
    if (/ip\b.*not authorized|allowlist/i.test(detail)) {
      return make('이 IP 주소에서는 이 OpenAI API 키를 쓸 수 없습니다(IP 허용 목록). OpenAI 대시보드에서 프로젝트의 IP 허용 목록을 확인해 주세요.', 'auth');
    }
    if (/member of an organization/i.test(detail)) {
      return make('이 OpenAI 계정이 조직에 속해 있지 않아 API를 쓸 수 없습니다. OpenAI 대시보드에서 조직을 확인해 주세요.', 'auth');
    }
    return make(AUTH_MESSAGE, 'auth');
  }
  if (status === 403) {
    if (code === 'unsupported_country_region_territory' || /country, region, or territory/i.test(detail)) {
      return make('현재 접속한 국가·지역에서는 OpenAI API를 쓸 수 없습니다.', 'permission');
    }
    // "Your organization must be verified to use the model …": the key can use other models — not_found with the
    // model, so getProvider() switches to another model of the key (js/ai/models.js).
    if (/verif/i.test(detail)) return make(VERIFY_MESSAGE, model ? 'not_found' : 'permission', { model: model || null });
    return make('이 API 키로는 요청한 OpenAI 모델이나 기능을 쓸 권한이 없습니다. OpenAI 대시보드에서 프로젝트의 모델 권한과 키 권한'
      + '(제한된 키라면 Models 읽기·Responses 쓰기)을 확인해 주세요.', 'permission', { model: model || null });
  }
  if (status === 429 || status === 402) {
    if (code === 'organization_spend_limit_exceeded' || code === 'project_spend_limit_exceeded') return make(SPEND_LIMIT_MESSAGE, 'billing');
    if (code === 'organization_usage_limit_exceeded') return make(USAGE_LIMIT_MESSAGE, 'billing');
    if (BILLING_CODES.has(code) || type === 'insufficient_quota' || status === 402) return make(NO_CREDIT_MESSAGE, 'billing');
    return make('OpenAI 요청 한도(분당 요청·토큰 수)를 초과했습니다. 잠시 후 다시 시도하거나 설정에서 동시 번역 수를 줄여 주세요.', 'rate_limit');
  }
  if (status === 400 || status === 422) {
    // "Invalid prompt: your prompt was flagged as potentially violating our usage policy" — a refusal, so the
    // translator narrows it down to the one sentence instead of stopping the run.
    if (code === 'invalid_prompt' || /usage polic/i.test(detail)) return refusalError(code || 'invalid_prompt', detail, undefined);
    if (code === 'context_length_exceeded') {
      return make('입력이 모델이 한 번에 읽을 수 있는 길이를 넘었습니다. 더 짧은 내용으로 다시 시도해 주세요.', 'bad_request');
    }
    return make(`OpenAI가 요청을 처리할 수 없습니다(잘못된 요청).${detail ? ` 상세: ${detail}` : ''}`, 'bad_request');
  }
  if (status === 413) return make('요청이 너무 큽니다. 더 짧은 내용으로 다시 시도해 주세요.', 'bad_request');
  if (status >= 500) {
    return make(status === 503 && /overload/i.test(`${code} ${detail}`)
      ? 'OpenAI 서버가 일시적으로 과부하 상태입니다. 잠시 후 다시 시도해 주세요.'
      : 'OpenAI 서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.', 'server');
  }
  return make(`OpenAI API 오류가 발생했습니다(HTTP ${status}). 잠시 후 다시 시도해 주세요.`, 'unknown');
}

/** An `error` event inside a stream. */
function streamEventError(ev, model) {
  const code = String(ev.code || '');
  const status = code === 'rate_limit_exceeded' ? 429
    : BILLING_CODES.has(code) ? 429
      : code === 'model_not_found' ? 404
        : code === 'context_length_exceeded' || code === 'invalid_prompt' ? 400 : 500;
  return httpError(status, { error: { code, message: ev.message, param: ev.param, type: code } }, model);
}

/** status 'failed' (non-streaming body or response.failed event). */
function responseFailedError(error, usage, model) {
  const code = String(error?.code || '');
  const status = code === 'rate_limit_exceeded' ? 429 : BILLING_CODES.has(code) ? 429 : code === 'invalid_prompt' ? 400 : 500;
  const err = httpError(status, { error: { code, message: error?.message, type: code } }, model);
  err.usage = usage;
  return err;
}

function refusalError(category, detail, usage) {
  console.warn('[ai] OpenAI refusal', category, detail);
  return aiError('OpenAI 모델이 안전 정책에 따라 이 요청에 대한 응답을 거절했습니다. 내용을 바꾸거나 설정에서 다른 모델을 선택해 다시 시도해 주세요.', {
    code: 'refusal', category, detail, ...(usage ? { usage } : {}),
  });
}

// ───────────────────────────── responses ─────────────────────────────

/** The answer text and any refusal of a Response; final_answer messages win over commentary. */
function readOutput(response) {
  const messages = (Array.isArray(response?.output) ? response.output : []).filter((it) => it?.type === 'message');
  const finals = messages.filter((it) => it.phase !== 'commentary');
  let text = '';
  let refusal = '';
  for (const item of finals.length ? finals : messages) {
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
      else if (part?.type === 'refusal' && typeof part.refusal === 'string') refusal += part.refusal;
    }
  }
  return { text, refusal };
}

function readResponse(data, { model, json }) {
  const usage = toUsage(data?.usage, data?.model || model);
  if (data?.status === 'failed') throw responseFailedError(data.error, usage, model);
  const { text, refusal } = readOutput(data);
  if (data?.incomplete_details?.reason === 'content_filter') throw refusalError('content_filter', '', usage);
  if (refusal && (!text || json)) throw refusalError(null, refusal, usage);
  const stopReason = data?.status === 'incomplete' ? 'max_tokens' : 'end_turn';
  if (stopReason === 'max_tokens' && json) throw aiError(CUT_OFF_MESSAGE, { code: 'max_tokens', usage, partialText: text });
  const out = { text, usage, stopReason, model: data?.model || model };
  if (json) {
    try {
      out.json = JSON.parse(text);
    } catch (err) {
      console.warn('[ai] OpenAI returned invalid JSON', text.slice(0, 200));
      throw aiError('AI 응답(JSON)을 해석하지 못했습니다. 다시 시도해 주세요.', { code: 'parse', usage, cause: err });
    }
  }
  return out;
}

/**
 * Responses usage → provider-neutral usage. input_tokens includes the cached and cache-written tokens (the prompt
 * caching guide bills "input − cached − cache writes" at the normal rate); reasoning tokens are output tokens.
 */
function toUsage(u, model) {
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const cached = n(u?.input_tokens_details?.cached_tokens);
  const written = n(u?.input_tokens_details?.cache_write_tokens);
  return {
    model,
    inputTokens: Math.max(0, n(u?.input_tokens) - cached - written),
    outputTokens: n(u?.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: written,
  };
}
