// App bootstrap: theme, module loading with graceful degradation, Library, hash router.
// Routes: #/ (내 서재) · #/trash (내 서재 휴지통) · #/paper/<id> (reader) · #/settings[/<section>] · #/join/<CODE> (invite link)
//         #/s/<lib> (공용 서재) · #/s/<lib>/trash · #/s/<lib>/activity · #/s/<lib>/paper/<id>   (docs/SHARED.md)
// A fresh visitor (no AI, no invite code, nothing in 내 서재) sees the first screen (ui/start-view.js) instead of the
// library; docs/notes/onboarding.md.
import { bus } from './core/bus.js';
import { APP_VERSION, STORAGE_KEYS } from './core/config.js';
import { settings } from './core/settings.js';
import { clamp, el, safeStorage } from './core/util.js';
import { button, closeAllLayers, iconButton, messageScreen, modal, spinner, toast, uiState } from './ui/components.js';
import { icon } from './ui/icons.js';
import { isStandalone, setupInstall } from './ui/install.js';
import { mountLibraryView } from './ui/library-view.js';
import { mountReaderView } from './ui/reader-view.js';
import { mountSettingsView } from './ui/settings-view.js';
import { mountStartView } from './ui/start-view.js';

/** Modules owned by other builders, loaded dynamically so one broken module cannot blank the app. */
const MODULES = [
  { key: 'library', path: './store/library.js', exports: ['Library'], label: '라이브러리 저장소', critical: true },
  { key: 'github', path: './store/github.js', exports: ['GitHubClient'], label: 'GitHub 연결' },
  { key: 'pdfjs', path: './pdf/pdfjs.js', exports: ['loadPdf'], label: 'PDF 엔진' },
  { key: 'extract', path: './pdf/extract.js', exports: ['extractDocument', 'quickMeta'], label: 'PDF 텍스트 분석' },
  { key: 'viewer', path: './pdf/viewer.js', exports: ['PdfViewer'], label: 'PDF 뷰어' },
  { key: 'providers', path: './ai/providers.js', exports: ['getProvider'], label: 'AI 제공자' },
  { key: 'translator', path: './ai/translator.js', exports: ['Translator'], label: '번역 엔진' },
  { key: 'usage', path: './ai/usage.js', exports: ['usageSummary'], label: '사용량 집계' },
  { key: 'features', path: './features/index.js', exports: ['panels', 'installReaderFeatures'], label: '부가 기능(요약·채팅·메모·관련 논문)' },
];

/** Last GET /shared answer, so 공용 서재 opens from this device's copy at once (offline too). */
const SHARED_CACHE_KEY = 'pr.shared.v1';
/** IndexedDB name prefix of the team libraries (one database per library and person). */
const SHARED_DB_PREFIX = 'paper-reader-shared-';
/** First visit of an invitee without a remembered library list: wait this long for GET /shared before routing. */
const INVITEE_FIRST_WAIT_MS = 2500;

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
/** Browser/OS title-bar colour per theme (= --bg in css/app.css; also index.html and manifest.webmanifest). */
const THEME_COLOR = { light: '#f7f3ec', dark: '#191411' };

boot().catch((err) => {
  console.warn('[app] boot failed', err);
  showFatal(document.getElementById('view') || document.getElementById('app'), {
    title: '앱을 시작할 수 없습니다',
    message: '예기치 않은 오류로 앱을 시작하지 못했습니다. 페이지를 새로 고쳐 보세요.',
    details: errorText(err),
  });
});

