// User settings persisted in localStorage (this browser only). Secrets live here too:
// they never leave the browser except as auth headers to their own API.
import { bus } from './bus.js';
import { DEFAULT_MODELS, STORAGE_KEYS } from './config.js';
import { deepMerge, safeStorage } from './util.js';

export const DEFAULT_SETTINGS = Object.freeze({
  provider: 'claude', // 'claude' | 'gemini' | 'mock'
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

let current = deepMerge(structuredClone(DEFAULT_SETTINGS), safeStorage.get(STORAGE_KEYS.settings, {}));

// `?mock=1` forces the offline mock provider (used by tests and demos; never calls a paid API).
try {
  if (new URLSearchParams(location.search).get('mock') === '1') current.provider = 'mock';
} catch { /* non-browser */ }

export const settings = {
  get() { return current; },
  /** Deep-merge a patch, persist, and broadcast 'settings:change'. Arrays are replaced, not merged. */
  set(patch) {
    current = deepMerge(current, patch);
    safeStorage.set(STORAGE_KEYS.settings, current);
    bus.emit('settings:change', { settings: current, patch });
    return current;
  },
  reset() {
    current = structuredClone(DEFAULT_SETTINGS);
    safeStorage.remove(STORAGE_KEYS.settings);
    bus.emit('settings:change', { settings: current, patch: null });
  },
  /** Model id for a task on the active provider. kind: 'translate' | 'assist'. */
  model(kind) {
    const p = current.provider;
    if (p === 'mock') return 'mock';
    const conf = current[p] || {};
    return (kind === 'translate' ? conf.translateModel : conf.assistModel) || DEFAULT_MODELS[p]?.[kind] || '';
  },
  isAiReady() {
    const p = current.provider;
    if (p === 'mock') return true;
    return Boolean(current[p]?.apiKey) && Boolean(settings.model('translate'));
  },
  isSyncReady() {
    const g = current.github;
    return Boolean(g.owner && g.repo && g.token);
  },
};
