// User settings persisted in localStorage (this browser only). Secrets live here too:
// they never leave the browser except as auth headers to their own API.
import { bus } from './bus.js';
import { DEFAULT_MODELS, RELAY_DEFAULT_URL, STORAGE_KEYS } from './config.js';
import { deepMerge, safeStorage } from './util.js';

// Model choice, per provider: translateModel / assistModel hold the model the user picked in 설정 ('' = 자동 선택);
// autoModels holds the automatic picks from the key's last live model list (js/ai/models.js). The model used is
// the user's pick, else the automatic one, else DEFAULT_MODELS.
const noModels = () => ({ translateModel: '', assistModel: '', autoModels: { translate: '', assist: '' } });

export const DEFAULT_SETTINGS = Object.freeze({
  provider: 'claude', // 'relay' | 'claude' | 'openai' | 'gemini' | 'mock'
  // Invite-code relay (docs/RELAY.md). url '' = RELAY_DEFAULT_URL (so a moved worker reaches everyone who never
  // typed an address); name/allowedModels mirror the last GET /relay/me.
  relay: { url: '', code: '', adminToken: '', name: '', allowedModels: [], ...noModels() },
  claude: { apiKey: '', ...noModels() },
  openai: { apiKey: '', ...noModels() },
  gemini: { apiKey: '', ...noModels() },
  github: { owner: '', repo: '', branch: 'main', token: '' },
  semanticScholar: { apiKey: '' },
  translate: {
    targetLang: 'ko',
    keepTermsInEnglish: true, // e.g. "기계환기(mechanical ventilation)" on first mention
    translateReferences: false,
    glossary: [], // [{ src: 'delirium', tgt: '섬망' }]
    concurrency: 3,
  },
  ui: { theme: 'light', fontSize: 15, syncScroll: true, showAutoHighlights: true },
});

const MODEL_KEYS = { translate: 'translateModel', assist: 'assistModel' };
// Before automatic model selection (settings written before 2026-10-18 have no autoModels): Claude's model fields
// were prefilled with these defaults, and Gemini's were filled by the old automatic pick (newest plain Flash, or a
// 2.x id that new keys cannot use).
const PREFILLED_CLAUDE = { translateModel: 'claude-haiku-5-5', assistModel: 'claude-sonnet-5-5' };
const OLD_GEMINI_AUTO = /^gemini-\d+(\.\d+)?-flash$|^gemini-flash-latest$/;
const OLD_GEMINI_LEGACY = /^gemini-[0-2](\.\d+)?-/;

/**
 * Stored settings from before automatic model selection: prefilled Claude defaults and Gemini's old automatic picks
 * become 자동 선택 (the same model until the key's live list says otherwise; a 2.x Gemini id is dropped so the
 * first use picks a current one). Any other saved model stays the user's choice.
 */
function migrate(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const out = { ...raw };
  const claude = raw.claude;
  if (claude && typeof claude === 'object' && !claude.autoModels) {
    out.claude = { ...claude };
    for (const [key, prefilled] of Object.entries(PREFILLED_CLAUDE)) if (claude[key] === prefilled) out.claude[key] = '';
  }
  const gemini = raw.gemini;
  if (gemini && typeof gemini === 'object' && !gemini.autoModels) {
    out.gemini = { ...gemini, autoModels: { translate: '', assist: '' } };
    for (const [kind, key] of Object.entries(MODEL_KEYS)) {
      const id = typeof gemini[key] === 'string' ? gemini[key] : '';
      if (OLD_GEMINI_AUTO.test(id)) out.gemini.autoModels[kind] = id;
      if (OLD_GEMINI_AUTO.test(id) || OLD_GEMINI_LEGACY.test(id)) out.gemini[key] = '';
    }
  }
  return out;
}

const readStored = () => deepMerge(structuredClone(DEFAULT_SETTINGS), migrate(safeStorage.get(STORAGE_KEYS.settings, {})));

// What is persisted, and what the app sees. They differ only by the session-only mock override,
// which must never be written back to localStorage.
let stored = readStored();