async function boot() {
  setupInstall(); // first: the web app manifest (not on iOS) and the browser's install events (ui/install.js)
  applyTheme();
  applyFontSize();
  bus.on('settings:change', () => { applyTheme(); applyFontSize(); });
  darkQuery.addEventListener('change', applyTheme);
  installGlobalErrorHandlers();
  console.info('[app] 갈피 (GALPI)', APP_VERSION);

  const appEl = document.getElementById('app');
  const bannerHost = el('div', { class: 'app-banner-host' });
  const viewEl = el('div', { class: 'view', id: 'view' });
  appEl.replaceChildren(bannerHost, viewEl);
  viewEl.replaceChildren(el('div', { class: 'boot' }, el('div', { class: 'boot-inner' }, spinner(18), '갈피를 준비하는 중…')));

  const { modules, failures } = await loadModules();
  const criticalFailures = failures.filter((f) => f.critical);
  if (criticalFailures.length) {
    showFatal(viewEl, {
      title: '앱을 시작할 수 없습니다',
      message: '필수 구성 요소를 불러오지 못했습니다. 잠시 후 새로 고치거나, 브라우저 캐시를 지운 뒤(Ctrl+Shift+R) 다시 시도하세요.',
      details: failureText(failures),
    });
    return;
  }

  let library;
  try {
    library = await modules.library.Library.open({ settings });
  } catch (err) {
    console.warn('[app] Library.open', err);
    showFatal(viewEl, {
      title: '라이브러리를 열 수 없습니다',
      message: /[가-힣]/.test(err?.message || '')
        ? err.message
        : '브라우저 저장소(IndexedDB)를 사용할 수 없습니다. 시크릿 창이거나 사이트 데이터 저장이 차단되어 있는지 확인하세요.',
      details: [errorText(err), failureText(failures)].filter(Boolean).join('\n\n'),
    });
    return;
  }

  // IndexedDB write failures (e.g. storage quota) surface only through this event.
  library.addEventListener('error', (e) => {
    toast(e.detail?.message || '변경 내용을 이 기기에 저장하지 못했습니다.', { kind: 'error', timeout: 8000 });
  });

  // Settings changed in another tab (e.g. the GitHub token was cleared there): this tab's sync must follow.
  let syncedGithub = JSON.stringify(settings.get().github || {});
  bus.on('settings:change', ({ external } = {}) => {
    const now = JSON.stringify(settings.get().github || {});
    if (now === syncedGithub) return;
    syncedGithub = now;
    if (external) library.reconfigureSync?.().catch((err) => console.warn('[app] reconfigureSync', err));
  });

  // A configured model that no longer exists was replaced (js/ai/models.js): say so once.
  bus.on('ai:model-change', ({ message } = {}) => { if (message) toast(message, { kind: 'warning', timeout: 8000 }); });

  const shared = new SharedLibraries({ store: modules.library, relay: modules.providers?.relay ?? null });
  const deps = buildDeps(modules, library, failures, shared);
  if (failures.length) showBanner(bannerHost, failures);
  refreshRelayIdentity(deps);

  // 공용 서재 follows the saved invite code and server (a join link, 설정, 키·토큰 지우기, another tab).
  let sharedKey = shared.settingsKey();
  bus.on('settings:change', () => {
    const now = shared.settingsKey();
    if (now === sharedKey) return;
    sharedKey = now;
    shared.start().catch((err) => console.warn('[app] shared libraries', err));
  });
  // Resolves once the remembered list is applied (at once), or after the first GET /shared when there is none.
  const started = shared.start().catch((err) => console.warn('[app] shared libraries', err));
  // An invitee's library home is 공용 서재: know it before the first route. A first visit (no remembered list)
  // gives GET /shared a moment, so they do not first see an empty 내 서재.
  if (shared.isInvitee()) await Promise.race([started, new Promise((r) => setTimeout(r, INVITEE_FIRST_WAIT_MS))]);
  startRouter(viewEl, deps);
}

/**
 * Invite-code users: re-read the code's allowed models once per visit (the owner may have changed them), so the
 * next request asks for a model the code allows. Quiet — a bad code is reported where it is used.
 */
function refreshRelayIdentity(deps) {
  const s = settings.get();
  if (s.provider !== 'relay' || !s.relay?.code || parseRoute(location.hash).name === 'join') return;
  deps.relay?.refreshMe?.().catch((err) => console.warn('[app] invite code check', err?.message || err));
}

