// Automatic model selection and self-healing, shared by every provider (Claude, GPT, Gemini, invite-code relay).
//
// - applyModelList / syncModels(provider): from the key's live model list, settings[provider.id].autoModels gets
//   provider.pickDefaultModel(list, kind) for 'translate' (fast/cheap tier) and 'assist' (stronger tier). A model the
//   user picked in 설정 (translateModel / assistModel) is kept unless the list no longer has it, it is a legacy id
//   (provider.isLegacyModel) or it answered not_found recently — then that task goes back to 자동 선택.
// - withModelHealing(provider): the provider as the app uses it (getProvider()). When a call's configured model
//   answers not_found (err.code 'not_found' with err.model), the list is read again, the task switches to the
//   provider's new default (persisted), the user is told once (bus 'ai:model-change') and the call is retried once.
//   Streams heal only when the error arrives before the first text chunk. A call without a model (GPT/Gemini before
//   the key's first model list) picks one first; testKey() also refreshes the models.
// - Models that answered not_found are remembered per key / invite code for MISSING_TTL_MS in localStorage
//   (STORAGE_KEYS.models), so a model the key lists but cannot use is not picked again after a reload or in another
//   tab. Choosing a model in 설정 forgets its mark (the user wants to try it again).
//
// Only core modules are imported here: the shell test stubs re-export this module next to fake providers.
import { bus } from '../core/bus.js';
import { STORAGE_KEYS } from '../core/config.js';
import { settings } from '../core/settings.js';
import { hash, safeStorage } from '../core/util.js';

export const MODEL_KINDS = Object.freeze(['translate', 'assist']);
const MODEL_KEYS = Object.freeze({ translate: 'translateModel', assist: 'assistModel' });
const KIND_LABELS = Object.freeze({ translate: '번역', assist: '요약·채팅' });
/** Providers whose model choice lives in settings[<id>] (the mock has none). */
const MANAGED = new Set(['claude', 'openai', 'gemini', 'relay']);
// A broken model is healed once; requests that were already in flight with it reuse the result for this long.
const HEAL_MEMO_MS = 60_000;
const FAILED_HEAL_MEMO_MS = 5_000;
// How long a model that answered not_found is skipped by the automatic choice (retired models never come back;
// one that needed e.g. a verified organization may, and the user can pick it again at any time).
export const MISSING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** `${provider id}\n${model}` → { promise, at }: one heal per broken model, shared by concurrent requests. */
const heals = new Map();
/** provider id → in-flight model listing for calls that came without a model (shared, one request). */
const listings = new Map();
const wrappers = new WeakMap();
/** The missing-model memory when localStorage is unavailable (private window, blocked storage). */
let memoryMissing = {};

/** 'translate' for translation tasks (also the selection menu's quick translation), else 'assist'. */
export function kindOfTask(task) {
  return task === 'translate' || task === 'quickTranslate' ? 'translate' : 'assist';
}

