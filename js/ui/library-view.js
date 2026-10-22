// Library view (#/ 내 서재 · #/s/<lib> 공용 서재): each library's folder tree, counts and sync chip in the sidebar,
// paper list with search/sort, PDF upload, drag-drop, 휴지통 and (공용 서재) 최근 활동 — docs/SHARED.md §3.2.
// Without an invite code the sidebar shows 내 서재 alone, exactly as before. With one, the sections are 내 서재 (when
// used, or for the owner), '<code name> 서재' (#/s/mine: only the holders of this invite code see it; an invitee's
// default) and 전체 공용 서재 (#/s/team: every code). Papers and folders copy between any two of them.
//
// Several papers at once: every row has a checkbox (Shift+click = range, Ctrl/Cmd+A = the whole list, Esc = none;
// on touch a long press starts selecting and taps toggle). The count line above the list turns into the action bar
// (폴더로 이동… · 다른 서재로 복사… · 즐겨찾기 · 삭제 · 선택 해제; a bottom bar on phones), and dragging a selected row
// carries the whole selection. Moves are one batch (one library.json write → one sync commit) with 되돌리기.
// Folders: '⋯' on every sidebar folder (long press on touch), a folder picker with the full tree, search and
// inline '새 폴더', '새 하위 폴더' in the header of an open folder.
import { LIMITS } from '../core/config.js';
import { settings } from '../core/settings.js';
import { debounce, el, formatBytes, formatDate } from '../core/util.js';
import {
  brandImage, button, confirmDialog, contextMenu, hasOpenLayer, iconButton, modal, progressBar, promptDialog, spinner, toast, uiState,
} from './components.js';
import { icon } from './icons.js';
import { installButton } from './install.js';

const PAPER_MIME = 'application/x-pr-paper';
const FOLDER_MIME = 'application/x-pr-folder';
const SORTS = [
  { id: 'added', label: '추가일' },
  { id: 'title', label: '제목' },
  { id: 'opened', label: '최근 읽음' },
];
const SMART = {
  all: { label: '전체', icon: 'library' },
  recent: { label: '최근 읽음', icon: 'clock' },
  starred: { label: '즐겨찾기', icon: 'star' },
};
const PAGES = {
  activity: { label: '최근 활동', icon: 'list' },
  trash: { label: '휴지통', icon: 'trash' },
};
const MINE = 'mine';
const MINE_LABEL = '내 서재';
const SHARED_LABEL = '공용 서재';
/** uiState: the library an invitee's #/ opens ('mine' or 'shared:<id>'; js/app.js SharedLibraries.homeHash). */
const HOME_KEY = 'homeLibrary';
/** uiState: the library last picked in '다른 서재로 복사…' (the dialog starts there). */
const COPY_TARGET_KEY = 'copyTarget';
/** Sidebar order of the libraries behind the relay: the code's own, then 전체 공용 서재. */
const KIND_RANK = { code: 0, team: 1 };
/** Deleted items stay restorable this long; the owner's 30일 지난 항목 비우기 removes older ones' files. */
const TRASH_DAYS = 30;
const DAY_MS = 86_400_000;
/** 최근 활동 is re-read when shown again after this long (and on 새로 고침). */
const ACTIVITY_STALE_MS = 60_000;
/**
 * Commit summaries of the shared library (js/store/library.js #describeCommit) that are not an action on the shared
 * library: a person's own notes/AI data syncing, or only the progress counts in library.json. 최근 활동 shows who
 * added, moved or deleted what, so these stay in the repo's history but are not listed (others need not see when
 * someone took notes).
 */
const QUIET_ACTIVITY = new Set(['내 메모·AI 결과 동기화', '논문 정보 갱신']);
const MAX_REMEMBERED_OPENS = 300;
/** A touch held this long selects a paper row / opens a folder's menu; moving more than LONG_PRESS_SLOP px cancels. */
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 10;
/** The folder picker gets a search box above this many folders, and starts with every folder expanded up to it. */
const PICKER_SEARCH_AFTER = 15;
/** Tree indentation (sidebar and folder picker) stops growing after this many levels. */
const MAX_INDENT = 6;
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
/** Touch-first device (no hover, coarse pointer): checkboxes always shown, rows not draggable. */
const COARSE = '(hover: none), (pointer: coarse)';

/**
 * @param {HTMLElement} container
 * @param {{ deps: object, navigate: (hash: string, opts?: { replace?: boolean }) => void,
 *           route?: { lib?: string, page?: 'trash'|'activity', home?: boolean } }} opts
 * @returns {{ kind: 'library', update: (route: object) => void, destroy: () => void }}
 */
export function mountLibraryView(container, { deps, navigate, route = {} }) {
  const view = new LibraryView(container, deps, navigate, route);
  return { kind: 'library', update: (r) => view.show(r), destroy: () => view.destroy() };
}

/** Icon of 공용 서재 (two people), drawn like ui/icons.js. */
export function sharedIcon(size = 18, className = '') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  const attrs = {
    xmlns: NS, width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', focusable: 'false', 'aria-hidden': 'true',
    class: `icon icon-users${className ? ` ${className}` : ''}`,
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
  const shapes = [
    ['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }], ['circle', { cx: 9, cy: 7, r: 4 }],
    ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87' }], ['path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' }],
  ];
  for (const [tag, a] of shapes) {
    const s = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(a)) s.setAttribute(k, String(v));
    svg.append(s);
  }
  return svg;
}

/**
 * Icon of a library by kind: 'mine' (내 서재) books, 'code' (an invite code's own library, seen only by its holders) a
 * lock, 'team' (전체 공용 서재, every code) two people.
 */
export function libraryIcon(kind, size = 18, className = '') {
  if (kind === 'mine') return icon('library', { size, className });
  if (kind === 'code') return icon('lock', { size, className });
  return sharedIcon(size, className);
}

/**
 * 공용 서재 keeps 최근 읽음 and 즐겨찾기 per person (in this browser), not in the shared paper records — a colleague
 * opening or starring a paper must not change anyone else's lists. The reader calls this when a paper opens.
 */
export function rememberSharedOpen(libId, paperId, at = Date.now()) {
  if (!libId || !paperId) return;
  updatePersonal(libId, (p) => {
    delete p.opened[paperId];
    p.opened[paperId] = at;
    const keys = Object.keys(p.opened);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_OPENS))) delete p.opened[k];
  });
}

function readPersonal(libId) {
  const v = (uiState.get('sharedLocal', {}) || {})[libId] || {};
  return {
    starred: Array.isArray(v.starred) ? v.starred.filter((x) => typeof x === 'string') : [],
    opened: v.opened && typeof v.opened === 'object' ? { ...v.opened } : {},
  };
}

function updatePersonal(libId, fn) {
  const all = { ...(uiState.get('sharedLocal', {}) || {}) };
  const p = readPersonal(libId);
  fn(p);
  all[libId] = p;
  uiState.set('sharedLocal', all);
}

class LibraryView {
  #deps;
  #shared;
  #navigate;
  #root;
  #els = {};
  #query = '';
  #key = MINE; // the library shown: 'mine' | 'shared:<id>'
  #page = 'list'; // 'list' | 'trash' | 'activity'
  #autoHome = false; // opened as #/ and untouched: an invitee's 공용 서재 may still become the home
  #states = new Map(); // library key → { collection, sort, expanded: Set }
  #collapsed;
  #bound = new Map(); // Library → unbind()
  #cleanup = [];
  #renderQueued = false;
  #drag = null; // { kind: 'paper'|'folder', key, id } while something from this view is dragged
  #dragDepth = 0;
  #uploading = false;
  #uploadToast = null;
  #mainToken = 0; // bumped by every main render; async parts check it
  #activity = new Map(); // library key → { items, error, at, loading }
  // Selection (papers of the list shown; cleared when the library, page or collection changes)
  #sel = new Set();
  #anchor = null; // the row a Shift+click range starts from
  #visibleIds = []; // the list as shown (folder, search, sort): ranges and 전체 선택 follow it
  #pointerType = 'mouse'; // of the last pointerdown anywhere: a tap on touch toggles while selecting
  #autoExpanded = ''; // `${key}|${collection}` whose ancestors were last expanded for the open folder

