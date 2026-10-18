// App bootstrap: theme, module loading with graceful degradation, Library, hash router.
// Routes: #/ (library) · #/paper/<id> (reader) · #/settings[/<section>] · #/join/<CODE> (invite link)
import { bus } from './core/bus.js';
import { APP_VERSION } from './core/config.js';
import { settings } from './core/settings.js';
import { clamp, el } from './core/util.js';
import { button, closeAllLayers, iconButton, messageScreen, modal, spinner, toast } from './ui/components.js';
import { icon } from './ui/icons.js';
import { mountLibraryView } from './ui/library-view.js';
import { mountReaderView } from './ui/reader-view.js';
import { mountJoinView, mountSettingsView } from './ui/settings-view.js';

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

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

boot().catch((err) => {
  console.warn('[app] boot failed', err);
  showFatal(document.getElementById('view') || document.getElementById('app'), {
    title: '앱을 시작할 수 없습니다',
    message: '예기치 않은 오류로 앱을 시작하지 못했습니다. 페이지를 새로 고쳐 보세요.',
    details: errorText(err),
  });
});

async function boot() {
  applyTheme();
  applyFontSize();
  bus.on('settings:change', () => { applyTheme(); applyFontSize(); });
  darkQuery.addEventListener('change', applyTheme);
  installGlobalErrorHandlers();
  console.info('[app] 논문 리더', APP_VERSION);

  const appEl = document.getElementById('app');
  const bannerHost = el('div', { class: 'app-banner-host' });
  const viewEl = el('div', { class: 'view', id: 'view' });
  appEl.replaceChildren(bannerHost, viewEl);
  viewEl.replaceChildren(el('div', { class: 'boot' }, el('div', { class: 'boot-inner' }, spinner(18), '논문 리더를 준비하는 중…')));

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

  const deps = buildDeps(modules, library, failures);
  if (failures.length) showBanner(bannerHost, failures);
  refreshRelayIdentity(deps);
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

function buildDeps(m, library, failures) {
  return {
    library,
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

// ------------------------------------------------------------------- router

/** @returns {{ name: 'library'|'paper'|'settings'|'join', id?: string, section?: string, code?: string }} */
export function parseRoute(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  if (parts[0] === 'paper' && parts[1]) return { name: 'paper', id: decode(parts[1]) };
  if (parts[0] === 'join') return { name: 'join', code: parts[1] ? decode(parts[1]) : '' };
  if (parts[0] === 'settings') return parts[1] ? { name: 'settings', section: parts[1] } : { name: 'settings' };
  return { name: 'library' };
}

function startRouter(viewEl, deps) {
  let current = null;
  let previousHash = '#/';
  const navigate = (hash) => {
    if (location.hash === hash) route();
    else location.hash = hash;
  };
  const route = () => {
    const r = parseRoute(location.hash);
    closeAllLayers();
    try { current?.destroy(); } catch (err) { console.warn('[app] view destroy', err); }
    current = null;
    viewEl.replaceChildren();
    try {
      if (r.name === 'paper') {
        current = mountReaderView(viewEl, { paperId: r.id, deps, navigate });
      } else if (r.name === 'settings') {
        current = mountSettingsView(viewEl, { deps, navigate, backHref: previousHash, section: r.section });
      } else if (r.name === 'join') {
        current = mountJoinView(viewEl, { code: r.code, deps, navigate });
      } else {
        document.title = '논문 리더';
        current = mountLibraryView(viewEl, { deps, navigate });
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
  window.addEventListener('hashchange', route);
  route();
}

// ------------------------------------------------------------- theme & font

function applyTheme() {
  const pref = settings.get().ui?.theme || 'light';
  const dark = pref === 'dark' || (pref === 'system' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#181b21' : '#ffffff');
}

function applyFontSize() {
  const size = clamp(Number(settings.get().ui?.fontSize) || 15, 11, 28);
  document.documentElement.style.setProperty('--tp-font-size', `${size}px`);
}

// ------------------------------------------------------------------- errors

function showFatal(host, { title, message, details, actions }) {
  if (!host) return;
  document.title = '오류 · 논문 리더';
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