/** Model id without Gemini's "models/" prefix. */
function bare(id) {
  return String(id || '').replace(/^models\//, '');
}

/** True when `models` lists `id` (or a dated snapshot of it, e.g. "claude-haiku-5-5-20261001" for an alias). */
export function hasModel(models, id) {
  const want = bare(id);
  if (!want) return false;
  return (models || []).some((m) => {
    const got = bare(typeof m === 'string' ? m : m?.id);
    return got === want || (got.startsWith(`${want}-`) && /^\d{8}$/.test(got.slice(want.length + 1)));
  });
}

// ───────────────────────────── missing models ─────────────────────────────
// Stored as { [provider id]: { cred: hash of the key or code, ids: { [model id]: when it answered not_found } } }.

/** Fingerprint of the credential a provider's models belong to: another key or invite code has other models. */
function credentialOf(providerId) {
  const s = settings.get();
  const raw = providerId === 'relay'
    ? `${settings.relayUrl()}\n${String(s.relay?.code || '').trim().toUpperCase()}`
    : String(s[providerId]?.apiKey || '').trim();
  return hash(`${providerId}\n${raw}`);
}

function readMissing() {
  const stored = safeStorage.get(STORAGE_KEYS.models, null);
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : memoryMissing;
}

/** The recent not_found ids of `providerId` for the key / code saved now. */
function missingIds(providerId) {
  const entry = readMissing()[providerId];
  if (!entry || entry.cred !== credentialOf(providerId) || !entry.ids || typeof entry.ids !== 'object') return new Map();
  const since = Date.now() - MISSING_TTL_MS;
  return new Map(Object.entries(entry.ids).filter(([, at]) => Number(at) > since));
}

function writeMissing(providerId, ids) {
  const data = { ...readMissing() };
  if (ids.size) data[providerId] = { cred: credentialOf(providerId), ids: Object.fromEntries(ids) };
  else delete data[providerId];
  memoryMissing = data;
  safeStorage.set(STORAGE_KEYS.models, data);
}

/** Remember that `id` answered not_found on `providerId` for the current key (skipped by the automatic choice). */
export function markModelMissing(providerId, id) {
  if (!id || !providerId) return;
  const ids = missingIds(providerId);
  ids.set(bare(id), Date.now());
  writeMissing(providerId, ids);
}

/** Forget a not_found mark (the user chose the model again). */
export function clearModelMissing(providerId, id) {
  const ids = missingIds(providerId);
  if (ids.delete(bare(id))) writeMissing(providerId, ids);
}

export function isModelMissing(providerId, id) {
  return Boolean(id) && missingIds(providerId).has(bare(id));
}

/** For tests: forget missing models, finished heals and pending listings. */
export function resetModelState() {
  heals.clear();
  listings.clear();
  memoryMissing = {};
  safeStorage.remove(STORAGE_KEYS.models);
}

// A model chosen in 설정 is tried again even if it answered not_found before (e.g. after verifying the organization).
bus.on('settings:change', ({ patch } = {}) => {
  if (!patch || typeof patch !== 'object') return;
  for (const id of MANAGED) {
    const p = patch[id];
    if (!p || typeof p !== 'object') continue;
    for (const key of Object.values(MODEL_KEYS)) if (typeof p[key] === 'string' && p[key]) clearModelMissing(id, p[key]);
  }
});

/**
 * Update settings[provider.id] from a live model list (see the file comment). An empty list changes nothing
 * (listing failed or the key has no usable model: nothing to compare with).
 * @param {{ id: string, pickDefaultModel?: Function, isLegacyModel?: Function }} provider
 * @param {({ id: string } | string)[]} models newest first
 * @returns {{ changes: { kind: string, from: string, to: string, reason: 'auto'|'unlisted'|'legacy'|'missing' }[] }}
 */
export function applyModelList(provider, models) {
  const id = provider?.id;
  if (!MANAGED.has(id)) return { changes: [] };
  const list = (Array.isArray(models) ? models : [])
    .map((m) => (typeof m === 'string' ? { id: m } : m))
    .filter((m) => m && typeof m.id === 'string' && m.id);
  if (!list.length) return { changes: [] };
  const missingNow = missingIds(id);
  const gone = (modelId) => Boolean(modelId) && missingNow.has(bare(modelId));
  const usable = list.filter((m) => !gone(m.id));
  const conf = settings.get()[id] || {};
  const before = Object.fromEntries(MODEL_KINDS.map((kind) => [kind, settings.model(kind, id)]));
  const auto = { translate: '', assist: '', ...(conf.autoModels || {}) };
  const patch = {};
  const reasons = {};
  for (const kind of MODEL_KINDS) {
    const pick = usable.length ? bare(provider.pickDefaultModel?.(usable, kind) || '') : '';
    if (pick && !gone(pick)) auto[kind] = pick;
    else if (gone(auto[kind])) auto[kind] = ''; // nothing usable left: do not keep sending a model known to be gone
    const chosen = conf[MODEL_KEYS[kind]] || '';
    if (!chosen) continue;
    const reason = gone(chosen) ? 'missing'
      : !hasModel(list, chosen) ? 'unlisted'
        : provider.isLegacyModel?.(chosen) ? 'legacy' : '';
    if (reason) {
      patch[MODEL_KEYS[kind]] = '';
      reasons[kind] = reason;
    }
  }
  if (MODEL_KINDS.some((kind) => auto[kind] !== (conf.autoModels?.[kind] || ''))) patch.autoModels = auto;
  if (Object.keys(patch).length) settings.set({ [id]: patch });
  const changes = MODEL_KINDS
    .map((kind) => ({ kind, from: before[kind], to: settings.model(kind, id), reason: reasons[kind] || 'auto' }))
    .filter((c) => c.from !== c.to);
  return { changes };
}

/**
 * Read the provider's live model list (or use `models` when the caller already has it) and apply it.
 * Listing errors are thrown as the provider's Korean aiError.
 * @returns {Promise<{ models: object[], changes: object[] }>}
 */
export async function syncModels(provider, { models, signal } = {}) {
  if (!MANAGED.has(provider?.id)) return { models: [], changes: [] };
  const list = Array.isArray(models) ? models : await provider.listModels({ signal });
  return { models: list, ...applyModelList(provider, list) };
}

/**
 * Korean sentences for a status line ('' when nothing changed): one per replaced model, then one for the
 * automatic picks, e.g. "자동 선택: 번역 gpt-6-luna, 요약·채팅 gpt-6.1-sol."
 */
export function describeModelChanges(changes) {
  const out = [];
  const replaced = new Set();
  const picks = new Map(); // model → kind labels
  for (const c of changes || []) {
    if (!c.to) continue;
    if (c.reason !== 'auto' && c.from) {
      const key = `${c.from}\n${c.to}`;
      if (replaced.has(key)) continue;
      replaced.add(key);
      out.push(c.reason === 'legacy'
        ? `새 키로는 쓸 수 없는 이전 모델(${c.from})을 ${c.to}(으)로 바꿨습니다.`
        : `${c.from} 모델을 쓸 수 없어 ${c.to}(으)로 바꿨습니다.`);
    } else {
      picks.set(c.to, [...(picks.get(c.to) || []), KIND_LABELS[c.kind] || c.kind]);
    }
  }
  if (picks.size) out.push(`자동 선택: ${[...picks].map(([model, kinds]) => `${kinds.join('·')} ${model}`).join(', ')}.`);
  return out.join(' ');
}

/**
 * The provider with automatic model choice and self-healing (see the file comment). Same contract; the mock and
 * unknown providers are returned as they are.
 */
export function withModelHealing(provider) {
  if (!provider || !MANAGED.has(provider.id)) return provider;
  let wrapped = wrappers.get(provider);
  if (!wrapped) {
    wrapped = {
      ...provider,
      complete: (opts) => completeHealing(provider, opts),
      stream: (opts) => streamHealing(provider, opts),
      testKey: () => testKeyAndSync(provider),
      unwrapped: provider,
    };
    wrappers.set(provider, wrapped);
  }
  return wrapped;
}

// ───────────────────────────── internals ─────────────────────────────

function taskKind(providerId, opts) {
  if (opts?.task) return kindOfTask(opts.task);
  return opts?.model && bare(opts.model) === bare(settings.model('translate', providerId)) ? 'translate' : 'assist';
}

/** Same shape as providers.js aiError() (not imported: see the note at the imports). */
function modelError(message, extra = {}) {
  const err = new Error(message);
  err.name = extra.code === 'aborted' ? 'AbortError' : 'AiError';
  return Object.assign(err, { code: 'not_found', fatal: extra.code !== 'aborted' }, extra);
}

/** `promise`, or a Korean AbortError as soon as `signal` aborts (the shared work itself goes on for the others). */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  const aborted = () => modelError('요청을 취소했습니다.', { code: 'aborted' });
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * A call without a model (GPT/Gemini before the key's first model list): read the list once (shared by calls that
 * arrive meanwhile) and use its pick. A key with no usable model fails here, before any paid request.
 */
async function prepare(provider, options) {
  const kind = taskKind(provider.id, options);
  if (options?.model) return { opts: options, kind };
  let listing = listings.get(provider.id);
  if (!listing) {
    listing = syncModels(provider).finally(() => listings.delete(provider.id));
    listings.set(provider.id, listing);
  }
  await untilAborted(listing, options?.signal);
  const model = settings.model(kind, provider.id);
  if (!model) {
    throw modelError(`이 API 키로 쓸 수 있는 ${provider.label || provider.id} 모델을 찾지 못했습니다. 설정 → AI 번역에서 ‘모델 목록 불러오기’로 `
      + '키의 모델을 확인하거나 다른 키를 입력해 주세요.', { model: null });
  }
  return { opts: { ...options, model }, kind };
}

/**
 * The model to retry with after `err`, or '' (not a missing configured model, or no other model to switch to).
 * Concurrent and late failures of the same model share one heal (one list request, one notice).
 */
function healedModel(provider, err, opts, kind) {
  if (err?.code !== 'not_found' || !err.model || opts?.signal?.aborted) return '';
  const old = bare(opts.model);
  if (!old || bare(err.model) !== old) return '';
  const key = `${provider.id}\n${old}`;
  const memo = heals.get(key);
  if (memo && Date.now() - memo.at < (memo.failed ? FAILED_HEAL_MEMO_MS : HEAL_MEMO_MS)) return memo.promise;
  // Only the model configured for a task is replaced; a model a caller asked for explicitly is left alone.
  const kinds = MODEL_KINDS.filter((k) => bare(settings.model(k, provider.id)) === old);
  if (!kinds.length) return '';
  const promise = heal(provider, old, kinds.includes(kind) ? kind : kinds[0]);
  const entry = { promise, at: Date.now(), failed: false };
  // A heal that found nothing (list unreadable, no other model) is shared only by the requests failing with it
  // right now; a later request may try again (the list may be readable by then).
  promise.then((next) => { entry.at = Date.now(); entry.failed = !next; }, () => { entry.failed = true; });
  heals.set(key, entry);
  return promise;
}

async function heal(provider, old, kind) {
  markModelMissing(provider.id, old);
  let list;
  try {
    list = await provider.listModels();
  } catch (err) {
    console.warn('[ai] could not list models after', old, 'was not found:', err?.message || err);
    return '';
  }
  applyModelList(provider, list);
  const next = settings.model(kind, provider.id);
  if (!next || bare(next) === old) return '';
  console.warn('[ai] model not found:', old, '→ switched to', next);
  bus.emit('ai:model-change', {
    provider: provider.id, kind, from: old, to: next,
    message: `${old} 모델을 쓸 수 없어 ${next}(으)로 바꿨습니다.`,
  });
  return next;
}

async function completeHealing(provider, options) {
  const { opts, kind } = await prepare(provider, options);
  try {
    return await provider.complete(opts);
  } catch (err) {
    const next = await healedModel(provider, err, opts, kind);
    if (!next) throw err;
    return provider.complete({ ...opts, model: next });
  }
}

async function* streamHealing(provider, options) {
  const { opts, kind } = await prepare(provider, options);
  let model = opts.model;
  let textSeen = false;
  try {
    for await (const ev of provider.stream(opts)) {
      if (ev?.type === 'text') textSeen = true;
      yield withModel(ev, model);
    }
    return;
  } catch (err) {
    // Part of the answer is already shown: a retry on another model would start it over.
    if (textSeen) throw err;
    const next = await healedModel(provider, err, opts, kind);
    if (!next) throw err;
    model = next;
  }
  for await (const ev of provider.stream({ ...opts, model })) yield withModel(ev, model);
}

/** The stream's final event names the model that answered (it differs from the request's after a heal). */
function withModel(ev, model) {
  return ev?.type === 'done' && !ev.model ? { ...ev, model } : ev;
}

/**
 * testKey(), then the key's models (the test's own list when it returns one): the result also carries `models` and
 * `changes`, and the message says what changed.
 */
async function testKeyAndSync(provider) {
  const res = await provider.testKey();
  if (!res?.ok) return res;
  try {
    const { models, changes } = await syncModels(provider, { models: Array.isArray(res.models) ? res.models : undefined });
    const note = describeModelChanges(changes);
    return { ...res, models, changes, message: note ? `${res.message} ${note}` : res.message };
  } catch (err) {
    console.warn('[ai] listing models after the key test failed:', err?.message || err);
    return res;
  }
}