// ------------------------------------------------------------------ modules

async function loadModules() {
  const results = await Promise.allSettled(MODULES.map((m) => import(m.path)));
  const modules = {};
  const failures = [];
  results.forEach((res, i) => {
    const spec = MODULES[i];
    if (res.status === 'rejected') {
      failures.push({ ...spec, error: res.reason });
      return;
    }
    const missing = spec.exports.filter((name) => res.value[name] === undefined);
    if (missing.length) {
      failures.push({ ...spec, error: new Error(`필요한 export가 없습니다: ${missing.join(', ')}`) });
      return;
    }
    modules[spec.key] = res.value;
  });
  for (const f of failures) console.warn(`[app] module failed: ${f.path}`, f.error);
  return { modules, failures };
}

function buildDeps(m, library, failures, shared) {
  return {
    library,
    shared, // 공용 서재 (team libraries behind the relay); shared.enabled is false without an invite code
    loadPdf: m.pdfjs?.loadPdf ?? null,
    extractDocument: m.extract?.extractDocument ?? null,
    quickMeta: m.extract?.quickMeta ?? null,
    PdfViewer: m.viewer?.PdfViewer ?? null,
    Translator: m.translator?.Translator ?? null,
    getProvider: m.providers?.getProvider ?? null,
    refreshModels: m.providers?.refreshModels ?? null, // live model list → automatic model choice (js/ai/models.js)
    describeModelChanges: m.providers?.describeModelChanges ?? null,
    relay: m.providers?.relay ?? null, // js/ai/relay.js, re-exported by providers.js
    usage: m.usage ?? null,
    GitHubClient: m.github?.GitHubClient ?? null,
    features: m.features
      ? { panels: Array.isArray(m.features.panels) ? m.features.panels : [], installReaderFeatures: m.features.installReaderFeatures }
      : null,
    failures,
  };
}

// ------------------------------------------------------- 공용 서재 (shared)

/**
 * The team libraries ("공용 서재", docs/SHARED.md) the saved invite code may use, each a Library of its own
 * (separate IndexedDB, synced through the relay's GitHub-compatible proxy with the code as the token).
 * Local-first like 내 서재: the last GET /shared answer is remembered, so the libraries open from this device's copy
 * at once (offline too) while the list is re-read in the background. Views get it as `deps.shared`.
 *
 * state: 'off' (no code) · 'loading' (first GET /shared) · 'ready' · 'error' (no list and GET /shared failed) ·
 *        'unavailable' (the server offers no team library to this code)
 * events: 'change' (state, list, a library opened or failed)
 */
class SharedLibraries extends EventTarget {
  #store;
  #relay;
  #state = 'off';
  #message = '';
  #info = null; // { libraries: [{ id, name }], personId, name }
  #entries = new Map(); // id → { id, name, library, status: 'opening'|'ready'|'error', error, promise }
  #run = 0; // bumped by every (re)start; late answers of an older run are dropped
  #starting = Promise.resolve();

  constructor({ store, relay }) {
    super();
    this.#store = store;
    this.#relay = relay;
  }