// `?mock=1` forces the offline mock provider (used by tests and demos; never calls a paid API).
let mockOverride = false;
try {
  mockOverride = new URLSearchParams(location.search).get('mock') === '1';
  // Test harness pages are published with the site (same origin, same stored keys): away from a local dev server
  // they always run on the mock provider, so a crafted link to one can never spend the user's API credit.
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!local && /\/tests\//.test(location.pathname)) mockOverride = true;
} catch { /* non-browser */ }

const view = () => (mockOverride ? { ...stored, provider: 'mock' } : stored);
let current = view();

// Another tab changed the settings (e.g. "키·토큰 지우기"): take them over, so this tab neither keeps using a
// cleared key/token nor writes its stale copy back on its next settings.set().
try {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEYS.settings && e.key !== null) return;
    stored = readStored();
    current = view();
    bus.emit('settings:change', { settings: current, patch: null, external: true });
  });
} catch { /* non-browser */ }

export const settings = {
  get() { return current; },
  /** True when the session is pinned to the mock provider via ?mock=1. */
  get isMockSession() { return mockOverride; },
  /** Deep-merge a patch, persist, and broadcast 'settings:change'. Arrays are replaced, not merged. */
  set(patch) {
    // Merge into what is stored now, not into this tab's possibly stale copy (memory only when nothing is
    // stored, e.g. storage blocked in a private window).
    const persisted = safeStorage.get(STORAGE_KEYS.settings, null);
    stored = deepMerge(persisted && typeof persisted === 'object' ? readStored() : stored, patch);
    safeStorage.set(STORAGE_KEYS.settings, stored);
    current = view();
    bus.emit('settings:change', { settings: current, patch });
    return current;
  },
  reset() {
    stored = structuredClone(DEFAULT_SETTINGS);
    safeStorage.remove(STORAGE_KEYS.settings);
    current = view();
    bus.emit('settings:change', { settings: current, patch: null });
  },
  /**
   * Model id for a task. kind: 'translate' | 'assist'; provider: default the active one. The user's pick in 설정,
   * else the automatic pick from the key's live model list, else DEFAULT_MODELS ('' for GPT/Gemini before the
   * first list: js/ai/models.js lists the key's models on first use).
   */
  model(kind, provider = current.provider) {
    if (provider === 'mock') return 'mock';
    if (provider === 'relay') return relayModel(current.relay || {}, kind);
    const conf = current[provider] || {};
    return conf[MODEL_KEYS[kind]] || conf.autoModels?.[kind] || DEFAULT_MODELS[provider]?.[kind] || '';
  },
  isAiReady() {
    const p = current.provider;
    if (p === 'mock') return true;
    if (p === 'relay') return Boolean(settings.relayUrl() && String(current.relay?.code || '').trim());
    // A saved key is enough: the models are picked from the key's live list when it is saved or tested, or on
    // first use.
    return Boolean(String(current[p]?.apiKey || '').trim());
  },
  /** Base URL of the invite-code relay (saved address, else RELAY_DEFAULT_URL), without trailing slashes. */
  relayUrl() {
    return String(current.relay?.url || RELAY_DEFAULT_URL || '').trim().replace(/\/+$/, '');
  },
  isSyncReady() {
    const g = current.github;
    return Boolean(g.owner && g.repo && g.token);
  },
};

/**
 * Relay model for a task: the saved choice if the code allows it, else the automatic pick (from the code's allowed
 * models), else Haiku 5.5 for translation and Sonnet 5.5 (when allowed, else Haiku 5.5) for summaries/chat.
 * Unknown allowed models (no /relay/me yet) → Haiku 5.5.
 */
function relayModel(conf, kind) {
  const allowed = Array.isArray(conf.allowedModels) ? conf.allowedModels.filter((m) => typeof m === 'string' && m) : [];
  const usable = (id) => Boolean(id) && (!allowed.length || allowed.includes(id));
  const saved = conf[MODEL_KEYS[kind]];
  if (usable(saved)) return saved;
  const auto = conf.autoModels?.[kind];
  if (usable(auto)) return auto;
  const { translate, assist } = DEFAULT_MODELS.relay;
  const preferred = kind === 'translate' ? [translate] : [assist, translate];
  return preferred.find((id) => allowed.includes(id)) || allowed[0] || translate;
}
