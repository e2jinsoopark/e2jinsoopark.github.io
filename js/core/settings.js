// User settings persisted in localStorage (this browser only). Secrets live here too:
// they never leave the browser except as auth headers to their own API.
import { bus } from './bus.js';
import { DEFAULT_MODELS, RELAY_DEFAULT_URL, STORAGE_KEYS } from './config.js';
import { deepMerge, safeStorage } from './util.js';

export const DEFAULT_SETTINGS = Object.freeze({
  provider: 'claude', // 'relay' | 'claude' | 'gemini' | 'mock'
  // Invite-code relay (docs/RELAY.md). url '' = RELAY_DEFAULT_URL (so a moved worker reaches everyone who never
  // typed an address); name/allowedModels mirror the last GET /relay/me; models '' = default for the code.
  relay: { url: '', code: '', adminToken: '', name: '', allowedModels: [], translateModel: '', assistModel: '' },
  claude: { apiKey: '', translateModel: DEFAULT_MODELS.claude.translate, assistModel: DEFAULT_MODELS.claude.assist },
  gemini: { apiKey: '', translateModel: '', assistModel: '' },
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

// What is persisted, and what the app sees. They differ only by the session-only mock override,
// which must never be written back to localStorage.
let stored = deepMerge(structuredClone(DEFAULT_SETTINGS), safeStorage.get(STORAGE_KEYS.settings, {}));

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
const readStored = () => deepMerge(structuredClone(DEFAULT_SETTINGS), safeStorage.get(STORAGE_KEYS.settings, {}));

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
  /** Model id for a task on the active provider. kind: 'translate' | 'assist'. */
  model(kind) {
    const p = current.provider;
    if (p === 'mock') return 'mock';
    if (p === 'relay') return relayModel(current.relay || {}, kind);
    const conf = current[p] || {};
    return (kind === 'translate' ? conf.translateModel : conf.assistModel) || DEFAULT_MODELS[p]?.[kind] || '';
  },
  isAiReady() {
    const p = current.provider;
    if (p === 'mock') return true;
    if (p === 'relay') return Boolean(settings.relayUrl() && String(current.relay?.code || '').trim());
    return Boolean(current[p]?.apiKey) && Boolean(settings.model('translate'));
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
 * Relay model for a task: the saved choice if the code allows it, else Haiku 5.5 for translation and Sonnet 5.5
 * (when allowed, else Haiku 5.5) for summaries/chat. Unknown allowed models (no /relay/me yet) → Haiku 5.5.
 */
function relayModel(conf, kind) {
  const allowed = Array.isArray(conf.allowedModels) ? conf.allowedModels.filter((m) => typeof m === 'string' && m) : [];
  const saved = kind === 'translate' ? conf.translateModel : conf.assistModel;
  if (saved && (!allowed.length || allowed.includes(saved))) return saved;
  const { translate, assist } = DEFAULT_MODELS.relay;
  const preferred = kind === 'translate' ? [translate] : [assist, translate];
  return preferred.find((id) => allowed.includes(id)) || allowed[0] || translate;
}