  get state() { return this.#state; }
  /** Korean reason for 'error'. */
  get message() { return this.#message; }
  /** True when the sidebar shows a 공용 서재 section (also while connecting or after an error). */
  get enabled() { return this.#state === 'loading' || this.#state === 'ready' || this.#state === 'error'; }
  get personId() { return this.#info?.personId || ''; }
  /** The invite code's name (the relay's), shown in 설정 and as "who" of this person's changes. */
  get personName() { return this.#info?.name || settings.get().relay?.name || ''; }
  /** [{ id, name, library, status, error }] in the server's order. */
  get libraries() {
    return [...this.#entries.values()].map(({ id, name, library, status, error }) => ({ id, name, library, status, error }));
  }

  /** The opened Library of team library `id`, or null (unknown, still opening, failed). */
  get(id) { return this.#entries.get(id)?.library ?? null; }
  entry(id) {
    const e = this.#entries.get(id);
    return e ? { id: e.id, name: e.name, library: e.library, status: e.status, error: e.error } : null;
  }

  /** Wait until team library `id` is open (null when it is unknown or failed to open). */
  async open(id) {
    await this.#starting;
    const e = this.#entries.get(id);
    return e ? e.promise : null;
  }

  /** Changes when the code or the server changes (app.js restarts then). */
  settingsKey() {
    return `${settings.relayUrl()}\n${this.#code()}`;
  }

  /**
   * An invitee: has an invite code, no GitHub sync of their own and uses the code for AI. Their library home is
   * 공용 서재 until they pick 내 서재 themselves. (`?mock=1` overrides the provider in memory only: read the saved one.)
   */
  isInvitee() {
    const s = settings.get();
    if (!this.#code() || settings.isSyncReady()) return false;
    const provider = settings.isMockSession ? safeStorage.get(STORAGE_KEYS.settings, {})?.provider : s.provider;
    return provider === 'relay';
  }

  /** Where #/ goes: '#/s/<lib>' for an invitee who has not chosen 내 서재, else null (내 서재). */
  homeHash() {
    if (!this.isInvitee() || this.#state !== 'ready') return null;
    const pref = uiState.get('libraryHome', '');
    if (pref === 'mine') return null;
    const ids = [...this.#entries.keys()];
    const id = typeof pref === 'string' && pref.startsWith('shared:') && ids.includes(pref.slice(7)) ? pref.slice(7) : ids[0];
    return id ? `#/s/${encodeURIComponent(id)}` : null;
  }

  /** Resolves when the latest (re)start has its list: the remembered one at once, else the first GET /shared answer. */
  settled() {
    return this.#starting;
  }

  /** (Re)open for the saved code and server: from the remembered list at once, then GET /shared. */
  start() {
    const run = ++this.#run;
    this.#starting = this.#start(run);
    return this.#starting;
  }

  /** 다시 시도 after an error. */
  retry() { return this.start(); }

  async #start(run) {
    await this.#closeAll();
    const code = this.#code();
    const url = settings.relayUrl();
    if (!code || !url) {
      this.#info = null;
      this.#set('off');
      return;
    }
    const fp = await fingerprint(`${url}\n${code}`);
    if (run !== this.#run) return;
    const cached = readSharedCache(fp);
    if (cached) {
      this.#apply(cached, run);
      this.#set('ready');
    } else {
      this.#info = null;
      this.#set('loading');
    }
    const fresh = this.#refresh(run, fp, Boolean(cached));
    if (!cached) await fresh;
  }

  async #refresh(run, fp, hadCache) {
    if (!this.#relay?.fetchShared) {
      if (!hadCache) this.#set('error', '초대 코드 모듈을 불러오지 못해 공용 서재에 연결할 수 없습니다. 페이지를 새로 고쳐 보세요.');
      return;
    }
    let info;
    try {
      info = await this.#relay.fetchShared({ code: this.#code() });
    } catch (err) {
      if (run !== this.#run) return;
      console.warn('[app] GET /shared', err?.code || '', err?.message || err);
      // A server without team libraries (no /shared route): nothing to show. Otherwise keep what this device has.
      if (err?.code === 'not_found' && !hadCache) this.#set('unavailable');
      else if (!hadCache) this.#set('error', err?.message || '공용 서재에 연결하지 못했습니다.');
      return;
    }
    if (run !== this.#run) return;
    if (!info.libraries.length || !info.personId) {
      safeStorage.remove(SHARED_CACHE_KEY);
      await this.#closeAll();
      if (run !== this.#run) return;
      this.#info = null;
      this.#set('unavailable');
      return;
    }
    safeStorage.set(SHARED_CACHE_KEY, { fp, libraries: info.libraries, personId: info.personId, name: info.name, at: Date.now() });
    this.#apply(info, run);
    this.#set('ready');
  }

  /** Open libraries that are new, drop those that are gone, take over names. */
  #apply(info, run) {
    if (this.#info?.personId && this.#info.personId !== info.personId) {
      for (const e of this.#entries.values()) e.library?.close?.().catch(() => {});
      this.#entries.clear();
    }
    this.#info = { libraries: info.libraries, personId: info.personId, name: info.name || '' };
    const wanted = new Map(info.libraries.map((l) => [l.id, l]));
    for (const [id, e] of this.#entries) {
      if (wanted.has(id)) continue;
      this.#entries.delete(id);
      e.library?.close?.().catch(() => {});
    }
    for (const lib of info.libraries) {
      const e = this.#entries.get(lib.id);
      if (e) e.name = lib.name;
      else this.#openEntry(lib, run);
    }
    this.#emit();
  }

  #openEntry(lib, run) {
    const entry = { id: lib.id, name: lib.name, library: null, status: 'opening', error: '', promise: null };
    this.#entries.set(lib.id, entry);
    entry.promise = (async () => {
      try {
        const library = await this.#openLibrary(lib);
        if (run !== this.#run || this.#entries.get(lib.id) !== entry) {
          library?.close?.().catch(() => {});
          return null;
        }
        library.addEventListener('error', (e) => {
          toast(`${entry.name}: ${e.detail?.message || '변경 내용을 이 기기에 저장하지 못했습니다.'}`, { kind: 'error', timeout: 8000 });
        });
        entry.library = library;
        entry.status = 'ready';
        return library;
      } catch (err) {
        console.warn('[app] open shared library', lib.id, err);
        entry.status = 'error';
        entry.error = /[가-힣]/.test(err?.message || '') ? err.message : '이 기기에 공용 서재를 열지 못했습니다(브라우저 저장소 오류).';
        return null;
      } finally {
        if (this.#entries.get(lib.id) === entry) this.#emit();
      }
    })();
  }

  /**
   * docs/SHARED.md §3.1: a Library with its own database (one per library and person), synced through the relay's
   * proxy. The store's openSharedLibrary() builds exactly that; Library.open() with the contract's options is the
   * fallback for a store without it.
   */
  #openLibrary(lib) {
    const personId = this.#info.personId;
    const personName = () => this.personName; // tombstones' deletedBy (휴지통: who deleted it)
    if (typeof this.#store.openSharedLibrary === 'function') {
      return this.#store.openSharedLibrary({
        relayUrl: settings.relayUrl(), code: this.#code(), lib: lib.id, personId, name: personName, label: lib.name,
      });
    }
    return this.#store.Library.open({
      settings,
      id: `shared:${lib.id}`,
      label: lib.name,
      dbName: `${SHARED_DB_PREFIX}${lib.id}-${personId}`,
      getConfig: () => this.#syncConfig(lib.id),
      personalPrefix: `people/${personId}/`,
      retainPdfOnDelete: true,
      shared: true,
      personName,
    });
  }

  /**
   * GitHub settings of a team library: the relay's GitHub-compatible proxy, the invite code as the token. The
   * repository behind it stays the same when the server address changes, so its data always carries over.
   */
  #syncConfig(libId) {
    const code = this.#code();
    const url = settings.relayUrl();
    if (!code || !url) return null;
    const apiBase = this.#relay?.sharedApiBase?.(libId, url) || `${url}/shared/${encodeURIComponent(libId)}/gh`;
    return { owner: 'team', repo: 'library', branch: 'main', token: code, apiBase, carryOver: `${apiBase}/team/library#main` };
  }

  #code() {
    const raw = String(settings.get().relay?.code || '').trim();
    if (!raw) return '';
    return this.#relay?.normalizeInviteCode ? this.#relay.normalizeInviteCode(raw) : raw.toUpperCase();
  }

  async #closeAll() {
    const libs = [...this.#entries.values()].map((e) => e.library).filter(Boolean);
    this.#entries.clear();
    await Promise.all(libs.map((lib) => Promise.resolve(lib.close?.()).catch((err) => console.warn('[app] close shared library', err))));
  }

  /**
   * 설정 → 이 기기의 데이터 모두 지우기: every team library database on this device (also other people's who used
   * this browser), and the remembered list. Nothing is deleted on the server.
   */
  async wipeLocalData() {
    this.#run++;
    const libs = [...this.#entries.values()].map((e) => e.library).filter(Boolean);
    this.#entries.clear();
    for (const lib of libs) {
      try {
        if (lib.wipeLocalData) await lib.wipeLocalData();
        else await lib.close?.();
      } catch (err) { console.warn('[app] wipe shared library', err); }
    }
    safeStorage.remove(SHARED_CACHE_KEY);
    try {
      const dbs = (await indexedDB.databases?.()) || [];
      for (const { name } of dbs) {
        if (!name?.startsWith(SHARED_DB_PREFIX)) continue;
        await new Promise((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        });
      }
    } catch (err) { console.warn('[app] delete shared databases', err); }
    this.#info = null;
    this.#set('off');
  }

  #set(state, message = '') {
    this.#state = state;
    this.#message = message;
    this.#emit();
  }

  #emit() { this.dispatchEvent(new CustomEvent('change', { detail: { state: this.#state } })); }
}

/** Remembered GET /shared answer, if it belongs to this code and server. */
function readSharedCache(fp) {
  const c = safeStorage.get(SHARED_CACHE_KEY, null);
  if (!c || c.fp !== fp || !Array.isArray(c.libraries) || !c.libraries.length || typeof c.personId !== 'string' || !c.personId) return null;
  const libraries = c.libraries.filter((l) => l && typeof l.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(l.id))
    .map((l) => ({ id: l.id, name: typeof l.name === 'string' && l.name ? l.name : '공용 서재' }));
  return libraries.length ? { libraries, personId: c.personId, name: typeof c.name === 'string' ? c.name : '' } : null;
}

/** A short one-way fingerprint (the code itself is never stored twice). */
async function fingerprint(text) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`pr-shared\n${text}`));
    return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------- router

/**
 * @returns {{ name: 'library'|'paper'|'settings'|'join', id?: string, lib?: string, page?: 'trash'|'activity',
 *             section?: string, code?: string }}
 */
export function parseRoute(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  if (parts[0] === 's' && parts[1]) {
    const lib = decode(parts[1]);
    if (parts[2] === 'paper' && parts[3]) return { name: 'paper', id: decode(parts[3]), lib };
    if (parts[2] === 'trash' || parts[2] === 'activity') return { name: 'library', lib, page: parts[2] };
    return { name: 'library', lib };
  }
  if (parts[0] === 'paper' && parts[1]) return { name: 'paper', id: decode(parts[1]) };
  if (parts[0] === 'trash') return { name: 'library', page: 'trash' };
  if (parts[0] === 'join') return { name: 'join', code: parts[1] ? decode(parts[1]) : '' };
  if (parts[0] === 'settings') return parts[1] ? { name: 'settings', section: parts[1] } : { name: 'settings' };
  return { name: 'library' };
}

function startRouter(viewEl, deps) {
  let current = null;
  let previousHash = '#/';
  /** `replace`: change the address without a history entry (and without leaving the library view). */
  const navigate = (hash, { replace = false } = {}) => {
    if (replace) {
      if (location.hash !== hash) history.replaceState(null, '', hash);
      route();
    } else if (location.hash === hash) route();
    else location.hash = hash;
  };
  const route = () => {
    let r = parseRoute(location.hash);
    // The join link of the code this browser already has (opened again; an iPhone home-screen app starts at it
    // every time): no screen in between — straight to the library, the code out of the address bar.
    if (r.name === 'join' && isSavedCode(deps, r.code)) {
      deps.relay.registerInviteCode(r.code).catch((err) => console.warn('[app] join', err?.message || err)); // same code: no request
      history.replaceState(null, '', '#/');
      r = parseRoute('#/');
    }
    // A fresh visitor sees the first screen (one input for the invite code) instead of the library or a paper.
    const gate = (r.name === 'library' || r.name === 'paper') && needsGate(deps);
    // #/ of an invitee: 공용 서재 (until they choose 내 서재 in the sidebar).
    if (!gate && r.name === 'library' && !r.lib && !r.page) {
      const home = deps.shared?.homeHash?.();
      if (home) {
        history.replaceState(null, '', home);
        r = parseRoute(home);
      } else {
        r = { ...r, home: true };
      }
    }
    closeAllLayers();
    if (gate && current?.kind === 'start' && current.gate) return; // already shown
    // Moving inside the library (내 서재 ↔ 공용 서재, 휴지통, 최근 활동) keeps the view: no flicker, no lost scroll.
    if (!gate && r.name === 'library' && current?.kind === 'library' && current.update) {
      try {
        current.update(r);
        previousHash = location.hash || '#/';
        return;
      } catch (err) {
        console.warn('[app] library update', err);
      }
    }
    try { current?.destroy(); } catch (err) { console.warn('[app] view destroy', err); }
    current = null;
    viewEl.replaceChildren();
    try {
      if (gate) {
        current = mountStartView(viewEl, { deps, navigate, gate: true });
      } else if (r.name === 'paper') {
        current = mountReaderView(viewEl, { paperId: r.id, lib: r.lib || null, deps, navigate });
      } else if (r.name === 'settings') {
        current = mountSettingsView(viewEl, { deps, navigate, backHref: previousHash, section: r.section });
      } else if (r.name === 'join') {
        // In a home-screen app (an iPhone one starts at its join link) the code is registered without the form.
        current = mountStartView(viewEl, { deps, navigate, code: r.code || '', quiet: isStandalone() });
      } else {
        document.title = '갈피';
        current = mountLibraryView(viewEl, { deps, navigate, route: r });
      }
    } catch (err) {
      console.warn('[app] view mount', err);
      showFatal(viewEl, {
        title: '화면을 표시할 수 없습니다',
        message: '이 화면을 그리는 중 오류가 발생했습니다.',
        details: errorText(err),
        actions: [{ label: '라이브러리로', icon: 'arrow-left', onClick: () => navigate('#/') }],
      });
    }
    // The join link holds the code: never come back to it with 뒤로.
    if (r.name !== 'settings') previousHash = r.name === 'join' ? '#/' : location.hash || '#/';
  };
  window.addEventListener('hashchange', () => route());
  // The first screen goes away by itself when a code or a key arrives some other way (another tab, 설정).
  bus.on('settings:change', () => {
    // (Not while it registers a code itself: it waits for 공용 서재, then goes on.)
    if (current?.kind === 'start' && current.gate && !current.busy() && !needsGate(deps)) route();
  });
  route();
}

/**
 * A fresh visitor: no usable AI (no saved API key, no invite code; ?mock=1 counts as AI), nothing in 내 서재 and no
 * GitHub sync. Someone whose library has papers, or who syncs, always gets their library, AI or not.
 */
export function needsGate(deps) {
  const s = settings.get();
  if (settings.isAiReady() || String(s.relay?.code || '').trim()) return false;
  if (['claude', 'openai', 'gemini'].some((id) => String(s[id]?.apiKey || '').trim())) return false;
  if (settings.isSyncReady()) return false;
  try {
    const lib = deps.library;
    if (lib?.papers?.length || lib?.folders?.length) return false;
  } catch { return false; }
  return true;
}

/** The join link's code is the one this browser already has. */
function isSavedCode(deps, raw) {
  const relay = deps.relay;
  const saved = String(settings.get().relay?.code || '').trim();
  if (!relay?.normalizeInviteCode || !relay.registerInviteCode || !saved || !raw) return false;
  // One code, two spellings ("ICU-2TEAM" / "icu2team"): the relay matches codes by their letters and digits.
  const key = (c) => (relay.inviteCodeKey ? relay.inviteCodeKey(c) : relay.normalizeInviteCode(c));
  try { return Boolean(key(raw)) && key(raw) === key(saved); } catch { return false; }
}

// ------------------------------------------------------------- theme & font

function applyTheme() {
  const pref = settings.get().ui?.theme || 'light';
  const dark = pref === 'dark' || (pref === 'system' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // index.html has one theme-color per prefers-color-scheme; the app's own choice (설정 → 테마) wins over both.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', dark ? THEME_COLOR.dark : THEME_COLOR.light);
}

function applyFontSize() {
  const size = clamp(Number(settings.get().ui?.fontSize) || 15, 11, 28);
  document.documentElement.style.setProperty('--tp-font-size', `${size}px`);
}

// ------------------------------------------------------------------- errors

function showFatal(host, { title, message, details, actions }) {
  if (!host) return;
  document.title = '오류 · 갈피';
  host.replaceChildren(messageScreen({
    title, message, details,
    actions: actions || [{ label: '다시 시도', kind: 'primary', icon: 'refresh', onClick: () => location.reload() }],
  }));
}

function showBanner(host, failures) {
  const names = failures.map((f) => f.label).join(', ');
  const banner = el('div', { class: 'app-banner', role: 'status' },
    icon('alert-triangle', { size: 18 }),
    el('span', { class: 'app-banner-text' }, `일부 기능을 불러오지 못했습니다: ${names}. 나머지 기능은 그대로 사용할 수 있습니다.`),
    button('자세히', {
      size: 'sm', kind: 'ghost', onClick: () => modal({
        title: '불러오지 못한 구성 요소',
        size: 'lg',
        body: el('div', {},
          el('p', {}, '아래 모듈을 불러오지 못해 관련 기능이 꺼져 있습니다. 새로 고침(Ctrl+Shift+R)으로 해결되지 않으면 이 내용을 개발자에게 알려 주세요.'),
          el('pre', { class: 'message-details-pre' }, failureText(failures))),
        actions: [{ label: '새로 고침', icon: 'refresh', onClick: () => location.reload() }, { label: '닫기', kind: 'primary' }],
      }),
    }),
    iconButton('x', '알림 닫기', () => banner.remove(), { size: 'sm' }));
  host.replaceChildren(banner);
}

function failureText(failures) {
  return failures.map((f) => `• ${f.label} — js/${f.path.replace(/^\.\//, '')}\n  ${errorText(f.error, false)}`).join('\n\n');
}

function errorText(err, withStack = true) {
  if (!err) return '';
  const head = `${err.name || 'Error'}: ${err.message || String(err)}`;
  if (!withStack || !err.stack) return head;
  // Chromium stacks start with "Name: message"; others don't.
  return err.message && err.stack.includes(err.message) ? err.stack : `${head}\n${err.stack}`;
}

let lastErrorToastAt = 0;
function installGlobalErrorHandlers() {
  const report = (err) => {
    const now = Date.now();
    if (now - lastErrorToastAt < 4000) return;
    lastErrorToastAt = now;
    const msg = err?.message || '';
    toast(/[가-힣]/.test(msg) ? msg : '예기치 않은 오류가 발생했습니다. 문제가 계속되면 페이지를 새로 고쳐 주세요.', { kind: 'error' });
  };
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason?.name === 'AbortError') return;
    console.warn('[app] unhandled rejection', e.reason);
    report(e.reason);
  });
  window.addEventListener('error', (e) => {
    if (!e.error) return;
    console.warn('[app] uncaught error', e.error);
    report(e.error);
  });
}