  constructor(container, deps, navigate, route) {
    this.#deps = deps;
    this.#shared = deps.shared || null;
    this.#navigate = navigate;
    this.#collapsed = { ...(uiState.get('librarySections', {}) || {}) };
    this.#root = this.#build();
    container.replaceChildren(this.#root);
    this.#listen(document, 'keydown', (e) => this.#onKeyDown(e));
    this.#listen(document, 'pointerdown', (e) => { this.#pointerType = e.pointerType || 'mouse'; }, true);
    if (this.#shared) this.#listen(this.#shared, 'change', () => this.#onSharedChange());
    this.show(route);
  }

  destroy() {
    for (const off of this.#cleanup) off();
    this.#cleanup = [];
    for (const off of this.#bound.values()) off();
    this.#bound.clear();
    // "…을(를) 추가했습니다 [열기]" is stale once the library is left (and would cover the reader's panes).
    this.#uploadToast?.close?.();
    this.#root.remove();
  }

  /** Route inside the library: #/, #/trash, #/s/<lib>, #/s/<lib>/trash, #/s/<lib>/activity. */
  show(route = {}) {
    const key = route.lib ? `shared:${route.lib}` : MINE;
    const page = route.page === 'trash' || (route.page === 'activity' && key !== MINE) ? route.page : 'list';
    if (key !== this.#key && this.#query) {
      this.#query = '';
      this.#els.search.value = '';
    }
    const moved = key !== this.#key || page !== this.#page;
    if (moved) this.#clearSelection({ paint: false });
    this.#key = key;
    this.#page = page;
    this.#autoHome = Boolean(route.home) && key === MINE;
    if (route.lib) uiState.set(HOME_KEY, key);
    // The library shown is never folded away in the sidebar.
    const src = this.#source(key);
    if (src && this.#isCollapsed(src)) this.#toggleSection(src, false, { render: false });
    this.#renderAll();
    if (moved) this.#els.content.scrollTop = 0;
  }

  // ---------------------------------------------------------------- build

  #build() {
    const els = this.#els;
    els.nav = el('nav', { class: 'lib-nav', 'aria-label': '폴더' });
    els.nav.addEventListener('contextmenu', (e) => {
      if (/** @type {Element} */ (e.target).closest('.tree-item, .lib-sec-head')) return;
      const src = this.#current();
      if (!src?.lib) return;
      e.preventDefault();
      contextMenu([{ label: '새 폴더', icon: 'folder-plus', onClick: () => this.#createFolder(src, null) }], e.clientX, e.clientY);
    });

    // 홈 화면에 추가 (ui/install.js): in the sidebar footer; on phones, where the sidebar is a drawer, in the header.
    const installSide = installButton({ className: 'lib-install-side' });
    const installHead = installButton({ className: 'lib-install-head' });
    this.#cleanup.push(() => { installSide.destroy(); installHead.destroy(); });

    const sidebar = el('aside', { class: 'lib-sidebar', 'aria-label': '라이브러리 탐색' },
      el('div', { class: 'lib-brand', title: '갈피 — 논문을 나란히 읽다' },
        brandImage('mark', { size: 34, className: 'lib-brand-mark' }),
        el('div', { class: 'lib-brand-text' },
          el('div', { class: 'lib-brand-name' }, '갈피'),
          el('div', { class: 'lib-brand-sub', lang: 'en', 'aria-hidden': 'true' }, 'GALPI'))),
      els.nav,
      el('div', { class: 'lib-sidebar-footer' },
        installSide.el,
        button('설정', { icon: 'settings', kind: 'ghost', className: 'lib-settings-btn', onClick: () => this.#navigate('#/settings') })));

    els.crumbs = el('div', { class: 'lib-crumbs' });
    els.title = el('h1', { class: 'lib-title' });
    els.search = el('input', {
      class: 'input lib-search', type: 'search', placeholder: '제목·저자·연도 검색', 'aria-label': '논문 검색',
      autocomplete: 'off', spellcheck: 'false',
    });
    const onSearch = debounce(() => { this.#query = els.search.value.trim(); this.#renderMain(); }, 120);
    els.search.addEventListener('input', onSearch);
    els.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && els.search.value) { e.preventDefault(); els.search.value = ''; onSearch.flush(); }
    });
    els.sort = el('select', { class: 'select lib-sort', 'aria-label': '정렬 기준' },
      SORTS.map((s) => el('option', { value: s.id }, `정렬: ${s.label}`)));
    els.sort.addEventListener('change', () => {
      this.#stateOf(this.#key).sort = els.sort.value;
      this.#persist(this.#key);
      this.#renderMain();
    });
    els.syncChip = el('button', { type: 'button', class: 'chip lib-sync', onclick: () => this.#onSyncClick(this.#current()) });
    els.fileInput = el('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: true, hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
    els.fileInput.addEventListener('change', () => {
      const files = [...els.fileInput.files];
      els.fileInput.value = '';
      const src = this.#current();
      if (src?.lib) this.#upload(files, src, this.#currentFolderId());
    });
    els.uploadBtn = button('PDF 추가', { icon: 'upload', kind: 'primary', onClick: () => els.fileInput.click(), title: 'PDF 파일 추가 (여러 개 선택 가능)' });
    // An open folder: '새 하위 폴더' next to PDF 추가 (icon only on phones; the name stays in aria-label/title).
    els.subfolderBtn = button('새 하위 폴더', {
      icon: 'folder-plus', className: 'lib-subfolder-btn', title: '이 폴더 안에 새 폴더 만들기',
      onClick: () => {
        const src = this.#current();
        const id = this.#currentFolderId();
        if (src?.lib && id) this.#createFolder(src, id);
      },
    });
    els.subfolderBtn.setAttribute('aria-label', '새 하위 폴더');
    els.subfolderBtn.hidden = true;
    els.searchWrap = el('label', { class: 'input-with-icon' }, icon('search', { size: 16 }), els.search);

    const header = el('header', { class: 'lib-header' },
      iconButton('menu', '폴더 목록 열기', () => this.#toggleDrawer(true), { className: 'lib-menu-btn' }),
      el('div', { class: 'lib-title-wrap' }, els.crumbs, els.title),
      installHead.el,
      el('div', { class: 'lib-actions' }, els.searchWrap, els.sort, els.syncChip, els.subfolderBtn, els.uploadBtn, els.fileInput));

    els.content = el('div', { class: 'lib-content' });
    els.content.addEventListener('keydown', (e) => this.#onListKey(e));
    els.dropText = el('span', {}, 'PDF를 놓으면 이 목록에 추가됩니다');
    els.dropOverlay = el('div', { class: 'drop-overlay', hidden: true }, el('div', {}, icon('upload', { size: 30 }), els.dropText));
    const main = el('main', { class: 'lib-main' }, header, els.content, els.dropOverlay);
    this.#bindFileDrop(main);

    return el('div', { class: 'library' }, sidebar, el('div', { class: 'sidebar-scrim', onclick: () => this.#toggleDrawer(false) }), main);
  }

  #listen(target, type, fn, capture = false) {
    target.addEventListener(type, fn, capture);
    this.#cleanup.push(() => target.removeEventListener(type, fn, capture));
  }

  /** Follow every library the sidebar shows (내 서재 and each opened 공용 서재). */
  #bindLibraries() {
    const libs = new Set(this.#sources().map((s) => s.lib).filter(Boolean));
    for (const [lib, off] of this.#bound) {
      if (!libs.has(lib)) { off(); this.#bound.delete(lib); }
    }
    for (const lib of libs) {
      if (this.#bound.has(lib)) continue;
      const onChange = () => this.#scheduleRender();
      const onStatus = () => this.#renderSync();
      lib.addEventListener('change', onChange);
      lib.addEventListener('syncstatus', onStatus);
      this.#bound.set(lib, () => {
        lib.removeEventListener('change', onChange);
        lib.removeEventListener('syncstatus', onStatus);
      });
    }
  }

  #onSharedChange() {
    // Opened as #/ by an invitee before the team library list arrived: 공용 서재 is their home.
    if (this.#autoHome && this.#key === MINE) {
      const home = this.#shared.homeHash?.();
      if (home) {
        this.#autoHome = false;
        this.#navigate(home, { replace: true });
        return;
      }
    }
    this.#scheduleRender();
  }

  #scheduleRender() {
    if (this.#renderQueued) return;
    this.#renderQueued = true;
    requestAnimationFrame(() => { this.#renderQueued = false; this.#renderAll(); });
  }

  #renderAll() {
    this.#bindLibraries();
    const src = this.#current();
    if (src?.lib) {
      const st = this.#stateOf(src.key);
      if (!this.#collectionExists(src, st.collection)) st.collection = 'all';
      this.#expandToOpenFolder(src);
    }
    this.#renderNav();
    this.#renderMain();
    this.#renderSync();
  }

  // ------------------------------------------------------------ libraries

  /**
   * The libraries in the sidebar: 내 서재 (unless hidden, see #mineShown), then the code's own library and 전체 공용
   * 서재 (or one placeholder while the list is loading or could not be read).
   * Each: { key: 'mine'|'shared:<id>', id, kind: 'mine'|'code'|'team', shared, label, lib, status, error, placeholder? }
   */
  #sources() {
    const mine = { key: MINE, id: null, kind: 'mine', shared: false, label: MINE_LABEL, lib: this.#deps.library, status: 'ready', error: '' };
    const sh = this.#shared;
    if (!sh?.enabled) return [mine];
    const out = this.#mineShown() ? [mine] : [];
    const list = sh.state === 'ready' ? sh.libraries : [];
    if (list.length) {
      const sorted = [...list].sort((a, b) => (KIND_RANK[a.kind] ?? 2) - (KIND_RANK[b.kind] ?? 2));
      for (const e of sorted) {
        out.push({
          key: `shared:${e.id}`, id: e.id, kind: e.kind || 'team', shared: true, label: e.name || SHARED_LABEL,
          lib: e.library, status: e.status, error: e.error,
        });
      }
    } else {
      out.push({
        key: 'shared:', id: null, kind: 'team', shared: true, label: SHARED_LABEL, lib: null, placeholder: true,
        status: sh.state === 'error' ? 'error' : 'loading', error: sh.message,
      });
    }
    return out;
  }

  /**
   * 내 서재 in the sidebar: always without an invite code; for an invitee (code, no GitHub sync, AI through the code)
   * only when it is in use (papers or folders), when they opened it on purpose (#/trash, a 내 서재 paper's link), or
   * for the owner (admin token saved) — the code's own library is their place.
   */
  #mineShown() {
    const sh = this.#shared;
    if (!sh?.enabled || !sh.isInvitee?.()) return true;
    if (this.#key === MINE && !this.#autoHome) return true;
    if (String(settings.get().relay?.adminToken || '').trim()) return true;
    const lib = this.#deps.library;
    return Boolean(lib?.papers?.length || lib?.folders?.length);
  }

  #source(key) { return this.#sources().find((s) => s.key === key) || null; }
  #current() { return this.#source(this.#key); }
  #multi() { return this.#sources().length > 1; }
  /** Name the library in headers and prompts: several in the sidebar, or one behind the relay (not '라이브러리'). */
  #named(src) { return Boolean(src?.shared) || this.#multi(); }

  #stateOf(key) {
    let st = this.#states.get(key);
    if (!st) {
      const saved = (key === MINE ? uiState.get('library', {}) : (uiState.get('sharedLibraryUi', {}) || {})[key.slice(7)]) || {};
      st = { collection: saved.collection || 'all', sort: saved.sort || 'added', expanded: new Set(saved.expanded || []) };
      this.#states.set(key, st);
    }
    return st;
  }

  #persist(key) {
    const st = this.#stateOf(key);
    const value = { collection: st.collection, sort: st.sort, expanded: [...st.expanded] };
    if (key === MINE) {
      uiState.set('library', value);
    } else {
      const all = { ...(uiState.get('sharedLibraryUi', {}) || {}) };
      all[key.slice(7)] = value;
      uiState.set('sharedLibraryUi', all);
    }
  }

  /** Papers as this person sees them: in 공용 서재, 즐겨찾기 and 최근 읽음 are their own (this browser). */
  #papersOf(src) {
    const papers = src.lib.papers;
    if (!src.shared) return papers;
    const mine = readPersonal(src.id);
    const starred = new Set(mine.starred);
    return papers.map((p) => ({ ...p, starred: starred.has(p.id), lastOpenedAt: mine.opened[p.id] || null }));
  }

  // --------------------------------------------------------------- sidebar

  #renderNav() {
    const sources = this.#sources();
    if (sources.length === 1 && sources[0].key === MINE) {
      this.#els.nav.replaceChildren(...this.#libraryNav(sources[0]));
      return;
    }
    this.#els.nav.replaceChildren(...sources.map((s) => this.#sectionNav(s)));
  }

  /** One library's section: header (name + sync chip, folds), then its lists. */
  #sectionNav(src) {
    const current = src.placeholder ? !this.#current() || this.#key.startsWith('shared:') : this.#key === src.key;
    const collapsed = this.#isCollapsed(src);
    const toggle = el('button', {
      type: 'button', class: 'lib-sec-toggle', 'aria-expanded': String(!collapsed),
      title: collapsed ? `${src.label} 펼치기` : `${src.label} 접기`,
      onclick: () => this.#toggleSection(src, !collapsed),
    },
    icon('chevron-right', { size: 14, className: 'lib-sec-chevron' }),
    libraryIcon(src.kind, 16),
    el('span', { class: 'lib-sec-label', title: src.label }, src.label));
    const head = el('div', { class: 'lib-sec-head' }, toggle, src.lib ? this.#miniSync(src) : null);
    if (src.lib) this.#makeDropTarget(head, src, null, { acceptPapers: false, acceptFolders: false });
    const body = collapsed ? null : el('div', { class: 'lib-sec-body' }, this.#sectionBody(src));
    return el('section', {
      class: `lib-sec is-${src.kind}${current ? ' is-current' : ''}${src.shared ? ' is-shared' : ''}`,
      'data-lib': src.key, 'aria-label': src.label,
    }, head, body);
  }

  #sectionBody(src) {
    if (src.lib) return this.#libraryNav(src);
    if (src.status === 'error') {
      return el('div', { class: 'lib-sec-state is-error', role: 'status' },
        icon('alert-circle', { size: 15 }),
        el('div', {}, el('p', {}, src.error || '공용 서재에 연결하지 못했습니다.'),
          button('다시 시도', { size: 'sm', icon: 'refresh', onClick: () => this.#shared.retry() })));
    }
    return el('div', { class: 'lib-sec-state', role: 'status' }, spinner(14),
      el('span', {}, src.status === 'opening' ? '이 기기에 서재를 여는 중…' : '공용 서재에 연결하는 중…'));
  }

  #isCollapsed(src) {
    if (src.key in this.#collapsed) return Boolean(this.#collapsed[src.key]);
    // An invitee's 내 서재 starts folded while it is empty: 공용 서재 is what they came for.
    return src.key === MINE && Boolean(this.#shared?.isInvitee?.()) && !src.lib.papers.length && !src.lib.folders.length;
  }

  #toggleSection(src, collapse, { render = true } = {}) {
    this.#collapsed[src.key] = collapse;
    uiState.set('librarySections', this.#collapsed);
    if (render) this.#renderNav();
  }

  /** 전체 / 최근 읽음 / 즐겨찾기, the folder tree, then 최근 활동 (공용 서재) and 휴지통. */
  #libraryNav(src) {
    const lib = src.lib;
    const papers = this.#papersOf(src);
    const folders = lib.folders;
    const counts = folderCounts(papers, folders);

    const smart = el('ul', { class: 'tree', role: 'list' },
      this.#smartItem(src, 'all', papers.length),
      this.#smartItem(src, 'recent', papers.filter((p) => p.lastOpenedAt).length),
      this.#smartItem(src, 'starred', papers.filter((p) => p.starred).length));

    const heading = el('div', { class: 'lib-nav-heading' },
      el('span', {}, '폴더'),
      iconButton('folder-plus', this.#named(src) ? `${src.label}에 새 폴더` : '새 폴더', () => this.#createFolder(src, null), { size: 'sm' }));
    this.#makeDropTarget(heading, src, null, { acceptPapers: false });

    const tree = this.#folderTree(src, folders, null, 0, counts);
    const section = el('div', { class: 'lib-nav-section' }, heading,
      tree.childElementCount ? tree : el('p', { class: 'field-hint', style: { padding: '2px 10px' } }, '폴더가 없습니다. 위의 새 폴더 버튼을 눌러 만들어 보세요.'));
    const extras = el('ul', { class: 'tree lib-nav-extra', role: 'list' },
      src.shared ? this.#pageItem(src, 'activity') : null,
      typeof lib.trash === 'function' ? this.#pageItem(src, 'trash') : null);
    return extras.childElementCount ? [smart, section, extras] : [smart, section];
  }

  #smartItem(src, id, count) {
    const meta = SMART[id];
    const current = this.#key === src.key && this.#page === 'list' && this.#stateOf(src.key).collection === id;
    const btn = el('button', {
      type: 'button', class: 'tree-item', 'aria-current': String(current),
      onclick: () => this.#select(src.key, id),
    }, icon(meta.icon, { size: 17 }), el('span', { class: 'tree-label' }, meta.label), el('span', { class: 'tree-count' }, String(count)));
    if (id === 'all') {
      btn.title = '논문을 여기로 끌어다 놓으면 폴더에서 빠집니다';
      this.#makeDropTarget(btn, src, null, { acceptFolders: false });
    }
    return el('li', {}, btn);
  }

  #pageItem(src, page) {
    const meta = PAGES[page];
    const btn = el('button', {
      type: 'button', class: `tree-item is-${page}`, 'aria-current': String(this.#key === src.key && this.#page === page),
      onclick: () => this.#go(src.key, page),
    }, icon(meta.icon, { size: 17 }), el('span', { class: 'tree-label' }, meta.label));
    return el('li', {}, btn);
  }

  #folderTree(src, folders, parentId, depth, counts) {
    const list = el('ul', { class: 'tree', role: 'list' });
    const st = this.#stateOf(src.key);
    const children = folders.filter((f) => (f.parentId ?? null) === parentId).sort((a, b) => collator.compare(a.name, b.name));
    const indent = String(Math.min(depth, MAX_INDENT));
    const draggable = String(!isCoarse());
    for (const folder of children) {
      const hasChildren = folders.some((f) => f.parentId === folder.id);
      const expanded = hasChildren && st.expanded.has(folder.id);
      const current = this.#key === src.key && this.#page === 'list' && st.collection === `folder:${folder.id}`;
      const item = el('button', {
        type: 'button', class: 'tree-item is-folder', draggable, 'data-folder': folder.id,
        'aria-current': String(current),
        onclick: () => this.#select(src.key, `folder:${folder.id}`),
      },
      icon(expanded ? 'folder-open' : 'folder', { size: 17 }),
      el('span', { class: 'tree-label', title: folder.name }, folder.name),
      el('span', { class: 'tree-count', title: '하위 폴더 포함 논문 수' }, String(counts.get(folder.id) || 0)));
      item.style.setProperty('--depth', indent);
      // Touch: a long press opens the menu (before the contextmenu listener below, which it then stops).
      this.#onLongPress(item, () => {
        const r = item.getBoundingClientRect();
        this.#folderMenu(src, folder, r.left + 24, r.bottom - 4);
      });
      item.addEventListener('contextmenu', (e) => { e.preventDefault(); this.#folderMenu(src, folder, e.clientX, e.clientY); });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const r = item.getBoundingClientRect();
          this.#folderMenu(src, folder, r.left + 24, r.bottom);
        }
      });
      item.addEventListener('dragstart', (e) => {
        this.#drag = { kind: 'folder', key: src.key, id: folder.id };
        e.dataTransfer.setData(FOLDER_MIME, folder.id);
        e.dataTransfer.effectAllowed = 'copyMove';
        item.classList.add('is-dragging');
      });
      item.addEventListener('dragend', () => { this.#drag = null; item.classList.remove('is-dragging'); });
      this.#makeDropTarget(item, src, folder.id);

      const more = el('button', {
        type: 'button', class: 'tree-more', 'aria-label': '폴더 메뉴', title: `‘${folder.name}’ 폴더 메뉴`, 'aria-haspopup': 'menu',
        onclick: (e) => {
          e.stopPropagation();
          const r = more.getBoundingClientRect();
          this.#folderMenu(src, folder, r.left, r.bottom + 4);
        },
      }, icon('more-horizontal', { size: 16 }));
      const row = el('div', { class: 'tree-row' }, item, more);
      row.style.setProperty('--depth', indent);
      if (hasChildren) {
        row.prepend(el('button', {
          type: 'button', class: 'tree-toggle', 'aria-expanded': String(expanded),
          'aria-label': expanded ? `${folder.name} 접기` : `${folder.name} 펼치기`,
          onclick: (e) => { e.stopPropagation(); this.#toggleExpanded(src, folder.id); },
        }, icon('chevron-right', { size: 14 })));
      }
      const li = el('li', {}, row);
      if (expanded) li.append(this.#folderTree(src, folders, folder.id, depth + 1, counts));
      list.append(li);
    }
    return list;
  }

  /**
   * The open folder is visible in the tree: its ancestors are expanded once when it is opened (a later collapse by
   * hand stays collapsed until another folder is opened).
   */
  #expandToOpenFolder(src) {
    const st = this.#stateOf(src.key);
    if (!st.collection.startsWith('folder:')) return;
    const mark = `${src.key}|${st.collection}`;
    if (this.#autoExpanded === mark) return;
    const chain = this.#chain(src.lib, st.collection.slice(7));
    if (!chain.length) return; // not there yet (first sync): try again on the next render
    this.#autoExpanded = mark;
    let changed = false;
    for (const f of chain.slice(1)) {
      if (!st.expanded.has(f.id)) { st.expanded.add(f.id); changed = true; }
    }
    if (changed) this.#persist(src.key);
  }

  #toggleExpanded(src, id, force) {
    const st = this.#stateOf(src.key);
    const open = force ?? !st.expanded.has(id);
    if (open) st.expanded.add(id); else st.expanded.delete(id);
    this.#persist(src.key);
    this.#renderNav();
  }

  /** Show a collection (전체 / 최근 읽음 / 즐겨찾기 / folder:<id>) of library `key`. */
  #select(key, collection) {
    const src = this.#source(key);
    if (!src?.lib) return;
    const st = this.#stateOf(key);
    const changed = key !== this.#key || st.collection !== collection;
    if (changed) this.#clearSelection({ paint: false });
    st.collection = collection;
    if (collection.startsWith('folder:')) {
      // make sure every ancestor is expanded so the selection is visible
      for (const f of this.#chain(src.lib, collection.slice(7)).slice(1)) st.expanded.add(f.id);
    }
    this.#persist(key);
    this.#toggleDrawer(false);
    this.#autoHome = false;
    if (key !== this.#key || this.#page !== 'list') {
      this.#go(key, 'list');
      return;
    }
    this.#renderNav();
    this.#renderMain();
    if (changed) this.#els.content.scrollTop = 0; // another folder starts at its top
  }

  /** Switch library or page through the router (the address shows where one is). */
  #go(key, page = 'list') {
    this.#autoHome = false;
    this.#toggleDrawer(false);
    if (key === MINE) uiState.set(HOME_KEY, MINE); // an invitee chose 내 서재: #/ stays there from now on
    this.#navigate(hrefFor(key, page));
  }

  #toggleDrawer(open) {
    this.#root.classList.toggle('is-drawer-open', open);
  }

  // ------------------------------------------------------------------ main

  #renderMain() {
    const token = ++this.#mainToken;
    const els = this.#els;
    const src = this.#current();
    const list = this.#page === 'list';
    els.searchWrap.hidden = !list;
    els.sort.hidden = !list;
    els.uploadBtn.hidden = !list;
    els.uploadBtn.disabled = this.#uploading || !src?.lib;
    const folder = list && src?.lib ? src.lib.getFolder(this.#currentFolderId() || '') : null;
    els.subfolderBtn.hidden = !folder;
    els.subfolderBtn.title = folder ? `‘${folder.name}’ 안에 새 폴더 만들기` : '';
    els.dropText.textContent = folder
      ? `PDF를 놓으면 ‘${folder.name}’ 폴더에 추가됩니다`
      : src?.shared ? `PDF를 놓으면 ${src.label}의 이 목록에 추가됩니다` : 'PDF를 놓으면 이 목록에 추가됩니다';
    if (!src?.lib || !list) {
      // Only a paper list has a selection.
      this.#visibleIds = [];
      this.#clearSelection();
    }
    if (!src?.lib) { this.#renderUnavailable(src); return; }
    if (this.#page === 'trash') { this.#renderTrash(src, token); return; }
    if (this.#page === 'activity') { this.#renderActivity(src, token); return; }
    this.#renderList(src);
  }

  #setHeader(src, title, crumbs = null) {
    const els = this.#els;
    els.crumbs.replaceChildren(...(crumbs || [el('span', {}, this.#named(src) || !src ? src?.label || SHARED_LABEL : '라이브러리')]));
    els.title.textContent = title;
    document.title = src?.shared ? `${title} · ${src.label} · 갈피` : '갈피';
  }

  #renderList(src) {
    const els = this.#els;
    const st = this.#stateOf(src.key);
    const { collection } = st;
    const allPapers = this.#papersOf(src);
    const folder = collection.startsWith('folder:') ? src.lib.getFolder(collection.slice(7)) : null;

    // header
    let crumbs = null;
    if (folder) {
      const chain = this.#chain(src.lib, folder.id).slice(1).reverse();
      const crumb = (label, target) => el('button', { type: 'button', onclick: () => this.#select(src.key, target) }, label);
      crumbs = [crumb(this.#named(src) ? src.label : '전체', 'all')];
      for (const f of chain) crumbs.push(icon('chevron-right', { size: 12 }), crumb(f.name, `folder:${f.id}`));
    }
    this.#setHeader(src, folder ? folder.name : SMART[collection]?.label || '전체', crumbs);
    els.sort.value = collection === 'recent' ? 'opened' : st.sort;
    els.sort.disabled = collection === 'recent';

    // content
    const content = els.content;
    content.replaceChildren();
    const papers = this.#visiblePapers(allPapers, st);
    // The selection keeps only papers still in the list (moved away, deleted elsewhere, filtered out).
    this.#visibleIds = papers.map((p) => p.id);
    const visible = new Set(this.#visibleIds);
    for (const id of [...this.#sel]) if (!visible.has(id)) this.#sel.delete(id);
    if (this.#anchor && !visible.has(this.#anchor)) this.#anchor = null;
    if (!allPapers.length && collection === 'all' && !this.#query) {
      content.append(src.shared ? this.#sharedEmpty(src) : this.#onboarding());
      this.#paintSelection();
      return;
    }
    if (folder) {
      const subs = src.lib.folders.filter((f) => f.parentId === folder.id).sort((a, b) => collator.compare(a.name, b.name));
      content.append(el('div', { class: 'lib-subfolders' }, subs.map((f) => this.#subfolderChip(src, f)), this.#addSubfolderChip(src, folder)));
    }
    if (!papers.length) {
      content.append(this.#emptyCollection(collection, folder));
      this.#paintSelection();
      return;
    }
    content.append(this.#listBar(src));
    const folderNames = new Map(src.lib.folders.map((f) => [f.id, f.name]));
    content.append(el('div', { class: 'paper-list', role: 'list' }, papers.map((p) => this.#paperRow(src, p, folderNames, !folder))));
    this.#paintSelection();
  }

  #visiblePapers(all, { collection, sort: chosen }) {
    let list = all;
    if (collection === 'recent') list = all.filter((p) => p.lastOpenedAt);
    else if (collection === 'starred') list = all.filter((p) => p.starred);
    else if (collection.startsWith('folder:')) {
      const id = collection.slice(7);
      list = all.filter((p) => p.folderId === id);
    }
    const q = this.#query.toLowerCase();
    if (q) {
      list = list.filter((p) => [p.title, p.authors, p.fileName, p.year].some((v) => v != null && String(v).toLowerCase().includes(q)));
    }
    const sort = collection === 'recent' ? 'opened' : chosen;
    const sorted = [...list];
    if (sort === 'title') sorted.sort((a, b) => collator.compare(paperTitle(a), paperTitle(b)));
    else if (sort === 'opened') sorted.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0) || (b.addedAt || 0) - (a.addedAt || 0));
    else sorted.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return sorted;
  }

  #paperRow(src, paper, folderNames, showFolder) {
    const href = paperHref(src, paper.id);
    const title = paperTitle(paper);
    const meta = [];
    if (paper.authors) meta.push(el('span', { class: 'paper-authors', title: paper.authors }, paper.authors));
    if (paper.year) meta.push(el('span', {}, String(paper.year)));
    if (paper.pages) meta.push(el('span', {}, `${paper.pages}쪽`));
    if (paper.size) meta.push(el('span', {}, formatBytes(paper.size)));
    if (showFolder && paper.folderId && folderNames.has(paper.folderId)) {
      meta.push(el('span', { class: 'paper-folder' }, icon('folder', { size: 13 }), folderNames.get(paper.folderId)));
    }
    const by = src.shared && typeof paper.addedBy === 'string' && paper.addedBy ? ` · ${paper.addedBy}` : '';
    if (paper.addedAt) meta.push(el('span', {}, `${formatDate(paper.addedAt)} 추가${by}`));
    const metaLine = el('div', { class: 'paper-meta' });
    meta.forEach((m, i) => { if (i) metaLine.append(el('span', { class: 'sep', 'aria-hidden': 'true' }, '·')); metaLine.append(m); });

    const star = iconButton('star', paper.starred ? '즐겨찾기 해제' : '즐겨찾기', () => this.#toggleStar(src, paper), {
      className: 'star-btn', pressed: Boolean(paper.starred),
    });
    const more = iconButton('more-horizontal', '논문 메뉴', () => {
      const r = more.getBoundingClientRect();
      this.#paperMenu(src, paper, r.right - 190, r.bottom + 4);
    });

    // The checkbox sits on the paper icon: shown on hover, while selecting, on touch and when focused.
    const check = el('input', { type: 'checkbox', class: 'pick-check paper-check', 'aria-label': `‘${shorten(title, 60)}’ 선택` });
    check.checked = this.#sel.has(paper.id);
    check.addEventListener('click', (e) => { e.stopPropagation(); this.#pick(paper.id, { range: e.shiftKey }); });
    const pick = el('div', { class: 'paper-pick', title: '선택' },
      el('div', { class: 'paper-thumb', 'aria-hidden': 'true' }, icon('file-text', { size: 20 })), check);
    pick.addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); }); // no text selection on Shift+click
    pick.addEventListener('click', (e) => {
      if (e.target === check) return;
      e.preventDefault();
      this.#pick(paper.id, { range: e.shiftKey });
    });

    const selected = this.#sel.has(paper.id);
    const row = el('article', {
      class: `paper-row${selected ? ' is-selected' : ''}`, draggable: String(!isCoarse()), 'data-id': paper.id, role: 'listitem',
    },
    pick,
    el('div', { class: 'paper-main' },
      el('a', { class: 'paper-link', href, draggable: 'false' }, el('h2', { class: 'paper-title' }, title)),
      metaLine),
    el('div', { class: 'paper-side' }, this.#progressCell(paper), star, more));

    // Touch: a long press selects the row (and stops the contextmenu that Android sends with it).
    this.#onLongPress(row, () => {
      this.#sel.add(paper.id);
      this.#anchor = paper.id;
      this.#paintSelection();
      navigator.vibrate?.(12);
    }, { ignore: '.paper-side' });
    row.addEventListener('click', (e) => {
      const t = /** @type {Element} */ (e.target);
      if (t.closest('.paper-pick, .paper-side')) return;
      if (e.shiftKey) { // Shift+click on the row: a range, not a new window
        e.preventDefault();
        this.#pick(paper.id, { range: true });
      } else if (this.#sel.size && e.detail > 0 && this.#pointerType === 'touch') {
        e.preventDefault(); // selecting on touch: a tap toggles instead of opening the paper
        this.#pick(paper.id);
      }
    }, true);
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.#paperMenu(src, paper, e.clientX, e.clientY); });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const r = row.getBoundingClientRect();
        this.#paperMenu(src, paper, r.left + 60, r.top + 40);
      }
    });
    row.addEventListener('dragstart', (e) => {
      // A selected row carries the whole selection; any other row only itself.
      const ids = this.#sel.has(paper.id) && this.#sel.size > 1 ? this.#selectedIds() : [paper.id];
      this.#drag = { kind: 'paper', key: src.key, id: paper.id, ids };
      e.dataTransfer.setData(PAPER_MIME, ids.join(','));
      e.dataTransfer.setData('text/plain', ids.length > 1 ? `논문 ${ids.length}편` : title);
      e.dataTransfer.effectAllowed = 'copyMove';
      if (ids.length > 1) setDragBadge(e.dataTransfer, `논문 ${ids.length}편`);
      const dragged = new Set(ids);
      for (const r of this.#els.content.querySelectorAll('.paper-row')) if (dragged.has(r.dataset.id)) r.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => {
      this.#drag = null;
      for (const r of this.#els.content.querySelectorAll('.paper-row.is-dragging')) r.classList.remove('is-dragging');
    });
    return row;
  }

  // ------------------------------------------------------------ selection

  /** The count line above the list; with a selection it is the action bar (a bottom bar on phones). */
  #listBar(src) {
    const els = this.#els;
    els.selectAll = el('input', { type: 'checkbox', class: 'pick-check lib-select-all-check', 'aria-label': '전체 선택', title: '전체 선택 (Ctrl+A)' });
    els.selectAll.addEventListener('click', () => {
      const every = this.#visibleIds.length > 0 && this.#visibleIds.every((id) => this.#sel.has(id));
      if (every) this.#clearSelection({ paint: false });
      else this.#setSelected(this.#visibleIds, true);
      this.#paintSelection();
    });
    els.countText = el('span', { class: 'lib-count-text', 'aria-live': 'polite' });
    els.selActions = this.#selectionActions(src);
    els.listBar = el('div', { class: 'lib-count-line lib-listbar' },
      el('div', { class: 'lib-listbar-inner' },
        el('label', { class: 'lib-select-all' }, els.selectAll),
        els.countText,
        els.selActions));
    return els.listBar;
  }

  #selectionActions(src) {
    const make = (id, label, short, iconName, onClick, extra = '') => {
      const b = button(label, { icon: iconName, size: 'sm', kind: 'ghost', className: `sel-btn sel-${id}${extra}`, title: label, onClick });
      b.setAttribute('aria-label', label);
      b.append(el('span', { class: 'sel-short', 'aria-hidden': 'true' }, short));
      return b;
    };
    const move = make('move', '폴더로 이동…', '이동', 'folder-input', () => this.#pickFolder(src, this.#selectedIds(), { fromSelection: true }));
    let copy = null;
    if (typeof src.lib.copyPaperTo === 'function' && this.#sources().some((s) => s.key !== src.key)) {
      copy = make('copy', '다른 서재로 복사…', '복사', 'copy', () => this.#copyDialog(src, { papers: this.#selectedPapers(src) }));
      copy.disabled = !this.#copyTargets(src).length;
    }
    const star = make('star', '즐겨찾기', '즐겨찾기', 'star', () => this.#starSelected(src));
    const del = make('delete', '삭제', '삭제', 'trash', () => this.#deleteSelected(src), ' is-danger');
    const clear = make('clear', '선택 해제', '해제', 'x', () => this.#clearSelection());
    this.#els.selStar = star;
    return el('div', { class: 'sel-actions', role: 'toolbar', 'aria-label': '선택한 논문', hidden: true }, move, copy, star, del, clear);
  }

  /** Selected ids in list order. */
  #selectedIds() {
    return this.#visibleIds.filter((id) => this.#sel.has(id));
  }

  /** Selected papers (as this person sees them: own 즐겨찾기 in 공용 서재), in list order. */
  #selectedPapers(src) {
    const byId = new Map(this.#papersOf(src).map((p) => [p.id, p]));
    return this.#selectedIds().map((id) => byId.get(id)).filter(Boolean);
  }

  #setSelected(ids, on) {
    for (const id of ids) {
      if (on) this.#sel.add(id);
      else this.#sel.delete(id);
    }
  }

  /** Toggle a row; with `range`, every row from the last toggled one takes this row's new state. */
  #pick(id, { range = false } = {}) {
    const on = !this.#sel.has(id);
    const from = range && this.#anchor && this.#anchor !== id ? this.#visibleIds.indexOf(this.#anchor) : -1;
    const to = this.#visibleIds.indexOf(id);
    if (from >= 0 && to >= 0) this.#setSelected(this.#visibleIds.slice(Math.min(from, to), Math.max(from, to) + 1), on);
    else this.#setSelected([id], on);
    this.#anchor = id;
    this.#paintSelection();
  }

  #clearSelection({ paint = true } = {}) {
    this.#sel.clear();
    this.#anchor = null;
    if (paint) this.#paintSelection();
  }

  /** Bring the rows, the 전체 선택 box, the count and the action bar in line with the selection (no re-render). */
  #paintSelection() {
    const els = this.#els;
    const n = this.#sel.size;
    this.#root.classList.toggle('is-selecting', n > 0);
    els.content.classList.toggle('has-selection', n > 0);
    els.content.querySelector('.paper-list')?.classList.toggle('is-selecting', n > 0);
    for (const row of els.content.querySelectorAll('.paper-row[data-id]')) {
      const on = this.#sel.has(row.dataset.id);
      row.classList.toggle('is-selected', on);
      const box = row.querySelector('.paper-check');
      if (box) box.checked = on;
    }
    if (!els.listBar?.isConnected) return;
    const total = this.#visibleIds.length;
    els.listBar.classList.toggle('is-selecting', n > 0);
    els.selectAll.checked = n > 0 && n >= total;
    els.selectAll.indeterminate = n > 0 && n < total;
    els.selectAll.setAttribute('aria-label', n > 0 && n >= total ? '전체 선택 해제' : '전체 선택');
    els.countText.replaceChildren(...(n
      ? [el('b', {}, `${n}편 선택됨`), el('span', { class: 'lib-count-of' }, ` / ${total}편`)]
      : [this.#query ? `검색 결과 ${total}편` : `논문 ${total}편`]));
    // The bar is about to hide with the keyboard focus in it (선택 해제, or after a move): focus 전체 선택 instead of nothing.
    if (!n && !els.selActions.hidden && els.selActions.contains(document.activeElement)) els.selectAll.focus({ preventScroll: true });
    els.selActions.hidden = !n;
    if (n && els.selStar) {
      const src = this.#current();
      const all = src?.lib ? this.#selectedPapers(src).every((p) => p.starred) : false;
      const label = all ? '즐겨찾기 해제' : '즐겨찾기';
      els.selStar.setAttribute('aria-label', label);
      els.selStar.title = label;
      els.selStar.setAttribute('aria-pressed', String(all));
      const text = els.selStar.querySelector('.btn-label');
      if (text) text.textContent = label;
    }
  }

  /** Ctrl/Cmd+A in the list selects every row shown. */
  #onListKey(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || String(e.key).toLowerCase() !== 'a') return;
    const t = /** @type {HTMLElement} */ (e.target);
    if (isTypingTarget(t) && t.type !== 'checkbox') return;
    if (!t.closest?.('.paper-list, .lib-listbar') || !this.#visibleIds.length) return;
    e.preventDefault();
    this.#setSelected(this.#visibleIds, true);
    this.#paintSelection();
  }

  /**
   * Run `fire` when a touch stays on `node` for LONG_PRESS_MS; the click that ends that touch is swallowed (the
   * next touch starts afresh), and so is the contextmenu Android sends for a long press (fired at once when it
   * comes first).
   */
  #onLongPress(node, fire, { ignore = '' } = {}) {
    let timer = 0;
    let x = 0;
    let y = 0;
    let firedAt = 0;
    const cancel = () => { clearTimeout(timer); timer = 0; };
    const run = () => { cancel(); firedAt = Date.now(); fire(); };
    node.addEventListener('pointerdown', (e) => {
      cancel();
      firedAt = 0;
      if (e.pointerType !== 'touch' || !e.isPrimary) return;
      if (ignore && /** @type {Element} */ (e.target).closest?.(ignore)) return;
      x = e.clientX;
      y = e.clientY;
      timer = setTimeout(run, LONG_PRESS_MS);
    });
    node.addEventListener('pointermove', (e) => {
      if (timer && Math.hypot(e.clientX - x, e.clientY - y) > LONG_PRESS_SLOP) cancel();
    });
    for (const type of ['pointerup', 'pointercancel', 'dragstart']) node.addEventListener(type, cancel);
    node.addEventListener('contextmenu', (e) => {
      const touch = (e.pointerType || this.#pointerType) === 'touch';
      if (!touch) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (timer) run();
    });
    node.addEventListener('click', (e) => {
      if (!firedAt || Date.now() - firedAt > 5000) return;
      firedAt = 0;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  #progressCell(paper) {
    const total = paper.sentenceCount || 0;
    const done = Math.min(paper.translatedCount || 0, total);
    if (!total) return el('div', { class: 'paper-progress' }, el('span', {}, done ? '번역 일부' : '번역 전'));
    const ratio = done / total;
    const pct = Math.floor(ratio * 100);
    const bar = progressBar(ratio, { label: '번역 진행률' });
    if (ratio >= 1) bar.el.classList.add('is-complete');
    return el('div', { class: `paper-progress${ratio >= 1 ? ' is-done' : ''}`, title: `${done} / ${total} 문장 번역됨` },
      el('span', {}, ratio >= 1 ? '번역 완료' : `번역 ${pct}%`), bar.el);
  }

  #subfolderChip(src, folder) {
    const chip = el('button', { type: 'button', class: 'subfolder', onclick: () => this.#select(src.key, `folder:${folder.id}`) },
      icon('folder', { size: 17 }), folder.name);
    this.#onLongPress(chip, () => {
      const r = chip.getBoundingClientRect();
      this.#folderMenu(src, folder, r.left + 12, r.bottom + 4);
    });
    chip.addEventListener('contextmenu', (e) => { e.preventDefault(); this.#folderMenu(src, folder, e.clientX, e.clientY); });
    this.#makeDropTarget(chip, src, folder.id, { acceptFolders: false });
    return chip;
  }

  /** The dashed '+ 하위 폴더' chip at the end of an open folder's subfolder row. */
  #addSubfolderChip(src, folder) {
    return el('button', {
      type: 'button', class: 'subfolder subfolder-add', title: `‘${folder.name}’ 안에 새 폴더 만들기`,
      'aria-label': `‘${folder.name}’ 안에 새 하위 폴더`, onclick: () => this.#createFolder(src, folder.id),
    }, icon('plus', { size: 16 }), '하위 폴더');
  }

  #emptyCollection(collection, folder) {
    let title = '논문이 없습니다';
    let text = 'PDF를 끌어다 놓거나 ‘PDF 추가’를 눌러 논문을 추가하세요.';
    if (this.#query) {
      title = '검색 결과가 없습니다';
      text = `‘${this.#query}’에 맞는 논문을 찾지 못했습니다.`;
    } else if (collection === 'recent') {
      title = '최근 읽은 논문이 없습니다';
      text = '논문을 열면 여기에 표시됩니다.';
    } else if (collection === 'starred') {
      title = '즐겨찾기한 논문이 없습니다';
      text = '논문 목록에서 별 아이콘을 눌러 즐겨찾기에 추가하세요.';
    } else if (folder) {
      title = '이 폴더는 비어 있습니다';
      text = '다른 목록에서 논문을 이 폴더로 끌어다 놓거나, 여기에 PDF를 추가하세요.';
    }
    return emptyState(this.#query ? 'search' : 'inbox', title, text);
  }

  #dropzone() {
    return el('div', { class: 'dropzone' },
      el('div', { class: 'icon-wrap' }, icon('upload', { size: 24 })),
      el('div', { class: 'dropzone-title' }, '논문 PDF를 이곳에 끌어다 놓으세요'),
      el('div', { class: 'dropzone-hint' }, `여러 파일을 한 번에 올릴 수 있습니다 · 파일당 최대 ${formatBytes(LIMITS.maxPdfBytes)}`),
      button('PDF 선택', { icon: 'file', kind: 'primary', onClick: () => this.#els.fileInput.click() }));
  }

  #onboarding() {
    const ai = settings.isAiReady();
    const sync = settings.isSyncReady();
    const mock = settings.get().provider === 'mock';
    const relay = settings.get().provider === 'relay';
    const step = (n, done, title, text, action) => el('li', { class: `step${done ? ' is-done' : ''}` },
      el('span', { class: 'step-num' }, done ? icon('check', { size: 16 }) : String(n)),
      el('div', {}, el('div', { class: 'step-title' }, title), el('div', { class: 'step-text' }, text)),
      action || el('span'));
    return el('section', { class: 'onboarding', 'aria-label': '시작하기' },
      el('div', { class: 'onboarding-hero' },
        brandImage('wordmark', { size: 96, alt: '갈피' }),
        el('h2', {}, '첫 논문을 추가해 보세요'),
        el('p', {}, '왼쪽에는 PDF 원문, 오른쪽에는 한국어 번역이 나란히 표시되고,\n한쪽 문장에 마우스를 올리면 반대쪽의 같은 문장이 함께 강조됩니다.')),
      this.#dropzone(),
      el('ol', { class: 'steps' },
        step(1, ai, 'AI 번역 연결',
          mock ? '테스트 모드(모의 AI)로 실행 중입니다. 실제 번역에는 설정에서 초대 코드나 API 키가 필요합니다.'
            : ai ? (relay ? '초대 코드로 연결되어 있습니다. API 키 없이 번역·요약·채팅을 쓸 수 있습니다.' : 'AI API 키가 설정되어 있습니다.')
              : '초대받았다면 받은 링크를 열거나 설정에 초대 코드를 넣으세요(키 없이 쓰기). 내 Claude·GPT·Gemini API 키도 쓸 수 있습니다(이 브라우저에만 저장).',
          button(ai && !mock ? '변경' : '설정 열기', { kind: ai && !mock ? 'ghost' : 'subtle', icon: 'key', size: 'sm', onClick: () => this.#navigate('#/settings/ai') })),
        step(2, sync, '(선택) GitHub 동기화',
          sync ? 'GitHub 비공개 저장소와 동기화하도록 설정되어 있습니다.' : '비공개 저장소 하나를 연결하면 여러 기기에서 같은 라이브러리·번역·메모를 사용할 수 있습니다.',
          button(sync ? '변경' : '설정 열기', { kind: sync ? 'ghost' : 'subtle', icon: 'git-branch', size: 'sm', onClick: () => this.#navigate('#/settings/sync') })),
        step(3, false, 'PDF 올리고 읽기', '논문을 열고 ‘번역 시작’을 누르면 현재 페이지부터 번역됩니다. 번역은 저장되어 다시 열 때 비용이 들지 않습니다.')));
  }

  /** An empty library behind the relay: who sees it, and where to start. */
  #sharedEmpty(src) {
    if (src.kind === 'code') {
      // The code's own library: one line on who can see it, then the drop zone.
      return el('section', { class: 'onboarding shared-intro is-code', 'aria-label': `${src.label} 시작하기` },
        el('div', { class: 'onboarding-hero' },
          el('div', { class: 'shared-intro-mark', 'aria-hidden': 'true' }, libraryIcon('code', 26)),
          el('h2', {}, `${src.label}에 첫 논문을 올려 보세요`),
          el('p', { class: 'shared-intro-line' }, '이 초대 코드를 가진 사람만 볼 수 있어요.')),
        this.#dropzone());
    }
    const canCopy = this.#sources().some((s) => s.key !== src.key && s.lib?.papers?.length && typeof s.lib.copyPaperTo === 'function');
    return el('section', { class: 'onboarding shared-intro', 'aria-label': `${src.label} 시작하기` },
      el('div', { class: 'onboarding-hero' },
        el('div', { class: 'shared-intro-mark', 'aria-hidden': 'true' }, sharedIcon(26)),
        el('h2', {}, `${src.label}에 첫 논문을 올려 보세요`),
        el('p', {}, '여기에 올린 PDF·폴더·번역은 초대 코드를 받은 모든 사람이 함께 씁니다.\n하이라이트·메모와 AI 요약·채팅은 각자에게만 보입니다.')),
      this.#dropzone(),
      el('ul', { class: 'shared-facts' },
        el('li', {}, icon('languages', { size: 16 }), el('span', {}, el('b', {}, '번역은 함께'), ' — 누군가 번역한 문장은 모두가 다시 비용 없이 봅니다.')),
        el('li', {}, icon('highlighter', { size: 16 }), el('span', {}, el('b', {}, '메모는 나만'), ' — 하이라이트·메모·AI 결과는 다른 사람에게 보이지 않습니다.')),
        el('li', {}, icon('trash', { size: 16 }), el('span', {}, el('b', {}, '휴지통'), ` — 누구나 지울 수 있는 대신 ${TRASH_DAYS}일 동안 복구할 수 있고, 최근 활동에 누가 무엇을 했는지 남습니다.`)),
        canCopy ? el('li', {}, icon('copy', { size: 16 }), el('span', {}, el('b', {}, '다른 서재에서 가져오기'), ' — 논문·폴더 메뉴(⋯)에서 ‘다른 서재로 복사…’를 고르세요.')) : null));
  }

  /** The route names a team library that is not open (yet). */
  #renderUnavailable(src) {
    const els = this.#els;
    const sh = this.#shared;
    const content = els.content;
    // (내 서재 hidden for an invitee whose own library is empty: no way back there to offer.)
    const toMine = this.#key !== MINE && this.#mineShown()
      ? button(`${MINE_LABEL}로`, { icon: 'arrow-left', onClick: () => this.#go(MINE) })
      : null;
    const pending = (text) => el('div', { class: 'empty-state', role: 'status' }, el('div', {},
      el('div', { class: 'icon-wrap' }, spinner(22)), el('h2', {}, text)));
    this.#setHeader(src, src?.label || SHARED_LABEL);
    const state = sh?.state || 'off';
    if ((src && src.status !== 'error') || (!src && state === 'loading')) {
      content.replaceChildren(pending(src?.status === 'opening' ? '이 기기에 서재를 여는 중…' : '공용 서재에 연결하는 중…'));
      return;
    }
    let title = '공용 서재에 연결되어 있지 않습니다';
    let text = '초대 코드를 등록하면 동료들과 공용 서재를 함께 쓸 수 있습니다.';
    const actions = [toMine].filter(Boolean);
    if (src?.status === 'error' || (!src && state === 'error')) {
      title = '공용 서재를 열지 못했습니다';
      text = src?.error || sh?.message || '잠시 후 다시 시도해 주세요.';
      actions.push(button('다시 시도', { kind: 'primary', icon: 'refresh', onClick: () => sh?.retry() }));
    } else if (state === 'ready') {
      title = '이 공용 서재를 찾을 수 없습니다';
      text = '이 초대 코드로는 쓸 수 없거나 없어진 공용 서재입니다.';
    } else if (state === 'unavailable') {
      text = '이 초대 코드로 쓸 수 있는 공용 서재가 없습니다. 초대해 준 분에게 문의해 주세요.';
    } else {
      actions.push(button('설정 열기', { kind: 'primary', icon: 'key', onClick: () => this.#navigate('#/settings/ai') }));
    }
    content.replaceChildren(el('div', { class: 'empty-state' }, el('div', {},
      el('div', { class: 'icon-wrap' }, libraryIcon(src?.kind || 'team', 24)), el('h2', {}, title), el('p', {}, text),
      el('div', { class: 'btn-row', style: { justifyContent: 'center' } }, actions))));
  }

  // ----------------------------------------------------------------- 휴지통

  async #renderTrash(src, token) {
    const els = this.#els;
    this.#setHeader(src, PAGES.trash.label);
    if (typeof src.lib.trash !== 'function') {
      els.content.replaceChildren(emptyState('trash', '휴지통을 쓸 수 없습니다', '이 버전의 저장소 모듈에는 휴지통이 없습니다. 페이지를 새로 고쳐 보세요.'));
      return;
    }
    let items;
    try {
      items = normalizeTrash(await src.lib.trash());
    } catch (err) {
      if (token !== this.#mainToken) return;
      console.warn('[library-view] trash', err);
      els.content.replaceChildren(emptyState('alert-circle', '휴지통을 불러오지 못했습니다', err?.message || '잠시 후 다시 시도해 주세요.'));
      return;
    }
    if (token !== this.#mainToken) return;
    const now = Date.now();
    const fresh = items.filter((x) => !isExpired(x, now));
    const old = items.filter((x) => isExpired(x, now));
    const content = el('div', { class: 'trash' });
    content.append(note('trash', src.shared
      ? `${src.label}에서 삭제한 폴더와 논문은 ${TRASH_DAYS}일 동안 여기에서 복구할 수 있습니다. 누가 언제 삭제했는지 함께 표시됩니다.`
      : `${MINE_LABEL}에서 ${TRASH_DAYS}일 안에 삭제한 폴더입니다. 폴더를 복구해도 안에 있던 논문은 삭제할 때 옮겨진 곳에 그대로 있습니다. 내 서재의 논문은 삭제하면 PDF·번역·메모가 함께 지워져 휴지통에 남지 않습니다.`));
    const admin = this.#trashAdmin(src, old);
    if (admin) content.append(admin);
    if (!items.length) {
      content.append(emptyState('trash', '휴지통이 비어 있습니다', src.shared ? '공용 서재에서 삭제한 항목이 여기에 30일 동안 보관됩니다.' : '삭제한 폴더가 여기에 표시됩니다.'));
    } else {
      if (fresh.length) content.append(el('div', { class: 'trash-list', role: 'list' }, fresh.map((x) => this.#trashRow(src, x, now))));
      if (old.length) {
        content.append(el('details', { class: 'trash-old', open: !fresh.length },
          el('summary', {}, `${TRASH_DAYS}일 지난 항목 ${old.length}개`),
          el('p', { class: 'field-hint' }, src.shared ? '관리자가 비우기 전까지는 복구할 수 있습니다. 비운 뒤에는 PDF와 번역이 지워집니다.' : '오래전에 삭제한 항목입니다.'),
          el('div', { class: 'trash-list', role: 'list' }, old.map((x) => this.#trashRow(src, x, now)))));
      }
    }
    els.content.replaceChildren(content);
  }

  #trashRow(src, item, now) {
    const age = Math.max(0, Math.floor((now - item.deletedAt) / DAY_MS));
    const left = TRASH_DAYS - age;
    const meta = [];
    if (item.deletedBy) meta.push(el('span', { class: 'trash-who' }, item.deletedBy));
    if (item.deletedAt) meta.push(el('span', {}, `${whenText(item.deletedAt, now)} 삭제`));
    if (src.shared && item.deletedAt) meta.push(el('span', {}, left > 0 ? `${left}일 남음` : '보관 기간 지남'));
    if (item.kind === 'paper' && item.authors) meta.push(el('span', { class: 'paper-authors' }, item.authors));
    const metaLine = el('div', { class: 'paper-meta' });
    meta.forEach((m, i) => { if (i) metaLine.append(el('span', { class: 'sep', 'aria-hidden': 'true' }, '·')); metaLine.append(m); });
    const canRestore = item.restorable && typeof src.lib.restore === 'function';
    const restore = button('복구', {
      icon: 'rotate-ccw', size: 'sm', disabled: !canRestore,
      title: canRestore ? `‘${item.name}’ 복구` : item.reason || '복구할 수 없습니다',
      onClick: () => this.#restore(src, item),
    });
    return el('div', { class: 'trash-row', role: 'listitem', 'data-id': item.id, 'data-kind': item.kind },
      el('div', { class: 'paper-thumb', 'aria-hidden': 'true' }, icon(item.kind === 'folder' ? 'folder' : 'file-text', { size: 20 })),
      el('div', { class: 'paper-main' },
        el('div', { class: 'trash-name', title: item.name }, item.name),
        metaLine,
        !canRestore && item.reason ? el('div', { class: 'field-hint trash-reason' }, item.reason) : null),
      el('div', { class: 'paper-side' }, restore));
  }

  /**
   * The owner (admin token saved) can remove the files of papers deleted more than 30 days ago — in 전체 공용 서재
   * (the relay's purge is per team library; a code library has none).
   */
  #trashAdmin(src, old) {
    const relay = this.#deps.relay;
    if (!src.shared || src.kind !== 'team' || !settings.get().relay?.adminToken || typeof relay?.purgeShared !== 'function') return null;
    const expiredPapers = old.filter((x) => x.kind === 'paper').length;
    return el('div', { class: 'trash-admin' },
      el('div', {},
        el('div', { class: 'trash-admin-title' }, icon('key', { size: 15 }), '관리자'),
        el('p', { class: 'field-hint' }, expiredPapers
          ? `${TRASH_DAYS}일 넘게 휴지통에 있던 논문 ${expiredPapers}편의 PDF와 번역을 팀 저장소에서 지워 공간을 비웁니다.`
          : `${TRASH_DAYS}일 넘게 휴지통에 있던 논문의 PDF와 번역을 팀 저장소에서 지워 공간을 비웁니다. 지금은 이 기기에서 보이는 대상이 없습니다.`)),
      button(`${TRASH_DAYS}일 지난 항목 비우기`, { icon: 'trash', kind: 'danger', size: 'sm', onClick: () => this.#purge(src, expiredPapers) }));
  }

  async #purge(src, count) {
    const ok = await confirmDialog(
      `${src.label}의 휴지통에 ${TRASH_DAYS}일 넘게 있던 논문${count ? ` ${count}편` : ''}의 PDF와 번역을 팀 저장소에서 지웁니다.\n지운 논문은 더 이상 복구할 수 없습니다(삭제 기록은 남습니다).`,
      { okLabel: '비우기', danger: true, title: `${TRASH_DAYS}일 지난 항목 비우기` });
    if (!ok) return;
    const status = busyToast('휴지통을 비우는 중…');
    try {
      const r = await this.#deps.relay.purgeShared(src.id);
      status.close();
      toast(r.purged
        ? `논문 ${r.purged}편의 파일을 지웠습니다${r.bytes ? ` (${formatBytes(r.bytes)} 확보)` : ''}.`
        : `${TRASH_DAYS}일 지난 논문이 없어 지운 파일이 없습니다.`, { kind: 'success' });
      src.lib.sync?.syncNow?.().catch?.(() => {});
    } catch (err) {
      status.close();
      this.#fail(err);
    }
  }

  async #restore(src, item) {
    try {
      await src.lib.restore(item.id);
      this.#renderNav(); // the restored item is in the sidebar by the time the toast says so
      const action = item.kind === 'paper'
        ? { label: '열기', onClick: () => this.#navigate(paperHref(src, item.id)) }
        : { label: '폴더 보기', onClick: () => this.#reveal(src.key, `folder:${item.id}`) };
      toast(`‘${shorten(item.name)}’을(를) 복구했습니다.`, { kind: 'success', timeout: 6000, action });
    } catch (err) {
      this.#fail(err);
    }
    if (this.#page === 'trash') this.#renderMain();
  }

  // -------------------------------------------------------------- 최근 활동

  #renderActivity(src, token) {
    const els = this.#els;
    this.#setHeader(src, PAGES.activity.label);
    const relay = this.#deps.relay;
    const refresh = button('새로 고침', { icon: 'refresh', size: 'sm', onClick: () => this.#loadActivity(src, true) });
    const head = el('div', { class: 'activity-head' },
      el('p', { class: 'field-hint' }, `${src.label}에서 누가 무엇을 추가·이동·삭제했는지 보여 줍니다(팀 저장소의 변경 기록).`), refresh);
    if (typeof relay?.fetchActivity !== 'function') {
      els.content.replaceChildren(head, emptyState('alert-circle', '최근 활동을 불러올 수 없습니다', '초대 코드 모듈을 불러오지 못했습니다. 페이지를 새로 고쳐 보세요.'));
      return;
    }
    const a = this.#activity.get(src.key);
    if (!a || (!a.loading && Date.now() - a.at > ACTIVITY_STALE_MS)) {
      this.#loadActivity(src, false);
      return;
    }
    if (token !== this.#mainToken) return;
    refresh.disabled = a.loading;
    let body;
    if (a.loading && !a.items) {
      body = el('div', { class: 'empty-state', role: 'status' }, el('div', {}, el('div', { class: 'icon-wrap' }, spinner(22)), el('h2', {}, '최근 활동을 불러오는 중…')));
    } else if (a.error && !a.items) {
      body = el('div', { class: 'empty-state' }, el('div', {},
        el('div', { class: 'icon-wrap' }, icon('alert-circle', { size: 24 })), el('h2', {}, '최근 활동을 불러오지 못했습니다'), el('p', {}, a.error),
        el('div', { class: 'btn-row', style: { justifyContent: 'center' } }, button('다시 시도', { kind: 'primary', icon: 'refresh', onClick: () => this.#loadActivity(src, true) }))));
    } else if (!a.items.length) {
      body = emptyState('list', '아직 활동이 없습니다', '폴더를 만들거나 논문을 올리면 여기에 기록됩니다.');
    } else {
      body = this.#activityList(src, a.items, a.titles);
    }
    els.content.replaceChildren(...[head, a.error && a.items ? note('alert-triangle', `새로 고치지 못했습니다: ${a.error}`) : null, body].filter(Boolean));
  }

  async #loadActivity(src, force) {
    const prev = this.#activity.get(src.key);
    if (prev?.loading) return;
    if (prev && !force && Date.now() - prev.at <= ACTIVITY_STALE_MS) return;
    const entry = { ...(prev || {}), loading: true, error: '', at: prev?.at || 0 };
    this.#activity.set(src.key, entry);
    if (this.#key === src.key && this.#page === 'activity') this.#renderMain();
    try {
      const [{ items: all }, titles] = await Promise.all([this.#deps.relay.fetchActivity(src.id), this.#titleMap(src)]);
      const items = all.filter((item) => !QUIET_ACTIVITY.has(String(item.summary || '').trim()));
      this.#activity.set(src.key, { items, titles, error: '', loading: false, at: Date.now() });
    } catch (err) {
      console.warn('[library-view] activity', err);
      this.#activity.set(src.key, { ...entry, loading: false, error: err?.message || '최근 활동을 불러오지 못했습니다.', at: Date.now() });
    }
    if (this.#key === src.key && this.#page === 'activity') this.#renderMain();
  }

  /** Paper id → title, deleted papers included (activity names papers by their repo paths). */
  async #titleMap(src) {
    const map = new Map();
    try {
      if (typeof src.lib.trash === 'function') for (const x of normalizeTrash(await src.lib.trash())) if (x.kind === 'paper') map.set(x.id, x.name);
    } catch { /* titles of deleted papers are optional */ }
    for (const p of src.lib.papers) map.set(p.id, paperTitle(p));
    return map;
  }

  #activityList(src, items, titles = new Map()) {
    const groups = new Map();
    const now = Date.now();
    for (const item of items) {
      const day = dayLabel(item.ts, now);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(item);
    }
    const me = this.#shared?.personName || '';
    return el('div', { class: 'activity' }, [...groups].map(([day, list]) => el('section', { class: 'activity-day' },
      el('h2', { class: 'activity-day-title' }, day),
      el('ol', { class: 'activity-list' }, list.map((item) => {
        // A commit made outside the app (e.g. the repository's first README) has no name.
        const who = item.who || '팀 저장소';
        const text = describeChange(item.summary, (id) => titles.get(id) || src.lib.getPaper(id)?.title || '');
        return el('li', { class: 'activity-item' },
          el('span', { class: `activity-avatar${me && who === me ? ' is-me' : ''}${item.who ? '' : ' is-system'}`, 'aria-hidden': 'true' },
            item.who ? Array.from(who)[0] : icon('git-branch', { size: 15 })),
          el('div', { class: 'activity-main' },
            el('div', { class: 'activity-text' }, el('b', {}, who), me && who === me ? el('span', { class: 'badge' }, '나') : null, ' ', text),
            el('time', { class: 'activity-time', datetime: item.ts ? new Date(item.ts).toISOString() : null, title: item.summary }, item.ts ? timeText(item.ts) : '')));
      })))));
  }

  // ------------------------------------------------------------- menus

  #paperMenu(src, paper, x, y) {
    const items = [
      { label: '열기', icon: 'book-open', onClick: () => this.#navigate(paperHref(src, paper.id)) },
      { label: paper.starred ? '즐겨찾기 해제' : '즐겨찾기 추가', icon: 'star', onClick: () => this.#toggleStar(src, paper) },
      { label: '폴더로 이동…', icon: 'folder-input', onClick: () => this.#pickFolder(src, [paper.id], { okLabel: '이동' }) },
      { label: '제목 바꾸기', icon: 'pencil', onClick: () => this.#renamePaper(src, paper) },
    ];
    const copy = this.#copyItem(src, 'paper', () => this.#copyDialog(src, { paper }));
    if (copy) items.push(copy);
    items.push('sep', { label: '삭제', icon: 'trash', danger: true, onClick: () => this.#deletePaper(src, paper) });
    contextMenu(items, x, y);
  }

  #folderMenu(src, folder, x, y) {
    const live = src.lib.getFolder(folder.id) || folder;
    const inside = this.#subtree(src.lib, live.id);
    const elsewhere = src.lib.folders.some((f) => !inside.has(f.id) && f.id !== live.parentId);
    const items = [
      { label: '새 하위 폴더', icon: 'folder-plus', onClick: () => this.#createFolder(src, live.id) },
      { label: '이름 바꾸기', icon: 'pencil', onClick: () => this.#renameFolder(src, live) },
      { label: '다른 폴더 안으로 옮기기…', icon: 'folder-input', disabled: !elsewhere && !live.parentId, onClick: () => this.#pickFolderParent(src, live) },
      { label: '최상위로 옮기기', icon: 'chevron-up', disabled: !live.parentId, onClick: () => this.#moveFolder(src, live.id, null, { notify: true }) },
    ];
    const copy = this.#copyItem(src, 'folder', () => this.#copyDialog(src, { folder: live }));
    if (copy) items.push(copy);
    items.push('sep', { label: '삭제', icon: 'trash', danger: true, onClick: () => this.#deleteFolder(src, live) });
    contextMenu(items, x, y);
  }

  /** A folder and every folder below it (ids). */
  #subtree(lib, folderId) {
    const out = new Set([folderId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const f of lib.folders) {
        if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; }
      }
    }
    return out;
  }

  /**
   * '다른 서재로 복사…' whenever the sidebar shows another library (disabled while none of them is open yet, e.g.
   * 공용 서재 still connecting).
   */
  #copyItem(src, kind, onClick) {
    const method = kind === 'paper' ? 'copyPaperTo' : 'copyFolderTo';
    if (typeof src.lib?.[method] !== 'function') return null;
    if (!this.#sources().some((s) => s.key !== src.key)) return null;
    const ready = this.#copyTargets(src).length > 0;
    return { label: '다른 서재로 복사…', icon: 'copy', disabled: !ready, onClick };
  }

  /** The other libraries that are open (copy targets), in sidebar order. */
  #copyTargets(src) {
    return this.#sources().filter((s) => s.key !== src.key && s.lib && !s.placeholder);
  }

  #toggleStar(src, paper) {
    if (src.shared) {
      updatePersonal(src.id, (p) => {
        p.starred = paper.starred ? p.starred.filter((id) => id !== paper.id) : [...p.starred.filter((id) => id !== paper.id), paper.id];
      });
      this.#renderNav();
      this.#renderMain();
      return;
    }
    try { src.lib.updatePaper(paper.id, { starred: !paper.starred }); } catch (err) { this.#fail(err); }
  }

  async #createFolder(src, parentId) {
    const parent = parentId ? src.lib.getFolder(parentId) : null;
    const where = this.#named(src) && !parent ? `${src.label}에 만들 ` : '';
    const name = await promptDialog(parent ? `‘${parent.name}’ 안에 만들 폴더 이름` : `${where}새 폴더 이름`, { placeholder: '예: 섬망 연구', okLabel: '만들기', title: '새 폴더' });
    if (name == null || !name.trim()) return;
    try {
      const folder = src.lib.createFolder(name.trim(), parentId);
      if (parentId) this.#stateOf(src.key).expanded.add(parentId);
      this.#persist(src.key);
      if (folder?.id) this.#select(src.key, `folder:${folder.id}`);
      toast(`‘${name.trim()}’ 폴더를 만들었습니다.`, { kind: 'success' });
    } catch (err) { this.#fail(err); }
  }

  async #renameFolder(src, folder) {
    const name = await promptDialog('폴더 이름', { value: folder.name, okLabel: '바꾸기', title: '이름 바꾸기' });
    if (name == null || !name.trim() || name.trim() === folder.name) return;
    try { src.lib.renameFolder(folder.id, name.trim()); } catch (err) { this.#fail(err); }
  }

  async #deleteFolder(src, folder) {
    const parent = folder.parentId ? src.lib.getFolder(folder.parentId) : null;
    const where = parent ? `‘${parent.name}’ 폴더` : '최상위';
    // 공용 서재 keeps the contents pointing at the deleted folder: they show in its parent, and 복구 puts them back.
    const ok = src.shared
      ? await confirmDialog(`‘${folder.name}’ 폴더를 휴지통으로 이동합니다. ${TRASH_DAYS}일 안에 복구할 수 있습니다.\n안에 있는 논문과 하위 폴더는 삭제되지 않고 ${where}에 보이며, 폴더를 복구하면 다시 폴더 안으로 돌아갑니다.`,
        { okLabel: '휴지통으로 이동', danger: true, title: `${src.label}에서 폴더 삭제` })
      : await confirmDialog(`‘${folder.name}’ 폴더를 삭제할까요?\n안에 있는 논문과 하위 폴더는 ${parent ? `‘${parent.name}’ 폴더로` : '최상위로'} 옮겨집니다. 논문은 삭제되지 않습니다.`,
        { okLabel: '폴더 삭제', danger: true, title: '폴더 삭제' });
    if (!ok) return;
    try {
      src.lib.deleteFolder(folder.id);
      const st = this.#stateOf(src.key);
      if (st.collection === `folder:${folder.id}`) st.collection = parent ? `folder:${parent.id}` : 'all';
      this.#persist(src.key);
      toast(src.shared ? `‘${folder.name}’ 폴더를 휴지통으로 옮겼습니다.` : `‘${folder.name}’ 폴더를 삭제했습니다.`, this.#undoOptions(src, { kind: 'folder', id: folder.id, name: folder.name }));
    } catch (err) { this.#fail(err); }
  }

  /** Move a folder under `parentId` (null = top level). `notify`: a toast with 되돌리기 (menu and picker moves). */
  #moveFolder(src, id, parentId, { notify = false } = {}) {
    if (parentId && this.#chain(src.lib, parentId).some((f) => f.id === id)) {
      toast('폴더를 자기 자신이나 하위 폴더 안으로 옮길 수 없습니다.', { kind: 'warning' });
      return;
    }
    const folder = src.lib.getFolder(id);
    const before = folder?.parentId ?? null;
    if (!folder || before === (parentId ?? null)) return;
    try {
      src.lib.moveFolder(id, parentId);
      if (parentId) { this.#stateOf(src.key).expanded.add(parentId); this.#persist(src.key); }
    } catch (err) { this.#fail(err); return; }
    if (!notify) return;
    const target = parentId ? src.lib.getFolder(parentId)?.name : null;
    toast(target ? `‘${folder.name}’ 폴더를 ‘${target}’ 안으로 옮겼습니다.` : `‘${folder.name}’ 폴더를 최상위로 옮겼습니다.`, {
      kind: 'success', timeout: 7000,
      action: {
        label: '되돌리기',
        onClick: () => {
          if (!src.lib.getFolder(id) || (before && !src.lib.getFolder(before))) { toast('되돌릴 수 없습니다. 폴더가 지워졌습니다.', { kind: 'warning' }); return; }
          try { src.lib.moveFolder(id, before); } catch (err) { this.#fail(err); }
        },
      },
    });
  }

  /**
   * Move papers into `folderId` (null = out of every folder) in one batch: every move happens in the same task, so
   * the library writes library.json once (one sync commit). The toast offers 되돌리기 (back to each paper's folder).
   */
  #movePapers(src, ids, folderId) {
    const target = folderId ? src.lib.getFolder(folderId) : null;
    if (folderId && !target) { toast('대상 폴더를 찾을 수 없습니다. 다른 기기에서 삭제되었을 수 있습니다.', { kind: 'warning' }); return; }
    const before = new Map();
    const failed = [];
    let last = null;
    for (const id of ids) {
      const paper = src.lib.getPaper(id);
      const from = paper?.folderId ?? null;
      if (!paper || from === folderId) continue;
      try {
        src.lib.movePaper(id, folderId);
        before.set(id, from);
        last = paper;
      } catch (err) {
        failed.push(err);
      }
    }
    if (failed.length) this.#fail(failed[0]);
    const n = before.size;
    if (!n) {
      if (!failed.length) toast(target ? `이미 ‘${target.name}’ 폴더에 있습니다.` : '이미 폴더 밖(최상위)에 있습니다.', { kind: 'info' });
      return;
    }
    let message;
    if (n === 1) {
      const title = shorten(paperTitle(last), 60);
      message = target ? `‘${title}’을(를) ‘${target.name}’ 폴더로 옮겼습니다.` : `‘${title}’을(를) 폴더에서 뺐습니다.`;
    } else {
      message = target ? `${n}편을 ‘${target.name}’${ro(target.name)} 옮겼습니다.` : `${n}편을 최상위로 옮겼습니다.`;
    }
    toast(message, {
      kind: 'success', timeout: 8000,
      action: { label: '되돌리기', onClick: () => this.#undoMove(src, before) },
    });
  }

  /** 되돌리기 of #movePapers: each paper back to its folder (one batch again); gone papers/folders are skipped. */
  #undoMove(src, before) {
    let n = 0;
    for (const [id, folderId] of before) {
      const paper = src.lib.getPaper(id);
      if (!paper || (folderId && !src.lib.getFolder(folderId)) || (paper.folderId ?? null) === folderId) continue;
      try { src.lib.movePaper(id, folderId); n++; } catch (err) { console.warn('[library-view] undo move', id, err); }
    }
    toast(n ? `${n}편을 원래 폴더로 되돌렸습니다.` : '되돌릴 논문이 없습니다.', { kind: n ? 'success' : 'info' });
  }

  async #renamePaper(src, paper) {
    const title = await promptDialog('논문 제목', { value: paperTitle(paper), okLabel: '바꾸기', title: '제목 바꾸기' });
    if (title == null || !title.trim()) return;
    try { src.lib.updatePaper(paper.id, { title: title.trim() }); } catch (err) { this.#fail(err); }
  }

  async #deletePaper(src, paper) {
    const title = paperTitle(paper);
    const ok = src.shared
      ? await confirmDialog(`‘${title}’을(를) 휴지통으로 이동합니다. ${TRASH_DAYS}일 안에 복구할 수 있습니다.\n이 서재를 함께 쓰는 모든 사람의 목록에서 사라집니다.`,
        { okLabel: '휴지통으로 이동', danger: true, title: `${src.label}에서 삭제` })
      : await confirmDialog(`‘${title}’을(를) 라이브러리에서 삭제할까요?\n번역·메모·AI 결과도 함께 지워집니다.`, { okLabel: '삭제', danger: true, title: '논문 삭제' });
    if (!ok) return;
    try {
      src.lib.deletePaper(paper.id);
      toast(src.shared ? `‘${shorten(title)}’을(를) 휴지통으로 옮겼습니다.` : '논문을 삭제했습니다.', this.#undoOptions(src, { kind: 'paper', id: paper.id, name: title }));
    } catch (err) { this.#fail(err); }
  }

  /** 되돌리기 on the toast after a delete in 공용 서재 (the item is in the 휴지통). */
  #undoOptions(src, item) {
    if (!src.shared || typeof src.lib.restore !== 'function') return {};
    return { timeout: 7000, action: { label: '되돌리기', onClick: () => this.#restore(src, { ...item, restorable: true }) } };
  }

  /** '폴더로 이동…' for one paper (its menu) or the selection: the folder picker, then one batch move. */
  #pickFolder(src, ids, { okLabel = '옮기기', fromSelection = false } = {}) {
    const papers = ids.map((id) => src.lib.getPaper(id)).filter(Boolean);
    if (!papers.length) return;
    const folders = new Set(papers.map((p) => p.folderId ?? null));
    const here = folders.size === 1 ? [...folders][0] : undefined;
    let dlg = null;
    const picker = folderPicker(src.lib, {
      chosen: here ?? null, current: here, rootLabel: '최상위 (폴더 없음)', rootIcon: libraryIcon(src.kind, 16),
      onSubmit: () => dlg?.el.querySelector('.modal-footer .btn-primary')?.click(),
      onError: (err) => this.#fail(err),
    });
    const what = papers.length === 1 ? `‘${shorten(paperTitle(papers[0]), 80)}’` : `논문 ${papers.length}편`;
    dlg = modal({
      title: '폴더로 이동',
      size: 'sm',
      className: 'move-dialog',
      // '을(를)' stays on the title's line (a break before '(를)' reads badly).
      body: el('div', {}, el('p', { class: 'modal-message' },
        what, el('span', { class: 'nowrap' }, `${papers.length === 1 ? '을(를)' : '을'} 옮길`), ' 폴더를 고르세요.'), picker.el),
      actions: [
        { label: '취소' },
        { label: okLabel, kind: 'primary', onClick: () => {
          this.#movePapers(src, papers.map((p) => p.id), picker.chosen);
          if (fromSelection) this.#clearSelection();
        } },
      ],
    });
  }

  /** '다른 폴더 안으로 옮기기…': the picker without the folder itself and what is inside it. */
  #pickFolderParent(src, folder) {
    let dlg = null;
    const picker = folderPicker(src.lib, {
      chosen: folder.parentId ?? null, current: folder.parentId ?? null, exclude: this.#subtree(src.lib, folder.id),
      rootLabel: '최상위 (폴더 없음)', rootIcon: libraryIcon(src.kind, 16),
      onSubmit: () => dlg?.el.querySelector('.modal-footer .btn-primary')?.click(),
      onError: (err) => this.#fail(err),
    });
    dlg = modal({
      title: '폴더 옮기기',
      size: 'sm',
      className: 'move-dialog',
      body: el('div', {}, el('p', { class: 'modal-message' }, `‘${folder.name}’ 폴더를 넣을 곳을 고르세요.`), picker.el),
      actions: [
        { label: '취소' },
        { label: '옮기기', kind: 'primary', onClick: () => this.#moveFolder(src, folder.id, picker.chosen, { notify: true }) },
      ],
    });
  }

  // ------------------------------------------------------------ bulk actions

  /** 즐겨찾기 for the selection: all on, or all off when every one is starred already. */
  #starSelected(src) {
    const papers = this.#selectedPapers(src);
    if (!papers.length) return;
    const on = !papers.every((p) => p.starred);
    const ids = new Set(papers.map((p) => p.id));
    try {
      if (src.shared) {
        updatePersonal(src.id, (p) => {
          p.starred = on ? [...p.starred.filter((id) => !ids.has(id)), ...ids] : p.starred.filter((id) => !ids.has(id));
        });
        this.#renderNav();
        this.#renderMain();
      } else {
        for (const p of papers) if (Boolean(p.starred) !== on) src.lib.updatePaper(p.id, { starred: on });
      }
    } catch (err) { this.#fail(err); return; }
    toast(on ? `${papers.length}편을 즐겨찾기에 추가했습니다.` : `${papers.length}편을 즐겨찾기에서 뺐습니다.`, { kind: 'success' });
  }

  /** 삭제 for the selection: one question with the count and this library's rule, then one batch. */
  async #deleteSelected(src) {
    const papers = this.#selectedPapers(src);
    if (!papers.length) return;
    if (papers.length === 1) {
      await this.#deletePaper(src, papers[0]);
      if (!src.lib.getPaper(papers[0].id)) this.#clearSelection();
      return;
    }
    const n = papers.length;
    const ok = src.shared
      ? await confirmDialog(`논문 ${n}편을 휴지통으로 이동합니다. ${TRASH_DAYS}일 안에 복구할 수 있습니다.\n이 서재를 함께 쓰는 모든 사람의 목록에서 사라집니다.`,
        { okLabel: '휴지통으로 이동', danger: true, title: `${src.label}에서 ${n}편 삭제` })
      : await confirmDialog(`논문 ${n}편을 라이브러리에서 삭제할까요?\n번역·메모·AI 결과도 함께 지워지며 되돌릴 수 없습니다.`,
        { okLabel: `${n}편 삭제`, danger: true, title: '논문 삭제' });
    if (!ok) return;
    const done = [];
    const failed = [];
    for (const p of papers) {
      try { src.lib.deletePaper(p.id); done.push(p); } catch (err) { failed.push(err); }
    }
    this.#clearSelection();
    if (failed.length) this.#fail(failed[0]);
    if (!done.length) return;
    if (!src.shared || typeof src.lib.restore !== 'function') {
      toast(`논문 ${done.length}편을 삭제했습니다.`, { kind: 'success' });
      return;
    }
    toast(`논문 ${done.length}편을 휴지통으로 옮겼습니다.`, {
      kind: 'success', timeout: 8000,
      action: { label: '되돌리기', onClick: () => this.#restoreMany(src, done) },
    });
  }

  /** 되돌리기 of a bulk delete in 공용 서재: every paper back from the 휴지통. */
  async #restoreMany(src, papers) {
    let n = 0;
    const failed = [];
    for (const p of papers) {
      try { await src.lib.restore(p.id); n++; } catch (err) { failed.push(err); }
    }
    if (n) toast(`논문 ${n}편을 복구했습니다.`, { kind: 'success' });
    if (failed.length) this.#fail(failed[0]);
    if (this.#page === 'trash') this.#renderMain();
  }

  /** Show `collection` of library `key` (e.g. the folder something was copied or restored into). */
  #reveal(key, collection) {
    const st = this.#stateOf(key);
    if (key !== this.#key || st.collection !== collection) this.#clearSelection({ paint: false });
    st.collection = collection;
    const src = this.#source(key);
    if (src?.lib && collection.startsWith('folder:')) for (const f of this.#chain(src.lib, collection.slice(7)).slice(1)) st.expanded.add(f.id);
    this.#persist(key);
    if (key === this.#key && this.#page === 'list') this.#renderAll();
    else this.#go(key, 'list');
  }

  // ------------------------------------------------------ 다른 서재로 복사

  /**
   * Pick the library (any other one in the sidebar) and the folder a paper or folder goes to. Only the PDF and the
   * translation are copied (never this person's highlights, notes or AI results); a PDF the target already has
   * (sha256) is placed, not uploaded again.
   */
  #copyDialog(src, { paper = null, folder = null, papers = null }) {
    const targets = this.#copyTargets(src);
    if (!targets.length) { toast('다른 서재가 아직 열리지 않았습니다. 잠시 후 다시 시도해 주세요.', { kind: 'warning' }); return; }
    if (papers?.length === 1) [paper, papers] = [papers[0], null];
    if (papers && !papers.length) return;
    const last = uiState.get(COPY_TARGET_KEY, '');
    let target = targets.find((t) => t.key === last) || targets[0];
    let picker = null;
    let dlg = null;
    const pickerHost = el('div', { class: 'copy-picker' });
    const noteHost = el('div', {});
    const renderPicker = () => {
      picker = folderPicker(target.lib, {
        chosen: null, rootLabel: `${target.label} (최상위)`, rootIcon: libraryIcon(target.kind, 16),
        onSubmit: () => dlg?.el.querySelector('.modal-footer .btn-primary')?.click(),
        onError: (err) => this.#fail(err),
      });
      pickerHost.replaceChildren(picker.el);
      noteHost.replaceChildren(note('info', copyNote(target)));
    };
    // The target picker: every other library the person has (one button each, the chosen one pressed).
    const libChoice = el('div', { class: 'segmented copy-libs', role: 'group', 'aria-label': '복사할 서재' });
    const draw = () => libChoice.replaceChildren(...targets.map((t) => {
      const b = button(t.label, {
        size: 'sm', pressed: t === target, className: `copy-lib is-${t.kind}`,
        onClick: () => { if (t === target) return; target = t; draw(); renderPicker(); },
      });
      b.dataset.lib = t.key;
      b.prepend(libraryIcon(t.kind, 15));
      return b;
    }));
    draw();
    renderPicker();
    const count = folder ? folderPaperCount(src.lib, folder.id) : 0;
    const what = papers ? `논문 ${papers.length}편` : paper ? `‘${shorten(paperTitle(paper))}’` : `‘${folder.name}’ 폴더(하위 폴더 포함 논문 ${count}편)`;
    dlg = modal({
      title: '다른 서재로 복사',
      size: 'sm',
      className: 'copy-dialog',
      body: el('div', {},
        el('p', { class: 'modal-message' }, what, el('span', { class: 'nowrap' }, `${papers ? '을' : '을(를)'} 복사할`), ' 서재와 폴더를 고르세요.'),
        libChoice,
        pickerHost,
        noteHost),
      actions: [
        { label: '취소' },
        { label: '복사', kind: 'primary', onClick: () => {
          uiState.set(COPY_TARGET_KEY, target.key);
          this.#runCopy(src, target, picker.chosen, { paper, folder, papers });
        } },
      ],
    });
  }

  async #runCopy(src, target, folderId, { paper = null, folder = null, papers = null }) {
    if (papers) { await this.#runCopyMany(src, target, folderId, papers); return; }
    const name = paper ? shorten(paperTitle(paper)) : folder.name;
    const busy = paper ? `‘${name}’을(를) ${target.label}에 복사하는 중…` : `‘${name}’ 폴더를 ${target.label}에 복사하는 중…`;
    const status = busyToast(busy);
    let result;
    try {
      result = paper
        ? await src.lib.copyPaperTo(target.lib, paper.id, { folderId })
        : await src.lib.copyFolderTo(target.lib, folder.id, {
          parentId: folderId,
          onProgress: ({ done, total, title }) => {
            if (total) status.update(`${busy} (${done}/${total})${title ? `\n${shorten(title, 60)}` : ''}`);
          },
        });
    } catch (err) {
      status.close();
      this.#fail(err);
      return;
    }
    status.close();
    const out = copyOutcome(result, { paper: Boolean(paper) });
    const place = folderId ? `‘${target.lib.getFolder(folderId)?.name || '폴더'}’ 폴더` : '최상위';
    let message;
    if (paper) {
      message = out.reused
        ? `‘${name}’은(는) 이미 ${target.label}에 있어 새로 올리지 않고 ${place}에 두었습니다.`
        : `‘${name}’을(를) ${target.label} ${place}에 복사했습니다.`;
    } else {
      const parts = [`논문 ${out.copied}편 복사`];
      if (out.reused) parts.push(`이미 있던 ${out.reused}편은 폴더에만 넣음`);
      message = `‘${name}’ 폴더를 ${target.label} ${place}에 복사했습니다 (${parts.join(', ')}).`;
    }
    const reveal = paper ? (folderId ? `folder:${folderId}` : 'all') : (out.folderId ? `folder:${out.folderId}` : (folderId ? `folder:${folderId}` : 'all'));
    toast(message, { kind: 'success', timeout: 8000, action: { label: '보기', onClick: () => this.#reveal(target.key, reveal) } });
    if (out.failed.length) {
      const lines = out.failed.slice(0, 4).map((f) => `• ${shorten(f.title || f.id, 40)}: ${f.message}`);
      if (out.failed.length > 4) lines.push(`외 ${out.failed.length - 4}편`);
      toast(`복사하지 못한 논문이 있습니다.\n${lines.join('\n')}`, { kind: 'error', timeout: 10000 });
    }
  }

  /**
   * Several papers into another library, one after the other as copyPaperTo() does (PDF + translation; a PDF the
   * target has already is placed, not uploaded again), with the progress in a toast.
   */
  async #runCopyMany(src, target, folderId, papers) {
    const n = papers.length;
    const busy = `논문 ${n}편을 ${target.label}에 복사하는 중…`;
    const status = busyToast(`${busy} (0/${n})`);
    let copied = 0;
    let reused = 0;
    const failed = [];
    for (const [i, p] of papers.entries()) {
      status.update(`${busy} (${i + 1}/${n})\n${shorten(paperTitle(p), 60)}`);
      try {
        const r = await src.lib.copyPaperTo(target.lib, p.id, { folderId });
        if (r?.existing) reused++;
        else copied++;
      } catch (err) {
        console.warn('[library-view] copy', p.id, err);
        failed.push({ id: p.id, title: paperTitle(p), message: err?.message || '알 수 없는 오류' });
      }
    }
    status.close();
    const place = folderId ? `‘${target.lib.getFolder(folderId)?.name || '폴더'}’ 폴더` : '최상위';
    if (copied + reused) {
      const extra = reused ? ` (이미 있던 ${reused}편은 폴더에만 넣음)` : '';
      toast(`논문 ${copied + reused}편을 ${target.label} ${place}에 복사했습니다${extra}.`, {
        kind: 'success', timeout: 8000, action: { label: '보기', onClick: () => this.#reveal(target.key, folderId ? `folder:${folderId}` : 'all') },
      });
    }
    if (failed.length) {
      const lines = failed.slice(0, 4).map((f) => `• ${shorten(f.title || f.id, 40)}: ${f.message}`);
      if (failed.length > 4) lines.push(`외 ${failed.length - 4}편`);
      toast(`복사하지 못한 논문이 있습니다.\n${lines.join('\n')}`, { kind: 'error', timeout: 10000 });
    }
  }

  /** A paper (or the selection), or a folder, dropped on another library: copy after one question. */
  async #dropCopy(drag, target, folderId) {
    const src = this.#source(drag.key);
    if (!src?.lib) return;
    const folder = folderId ? target.lib.getFolder(folderId) : null;
    const where = `${target.label}${folder ? `의 ‘${folder.name}’ 폴더` : ''}로 복사할까요?\nPDF와 번역만 복사되고 내 하이라이트·메모·AI 결과는 복사되지 않습니다.`;
    if (drag.kind === 'paper') {
      const byId = new Map(this.#papersOf(src).map((p) => [p.id, p]));
      const papers = (drag.ids || [drag.id]).map((id) => byId.get(id)).filter(Boolean);
      if (!papers.length) return;
      const what = papers.length > 1 ? `논문 ${papers.length}편을` : `‘${shorten(paperTitle(papers[0]))}’을(를)`;
      if (!(await confirmDialog(`${what} ${where}`, { okLabel: '복사', title: '다른 서재로 복사' }))) return;
      this.#runCopy(src, target, folderId, papers.length > 1 ? { papers } : { paper: papers[0] });
      return;
    }
    const item = src.lib.getFolder(drag.id);
    if (!item) return;
    if (!(await confirmDialog(`‘${item.name}’ 폴더를 ${where}`, { okLabel: '복사', title: '다른 서재로 복사' }))) return;
    this.#runCopy(src, target, folderId, { folder: item });
  }

  // --------------------------------------------------------- drag & drop

  /**
   * Accept drags on a node of library `src`: files (upload), papers / folders of the same library (move) and papers /
   * folders of another library (copy).
   * @param {HTMLElement} node
   * @param {object} src  the library the node belongs to
   * @param {string|null} folderId  target folder (null = top level)
   */
  #makeDropTarget(node, src, folderId, { acceptPapers = true, acceptFolders = true } = {}) {
    const accepts = (dt) => {
      const types = [...dt.types];
      if (!src.lib) return null;
      if (types.includes('Files')) return 'copy';
      const d = this.#drag;
      if (!d) return null;
      const same = d.key === src.key;
      if (d.kind === 'paper' && types.includes(PAPER_MIME)) {
        if (same) return acceptPapers ? 'move' : null;
        return this.#canCopy(d, src) ? 'copy' : null;
      }
      if (d.kind === 'folder' && types.includes(FOLDER_MIME)) {
        if (same) return acceptFolders && this.#canDropFolder(src.lib, d.id, folderId) ? 'move' : null;
        return this.#canCopy(d, src) ? 'copy' : null;
      }
      return null;
    };
    node.addEventListener('dragover', (e) => {
      const effect = accepts(e.dataTransfer);
      if (!effect) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = effect;
      node.classList.add('is-drop-target');
    });
    node.addEventListener('dragleave', (e) => {
      if (!node.contains(/** @type {Node} */ (e.relatedTarget))) node.classList.remove('is-drop-target');
    });
    node.addEventListener('drop', (e) => {
      const effect = accepts(e.dataTransfer);
      node.classList.remove('is-drop-target');
      if (!effect) return;
      e.preventDefault();
      e.stopPropagation();
      this.#hideDropOverlay();
      const dt = e.dataTransfer;
      if ([...dt.types].includes('Files')) { this.#upload([...dt.files], src, folderId); return; }
      const d = this.#drag;
      this.#drag = null;
      if (!d) return;
      if (d.key !== src.key) { this.#dropCopy(d, src, folderId); return; }
      if (d.kind === 'paper') {
        this.#movePapers(src, d.ids || [d.id], folderId);
        if ((d.ids?.length || 0) > 1) this.#clearSelection();
      } else {
        this.#moveFolder(src, d.id, folderId);
      }
    });
  }

  #canCopy(drag, target) {
    if (drag.key === target.key || !target.lib || target.placeholder) return false;
    const from = this.#source(drag.key)?.lib;
    return typeof from?.[drag.kind === 'paper' ? 'copyPaperTo' : 'copyFolderTo'] === 'function';
  }

  #canDropFolder(lib, dragId, targetId) {
    if (dragId === targetId) return false;
    const dragged = lib.getFolder(dragId);
    if (!dragged || (dragged.parentId ?? null) === targetId) return false;
    return !targetId || !this.#chain(lib, targetId).some((f) => f.id === dragId);
  }

  #bindFileDrop(main) {
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    main.addEventListener('dragenter', (e) => {
      if (!hasFiles(e) || !this.#current()?.lib || this.#page !== 'list') return;
      this.#dragDepth++;
      this.#els.dropOverlay.hidden = false;
    });
    main.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      this.#dragDepth = Math.max(0, this.#dragDepth - 1);
      if (!this.#dragDepth) this.#els.dropOverlay.hidden = true;
    });
    main.addEventListener('dragover', (e) => {
      if (!hasFiles(e) || !this.#current()?.lib || this.#page !== 'list') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    main.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.#hideDropOverlay();
      const src = this.#current();
      if (src?.lib && this.#page === 'list') this.#upload([...e.dataTransfer.files], src, this.#currentFolderId());
    });
  }

  #hideDropOverlay() {
    this.#dragDepth = 0;
    this.#els.dropOverlay.hidden = true;
  }

  // ---------------------------------------------------------------- upload

  /** bytes → loadPdf → quickMeta → library.addPaper, one file at a time, into `src` (내 서재 or 공용 서재). */
  async #upload(files, src, folderId) {
    if (!files.length || !src?.lib) return;
    const { loadPdf, quickMeta } = this.#deps;
    if (!loadPdf) {
      toast('PDF 모듈을 불러오지 못해 파일을 추가할 수 없습니다. 페이지를 새로 고친 뒤 다시 시도하세요.', { kind: 'error', timeout: 7000 });
      return;
    }
    if (this.#uploading) {
      toast('다른 파일을 추가하는 중입니다. 끝난 뒤 다시 시도하세요.', { kind: 'warning' });
      return;
    }
    const pdfs = files.filter(isPdfFile);
    const skipped = files.length - pdfs.length;
    if (skipped) toast(`PDF가 아닌 파일 ${skipped}개는 건너뜁니다.`, { kind: 'warning' });
    if (!pdfs.length) return;

    this.#uploading = true;
    this.#els.uploadBtn.disabled = true;
    const into = src.shared ? `${src.label}에 ` : '';
    const status = busyToast(`${into}PDF 추가 준비 중… (0/${pdfs.length})`);
    const added = [];
    const failed = [];
    try {
      for (const [i, file] of pdfs.entries()) {
        status.update(`${into}PDF 추가 중… (${i + 1}/${pdfs.length})\n${file.name}`);
        try {
          added.push(await this.#addOne(file, src.lib, folderId, loadPdf, quickMeta));
        } catch (err) {
          console.warn('[library-view] upload failed', file.name, err);
          failed.push({ name: file.name, message: err?.message || '알 수 없는 오류' });
        }
      }
    } finally {
      status.close();
      this.#uploading = false;
      this.#els.uploadBtn.disabled = !this.#current()?.lib;
    }
    const where = src.shared ? `${src.label}에 ` : '';
    if (added.length === 1) {
      const paper = added[0];
      this.#uploadToast = toast(`‘${shorten(paperTitle(paper), 60)}’을(를) ${where}추가했습니다.`, {
        kind: 'success', timeout: 6000,
        action: { label: '열기', onClick: () => this.#navigate(paperHref(src, paper.id)) },
      });
    } else if (added.length > 1) {
      toast(`논문 ${added.length}편을 ${where}추가했습니다.`, { kind: 'success' });
    }
    if (failed.length) {
      const lines = failed.slice(0, 4).map((f) => `• ${f.name}: ${f.message}`);
      if (failed.length > 4) lines.push(`외 ${failed.length - 4}개`);
      toast(`추가하지 못한 파일이 있습니다.\n${lines.join('\n')}`, { kind: 'error', timeout: 9000 });
    }
  }

  async #addOne(file, lib, folderId, loadPdf, quickMeta) {
    if (file.size > LIMITS.maxPdfBytes) {
      throw new Error(`파일이 너무 큽니다 (${formatBytes(file.size)}). 최대 ${formatBytes(LIMITS.maxPdfBytes)}까지 올릴 수 있습니다.`);
    }
    let bytes = new Uint8Array(await file.arrayBuffer());
    let pdf;
    try {
      pdf = await loadPdf(bytes);
    } catch (err) {
      console.warn('[library-view] loadPdf', err);
      throw new Error(err?.message && /[가-힣]/.test(err.message) ? err.message : 'PDF를 열 수 없습니다. 손상되었거나 암호가 걸린 파일일 수 있습니다.');
    }
    let meta = null;
    try {
      meta = quickMeta ? await quickMeta(pdf) : null;
    } catch (err) {
      console.warn('[library-view] quickMeta', err);
    } finally {
      try { await pdf?.destroy?.(); } catch { /* ignore */ }
    }
    // Guard against a detached buffer (pdf.js transfers what it is given).
    if (!bytes.byteLength) bytes = new Uint8Array(await file.arrayBuffer());
    const fallbackTitle = file.name.replace(/\.pdf$/i, '');
    meta = {
      title: meta?.title?.trim() || fallbackTitle,
      authors: meta?.authors || '',
      year: meta?.year ?? null,
      pages: meta?.pages ?? pdf?.numPages ?? 0,
    };
    return lib.addPaper(bytes, { fileName: file.name, folderId, meta });
  }

  // ------------------------------------------------------------------ sync

  /** Chip text for a library's sync status. */
  #syncInfo(src) {
    const st = src?.lib?.sync?.status || { state: src?.lib ? 'disabled' : 'syncing' };
    const what = src?.shared ? src.label : 'GitHub';
    const last = st.lastSyncAt ? `마지막 동기화: ${new Date(st.lastSyncAt).toLocaleString('ko-KR')}` : '';
    const pending = st.pending ? `대기 중인 변경 ${st.pending}개` : '';
    let cls = 'is-off';
    let glyph = () => icon('cloud-off', { size: 15 });
    let text = src?.shared ? '연결 안 됨' : 'GitHub 동기화: 꺼짐';
    let tip = src?.shared ? '공용 서재와 동기화하지 않고 있습니다' : '설정에서 GitHub 동기화를 켤 수 있습니다';
    switch (st.state) {
      case 'syncing': cls = 'is-busy'; glyph = () => spinner(13); text = '동기화 중…'; tip = pending || `${what}와 동기화하는 중`; break;
      case 'idle':
        cls = 'is-ok'; glyph = () => icon('cloud-check', { size: 15 });
        text = st.pending ? `동기화 대기 ${st.pending}` : '동기화 완료';
        tip = [last, pending, '클릭하면 지금 동기화합니다'].filter(Boolean).join('\n');
        break;
      case 'error': cls = 'is-error'; glyph = () => icon('alert-circle', { size: 15 }); text = '동기화 오류'; tip = st.message || '동기화 중 오류가 발생했습니다'; break;
      case 'offline': cls = 'is-off'; glyph = () => icon('cloud-off', { size: 15 }); text = '오프라인'; tip = [pending, '연결되면 자동으로 동기화합니다'].filter(Boolean).join('\n'); break;
      default: break;
    }
    return { cls, glyph, text, tip };
  }

  #renderSync() {
    const chip = this.#els.syncChip;
    const src = this.#current();
    const { cls, glyph, text, tip } = this.#syncInfo(src);
    chip.className = `chip lib-sync ${cls}`;
    chip.title = src?.shared ? `${src.label} · ${tip}` : tip;
    chip.setAttribute('aria-label', `${src?.shared ? `${src.label} ` : ''}${text}. ${tip}`);
    chip.replaceChildren(glyph(), el('span', {}, text));
    chip.hidden = !src?.lib && !this.#shared?.enabled;
    // the sidebar's per-library chips
    for (const node of this.#els.nav.querySelectorAll('.lib-sec-sync')) {
      const s = this.#source(node.dataset.lib);
      if (s?.lib) this.#paintMiniSync(node, s);
    }
  }

  #miniSync(src) {
    const node = el('button', { type: 'button', class: 'lib-sec-sync', 'data-lib': src.key, onclick: () => this.#onSyncClick(src) });
    this.#paintMiniSync(node, src);
    return node;
  }

  #paintMiniSync(node, src) {
    const { cls, glyph, text, tip } = this.#syncInfo(src);
    node.className = `lib-sec-sync ${cls}`;
    node.title = `${src.label} · ${text}\n${tip}`;
    node.setAttribute('aria-label', `${src.label} ${text}`);
    node.replaceChildren(glyph());
  }

  async #onSyncClick(src) {
    const sync = src?.lib?.sync;
    const st = sync?.status || { state: 'disabled' };
    const settingsHref = src?.shared ? '#/settings/shared' : '#/settings';
    if (!sync || st.state === 'disabled') { this.#navigate(settingsHref); return; }
    if (st.state === 'error') {
      toast(st.message || '동기화 중 오류가 발생했습니다.', { kind: 'error', timeout: 8000, action: { label: '설정', onClick: () => this.#navigate(settingsHref) } });
    }
    if (st.state === 'syncing') return;
    try { await sync.syncNow(); } catch (err) { this.#fail(err); }
  }

  // ----------------------------------------------------------------- misc

  #onKeyDown(e) {
    if (e.defaultPrevented) return;
    // Ctrl/Cmd+A while selecting with nothing focused (Safari does not focus a clicked checkbox): every row shown.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 'a'
      && this.#sel.size && this.#visibleIds.length && !hasOpenLayer()
      && (e.target === document.body || e.target === document.documentElement || this.#els.content.contains(/** @type {Node} */ (e.target)))
      && !isTypingTarget(e.target)) {
      e.preventDefault();
      this.#setSelected(this.#visibleIds, true);
      this.#paintSelection();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/' && !isTypingTarget(e.target) && this.#page === 'list') {
      e.preventDefault();
      this.#els.search.focus();
      this.#els.search.select();
    } else if (e.key === 'Escape' && this.#root.classList.contains('is-drawer-open')) {
      this.#toggleDrawer(false);
    } else if (e.key === 'Escape' && this.#sel.size) {
      e.preventDefault();
      this.#clearSelection();
    }
  }

  #currentFolderId() {
    const c = this.#stateOf(this.#key).collection;
    return c.startsWith('folder:') ? c.slice(7) : null;
  }

  #collectionExists(src, c) {
    if (SMART[c]) return true;
    return c.startsWith('folder:') && Boolean(src.lib.getFolder(c.slice(7)));
  }

  /** The folder followed by its ancestors, nearest first: [self, parent, grandparent, …]. */
  #chain(lib, folderId) {
    const out = [];
    const seen = new Set();
    let f = lib.getFolder(folderId);
    while (f && !seen.has(f.id)) {
      seen.add(f.id);
      out.push(f);
      f = f.parentId ? lib.getFolder(f.parentId) : null;
    }
    return out;
  }

  #fail(err) {
    console.warn('[library-view]', err);
    toast(err?.message || '작업을 완료하지 못했습니다.', { kind: 'error' });
  }
}

// ---------------------------------------------------------------- helpers

function hrefFor(key, page = 'list') {
  if (key === MINE) return page === 'trash' ? '#/trash' : '#/';
  const base = `#/s/${encodeURIComponent(key.slice(7))}`;
  return page === 'list' ? base : `${base}/${page}`;
}

function paperHref(src, id) {
  return src.shared ? `#/s/${encodeURIComponent(src.id)}/paper/${encodeURIComponent(id)}` : `#/paper/${encodeURIComponent(id)}`;
}

/**
 * Folder picker of a library (폴더로 이동, 다른 폴더 안으로 옮기기, 다른 서재로 복사): the top level first, then the full tree
 * with expand/collapse (everything open up to PICKER_SEARCH_AFTER folders, else the way to `chosen`), a search box
 * above that many folders, and '새 폴더', which makes a folder inline — inside the folder picked, or at the top level —
 * and picks it. Arrow keys move between folders (→ / ← open and close), Enter confirms (`onSubmit`).
 * @param {object} lib  a Library (folders, getFolder, createFolder)
 * @param {{ chosen?: string|null, current?: string|null, exclude?: Set<string>, rootLabel: string, rootIcon?: Node,
 *           onSubmit?: () => void, onError?: (err: Error) => void }} opts
 *   current: where the item is now (marked '지금 위치'); exclude: folders that cannot be picked (a folder and its subtree).
 * @returns {{ el: HTMLElement, readonly chosen: string|null }}
 */
function folderPicker(lib, { chosen = null, current, exclude = new Set(), rootLabel, rootIcon = null, onSubmit, onError } = {}) {
  const group = `folder-pick-${Math.random().toString(36).slice(2, 8)}`;
  const folders = () => lib.folders.filter((f) => !exclude.has(f.id));
  const byName = (a, b) => collator.compare(a.name, b.name);
  let picked = chosen != null && lib.getFolder(chosen) && !exclude.has(chosen) ? chosen : null;
  let query = '';
  let creating = false;
  let draft = '';
  const expanded = new Set();
  const ancestors = (id) => {
    const out = [];
    const seen = new Set();
    for (let f = id ? lib.getFolder(id) : null; f?.parentId && !seen.has(f.parentId); f = lib.getFolder(f.parentId)) {
      seen.add(f.parentId);
      out.push(f.parentId);
    }
    return out;
  };
  const many = folders().length > PICKER_SEARCH_AFTER;
  if (!many) for (const f of folders()) expanded.add(f.id);
  for (const id of ancestors(picked)) expanded.add(id);

  const root = el('div', { class: 'folder-pick' });
  const list = el('div', { class: 'folder-picker', role: 'radiogroup', 'aria-label': '폴더 선택' });
  let search = null;
  if (many) {
    search = el('input', {
      class: 'input', type: 'search', placeholder: '폴더 이름으로 찾기', 'aria-label': '폴더 검색', autocomplete: 'off', spellcheck: 'false',
      'data-autofocus': '',
    });
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
    root.append(el('label', { class: 'input-with-icon folder-pick-search' }, icon('search', { size: 16 }), search));
  }
  const newBtn = button('새 폴더', {
    icon: 'folder-plus', size: 'sm', kind: 'ghost', className: 'folder-pick-new-btn',
    title: '고른 폴더 안에(최상위를 고르면 맨 위에) 새 폴더를 만듭니다',
    onClick: () => { creating = true; draft = ''; if (picked) expanded.add(picked); render({ focus: 'new' }); },
  });
  root.append(list, el('div', { class: 'folder-pick-tools' }, newBtn));

  // Esc in the search box (with text) or the new-folder box cancels that, not the whole dialog: the dialog's
  // Esc handler listens on document (capture), so this one listens on window, which comes first.
  const onEscape = (e) => {
    if (!root.isConnected) { window.removeEventListener('keydown', onEscape, true); return; }
    if (e.key !== 'Escape' || e.isComposing) return;
    const t = document.activeElement;
    if (t && t === search && search.value) {
      e.stopPropagation();
      e.preventDefault();
      search.value = '';
      query = '';
      render({ focus: 'search' });
    } else if (t?.classList?.contains('folder-pick-name')) {
      e.stopPropagation();
      e.preventDefault();
      creating = false;
      render({ focus: 'picked' });
    }
  };
  window.addEventListener('keydown', onEscape, true);

  const radio = (id, labelNode, extra = []) => {
    const input = el('input', { type: 'radio', name: group, value: id ?? '' });
    input.checked = picked === id;
    if (picked === id && !search) input.dataset.autofocus = '';
    input.addEventListener('change', () => { if (input.checked) picked = id; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); picked = id; onSubmit?.(); return; }
      if (!id || query) return;
      const hasKids = folders().some((f) => f.parentId === id);
      if (e.key === 'ArrowRight' && hasKids && !expanded.has(id)) { e.preventDefault(); expanded.add(id); render({ focus: id }); }
      else if (e.key === 'ArrowLeft' && expanded.has(id)) { e.preventDefault(); expanded.delete(id); render({ focus: id }); }
    });
    return el('label', { class: `menu-item${id ? '' : ' is-root'}` }, input, ...extra, labelNode);
  };
  const here = (id) => (current !== undefined && (current ?? null) === id ? el('span', { class: 'folder-pick-here' }, '지금 위치') : null);
  const nameNode = (name) => {
    const span = el('span', { class: 'menu-label', title: name });
    const i = query ? name.toLowerCase().indexOf(query) : -1;
    if (i < 0) span.textContent = name;
    else span.append(name.slice(0, i), el('mark', {}, name.slice(i, i + query.length)), name.slice(i + query.length));
    return span;
  };
  const newRow = (depth) => {
    const parent = picked ? lib.getFolder(picked) : null;
    const input = el('input', {
      class: 'input folder-pick-name', type: 'text', value: draft, autocomplete: 'off', spellcheck: 'false',
      placeholder: parent ? '하위 폴더 이름' : '새 폴더 이름', // the row sits under the folder it goes into
      'aria-label': parent ? `‘${parent.name}’ 안에 만들 폴더 이름` : '새 폴더 이름',
    });
    input.addEventListener('input', () => { draft = input.value; });
    const make = () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      try {
        const f = lib.createFolder(name, picked);
        creating = false;
        draft = '';
        if (picked) expanded.add(picked);
        if (f?.id) { picked = f.id; expanded.add(f.id); }
        if (query && !name.toLowerCase().includes(query)) { query = ''; if (search) search.value = ''; }
        render({ focus: 'picked' });
      } catch (err) {
        if (onError) onError(err);
        else toast(err?.message || '폴더를 만들지 못했습니다.', { kind: 'error' });
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); make(); }
    });
    const row = el('div', { class: 'folder-pick-new' },
      icon('folder-plus', { size: 16 }), input,
      button('만들기', { size: 'sm', kind: 'primary', className: 'folder-pick-make', onClick: make }),
      iconButton('x', '취소', () => { creating = false; render({ focus: 'picked' }); }, { size: 'sm' }));
    row.style.setProperty('--depth', String(Math.min(depth, MAX_INDENT)));
    return row;
  };

  const render = ({ focus = null } = {}) => {
    const all = folders();
    const kids = new Map();
    for (const f of all) {
      const key = f.parentId && all.some((x) => x.id === f.parentId) ? f.parentId : null;
      if (!kids.has(key)) kids.set(key, []);
      kids.get(key).push(f);
    }
    for (const v of kids.values()) v.sort(byName);
    // With a search: the matches and their ancestors (context), all open.
    let shown = null;
    if (query) {
      shown = new Set();
      for (const f of all) {
        if (!f.name.toLowerCase().includes(query)) continue;
        shown.add(f.id);
        for (const a of ancestors(f.id)) shown.add(a);
      }
    }
    const rows = [radio(null, el('span', { class: 'menu-label' }, rootLabel), [rootIcon || icon('library', { size: 16 })])];
    const here0 = here(null);
    if (here0) rows[0].append(here0);
    if (creating && !picked) rows.push(newRow(0));
    const walk = (parentId, depth) => {
      for (const f of kids.get(parentId) || []) {
        if (shown && !shown.has(f.id)) continue;
        const hasKids = (kids.get(f.id) || []).length > 0;
        const open = Boolean(query) || expanded.has(f.id) || (creating && picked === f.id);
        const toggle = hasKids && !query
          ? el('button', {
            type: 'button', class: 'folder-pick-toggle', tabindex: '-1', 'aria-expanded': String(open),
            'aria-label': open ? `${f.name} 접기` : `${f.name} 펼치기`,
            onclick: () => { if (open) expanded.delete(f.id); else expanded.add(f.id); render({ focus: f.id }); },
          }, icon('chevron-right', { size: 14 }))
          : el('span', { class: 'folder-pick-spacer', 'aria-hidden': 'true' });
        const label = radio(f.id, nameNode(f.name), [icon(open && hasKids ? 'folder-open' : 'folder', { size: 16 })]);
        const mark = here(f.id);
        if (mark) label.append(mark);
        const row = el('div', { class: `folder-pick-row${shown && !f.name.toLowerCase().includes(query) ? ' is-context' : ''}`, 'data-folder': f.id }, toggle, label);
        row.style.setProperty('--depth', String(Math.min(depth, MAX_INDENT)));
        rows.push(row);
        if (creating && picked === f.id) rows.push(newRow(depth + 1));
        if (open) walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    if (query && !shown.size) rows.push(el('p', { class: 'folder-pick-empty' }, `‘${query}’ 폴더가 없습니다.`));
    list.replaceChildren(...rows);
    newBtn.disabled = creating;
    if (focus === 'new') list.querySelector('.folder-pick-name')?.focus();
    else if (focus === 'search') search?.focus();
    else if (focus) {
      const target = focus === 'picked' ? list.querySelector('input[type="radio"]:checked') : list.querySelector(`[data-folder="${CSS.escape(focus)}"] input[type="radio"]`);
      target?.focus({ preventScroll: true });
      target?.closest('.menu-item')?.scrollIntoView?.({ block: 'nearest' });
    }
  };
  render();
  // Once in the dialog: the picked folder in view.
  requestAnimationFrame(() => list.querySelector('input[type="radio"]:checked')?.closest('.menu-item')?.scrollIntoView?.({ block: 'nearest' }));
  return { el: root, get chosen() { return picked; } };
}

/** A small "논문 3편" card under the pointer while several papers are dragged. */
function setDragBadge(dataTransfer, text) {
  if (typeof dataTransfer?.setDragImage !== 'function') return;
  const badge = el('div', { class: 'drag-badge' }, icon('file-text', { size: 16 }), text);
  document.body.append(badge);
  dataTransfer.setDragImage(badge, 18, 18);
  setTimeout(() => badge.remove(), 0);
}

/** Touch-first device (checkboxes always shown, rows and folders not draggable). */
function isCoarse() {
  try { return window.matchMedia(COARSE).matches; } catch { return false; }
}

/** '으로' or '로' after `word` (Korean: 로 after a vowel or ㄹ); '(으)로' when it cannot tell. */
function ro(word) {
  const s = String(word || '').trim();
  const c = s.charCodeAt(s.length - 1);
  if (c >= 0xac00 && c <= 0xd7a3) {
    const final = (c - 0xac00) % 28;
    return final === 0 || final === 8 ? '로' : '으로';
  }
  const digit = /([0-9])$/.exec(s)?.[1];
  if (digit) return '0136'.includes(digit) ? '으로' : '로';
  // An abbreviation (NAVA, CAM-ICU, ICU 2) is read letter by letter: 엠·엔 end in a consonant, 엘·알 in ㄹ.
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters && letters === letters.toUpperCase() && /[A-Z]$/.test(s)) return /[MN]$/.test(s) ? '으로' : '로';
  return '(으)로';
}

/** Who sees a copy in `target`, and what is not copied (the copy dialog's note). */
function copyNote(target) {
  const notCopied = '내 하이라이트·메모·AI 결과는 복사되지 않습니다.';
  if (target.kind === 'mine') return `PDF와 번역이 내 서재에 복사됩니다. ${notCopied}`;
  if (target.kind === 'code') return `PDF와 번역이 복사되어 이 초대 코드를 가진 사람만 봅니다. ${notCopied}`;
  return `PDF와 번역이 복사되어 ${target.label}의 모든 사람이 함께 봅니다. ${notCopied}`;
}

/** Papers in a folder and its sub-folders. */
function folderPaperCount(lib, folderId) {
  return folderCounts(lib.papers, lib.folders).get(folderId) || 0;
}

/** Paper count per folder, including papers in its sub-folders. */
function folderCounts(papers, folders) {
  const direct = new Map();
  for (const p of papers) if (p.folderId) direct.set(p.folderId, (direct.get(p.folderId) || 0) + 1);
  const children = new Map();
  for (const f of folders) {
    const key = f.parentId ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(f.id);
  }
  const total = new Map();
  const visit = (id, seen) => {
    if (total.has(id)) return total.get(id);
    if (seen.has(id)) return 0; // defensive: a cycle in synced data
    seen.add(id);
    let n = direct.get(id) || 0;
    for (const child of children.get(id) || []) n += visit(child, seen);
    total.set(id, n);
    return n;
  };
  for (const f of folders) visit(f.id, new Set());
  return total;
}

/**
 * Library.trash() (frozen records with kind, name, deletedAt, deletedBy, expired; or { folders, papers }) → rows:
 * { kind, id, name, deletedAt, deletedBy, expired, restorable, reason, authors }, newest first.
 */
function normalizeTrash(raw) {
  const out = [];
  const push = (kind, x) => {
    if (!x || typeof x.id !== 'string') return;
    const paper = kind === 'paper';
    out.push({
      kind,
      id: x.id,
      name: paper ? paperTitle(x) : (x.name || '이름 없는 폴더'),
      authors: paper && typeof x.authors === 'string' ? x.authors : '',
      deletedAt: toMillis(x.deletedAt ?? x.updatedAt),
      deletedBy: typeof x.deletedBy === 'string' ? x.deletedBy : '',
      expired: typeof x.expired === 'boolean' ? x.expired : null,
      restorable: x.restorable !== false,
      reason: typeof x.reason === 'string' ? x.reason : (x.restorable === false ? '파일이 지워져 복구할 수 없습니다.' : ''),
    });
  };
  if (Array.isArray(raw)) {
    for (const x of raw) push(x?.kind === 'folder' || x?.type === 'folder' || (!x?.kind && !x?.type && !('title' in (x || {})) && !('fileName' in (x || {}))) ? 'folder' : 'paper', x);
  } else if (raw && typeof raw === 'object') {
    for (const f of Array.isArray(raw.folders) ? raw.folders : []) push('folder', f);
    for (const p of Array.isArray(raw.papers) ? raw.papers : []) push('paper', p);
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

function isExpired(item, now) {
  if (item.expired != null) return item.expired;
  return Boolean(item.deletedAt) && now - item.deletedAt > TRASH_DAYS * DAY_MS;
}

/**
 * What copyPaperTo ({ paper, copied, existing, … }) or copyFolderTo ({ folder, papers: { copied, existing, failed } })
 * answered → { folderId, copied, reused, failed }. `reused`: the PDF was in the target already (placed, not uploaded).
 */
function copyOutcome(res, { paper }) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  if (!res || typeof res !== 'object') return { folderId: null, copied: null, reused: 0, failed: [] };
  if (paper) return { folderId: res.paper?.folderId ?? null, copied: res.copied ? 1 : 0, reused: res.existing ? 1 : 0, failed: [] };
  const p = res.papers && typeof res.papers === 'object' ? res.papers : {};
  return {
    folderId: res.folder?.id ?? null,
    copied: n(p.copied),
    reused: n(p.existing),
    failed: Array.isArray(p.failed) ? p.failed : [],
  };
}

/**
 * A commit summary from 최근 활동, with repository paths turned into paper titles:
 * "papers/p_x/translation.json" → "‘Delirium …’ 번역".
 */
function describeChange(summary, titleOf) {
  const LABELS = { 'paper.pdf': 'PDF', 'translation.json': '번역', 'annotations.json': '메모', 'ai.json': 'AI 결과' };
  return String(summary || '')
    .replace(/(?:people\/[0-9a-f]{16}\/)?papers\/([A-Za-z0-9_-]{1,64})\/(paper\.pdf|translation\.json|annotations\.json|ai\.json)/g,
      (_, id, file) => { const t = titleOf(id); return `${t ? `‘${shorten(t, 40)}’` : '논문'} ${LABELS[file]}`; })
    .replace(/\blibrary\.json\b/g, '서재 목록')
    // The data repository's commits still carry the app's old name (js/store keeps its commit texts):
    // '논문 리더 데이터 저장소 시작' and '논문 리더 동기화: …' are shown under the new name.
    .replace(/^논문 리더(?= (?:데이터 저장소 시작|동기화))/, '갈피');
}

function toMillis(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; }
  return 0;
}

const TIME_FMT = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

function timeText(ts) {
  return TIME_FMT.format(new Date(ts));
}

/** '오늘' · '어제' · '10월 3일 (금)' · '2025년 10월 3일'. */
function dayLabel(ts, now = Date.now()) {
  if (!ts) return '날짜 모름';
  const d = new Date(ts);
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date(now)) - start(d)) / DAY_MS);
  if (diff === 0) return '오늘';
  if (diff === 1) return '어제';
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('ko-KR', sameYear ? { month: 'long', day: 'numeric', weekday: 'short' } : { year: 'numeric', month: 'long', day: 'numeric' });
}

/** '오늘 14:02' · '어제 09:10' · '10월 3일 (금) 14:02'. */
function whenText(ts, now = Date.now()) {
  return `${dayLabel(ts, now)} ${timeText(ts)}`;
}

function shorten(text, max = 50) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function emptyState(iconName, title, text) {
  return el('div', { class: 'empty-state' }, el('div', {},
    el('div', { class: 'icon-wrap' }, icon(iconName, { size: 24 })),
    el('h2', {}, title), text ? el('p', {}, text) : null));
}

function note(iconName, text) {
  return el('div', { class: 'note' }, icon(iconName, { size: 16 }), el('div', {}, text));
}

/** A sticky toast with a spinner, for work that takes a while. */
function busyToast(text) {
  const t = toast(text, { timeout: 0 });
  t.el.querySelector('.toast-icon')?.replaceChildren(spinner(16));
  return t;
}

function paperTitle(p) {
  return p.title || p.fileName || '제목 없음';
}

function isPdfFile(file) {
  return file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
}

function isTypingTarget(t) {
  const n = /** @type {HTMLElement} */ (t);
  return Boolean(n && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)));
}
