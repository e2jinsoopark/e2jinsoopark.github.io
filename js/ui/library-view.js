// Library view (#/ 내 서재 · #/s/<lib> 공용 서재): each library's folder tree, counts and sync chip in the sidebar,
// paper list with search/sort, PDF upload, drag-drop, 휴지통 and (공용 서재) 최근 활동 — docs/SHARED.md §3.2.
// Without an invite code the sidebar shows 내 서재 alone, exactly as before.
import { LIMITS } from '../core/config.js';
import { settings } from '../core/settings.js';
import { debounce, el, formatBytes, formatDate } from '../core/util.js';
import {
  brandImage, button, confirmDialog, contextMenu, iconButton, modal, progressBar, promptDialog, spinner, toast, uiState,
} from './components.js';
import { icon } from './icons.js';

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
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

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

  constructor(container, deps, navigate, route) {
    this.#deps = deps;
    this.#shared = deps.shared || null;
    this.#navigate = navigate;
    this.#collapsed = { ...(uiState.get('librarySections', {}) || {}) };
    this.#root = this.#build();
    container.replaceChildren(this.#root);
    this.#listen(document, 'keydown', (e) => this.#onKeyDown(e));
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
    this.#key = key;
    this.#page = page;
    this.#autoHome = Boolean(route.home) && key === MINE;
    if (route.lib) uiState.set('libraryHome', key);
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

    const sidebar = el('aside', { class: 'lib-sidebar', 'aria-label': '라이브러리 탐색' },
      el('div', { class: 'lib-brand', title: '갈피 — 논문을 나란히 읽다' },
        brandImage('mark', { size: 34, className: 'lib-brand-mark' }),
        el('div', { class: 'lib-brand-text' },
          el('div', { class: 'lib-brand-name' }, '갈피'),
          el('div', { class: 'lib-brand-sub', lang: 'en', 'aria-hidden': 'true' }, 'GALPI'))),
      els.nav,
      el('div', { class: 'lib-sidebar-footer' },
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
    els.searchWrap = el('label', { class: 'input-with-icon' }, icon('search', { size: 16 }), els.search);

    const header = el('header', { class: 'lib-header' },
      iconButton('menu', '폴더 목록 열기', () => this.#toggleDrawer(true), { className: 'lib-menu-btn' }),
      el('div', { class: 'lib-title-wrap' }, els.crumbs, els.title),
      el('div', { class: 'lib-actions' }, els.searchWrap, els.sort, els.syncChip, els.uploadBtn, els.fileInput));

    els.content = el('div', { class: 'lib-content' });
    els.dropText = el('span', {}, 'PDF를 놓으면 이 목록에 추가됩니다');
    els.dropOverlay = el('div', { class: 'drop-overlay', hidden: true }, el('div', {}, icon('upload', { size: 30 }), els.dropText));
    const main = el('main', { class: 'lib-main' }, header, els.content, els.dropOverlay);
    this.#bindFileDrop(main);

    return el('div', { class: 'library' }, sidebar, el('div', { class: 'sidebar-scrim', onclick: () => this.#toggleDrawer(false) }), main);
  }

  #listen(target, type, fn) {
    target.addEventListener(type, fn);
    this.#cleanup.push(() => target.removeEventListener(type, fn));
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
    }
    this.#renderNav();
    this.#renderMain();
    this.#renderSync();
  }

  // ------------------------------------------------------------ libraries

  /**
   * The libraries in the sidebar: 내 서재, then each team library (or one placeholder while the list is loading
   * or could not be read).
   */
  #sources() {
    const out = [{ key: MINE, id: null, shared: false, label: MINE_LABEL, lib: this.#deps.library, status: 'ready', error: '' }];
    const sh = this.#shared;
    if (!sh?.enabled) return out;
    const list = sh.state === 'ready' ? sh.libraries : [];
    if (list.length) {
      for (const e of list) {
        out.push({ key: `shared:${e.id}`, id: e.id, shared: true, label: e.name || SHARED_LABEL, lib: e.library, status: e.status, error: e.error });
      }
    } else {
      out.push({
        key: 'shared:', id: null, shared: true, label: SHARED_LABEL, lib: null, placeholder: true,
        status: sh.state === 'error' ? 'error' : 'loading', error: sh.message,
      });
    }
    return out;
  }

  #source(key) { return this.#sources().find((s) => s.key === key) || null; }
  #current() { return this.#source(this.#key); }
  #multi() { return this.#sources().length > 1; }

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
    if (sources.length === 1) {
      this.#els.nav.replaceChildren(...this.#libraryNav(sources[0]));
      return;
    }
    this.#els.nav.replaceChildren(...sources.map((s) => this.#sectionNav(s)));
  }

  /** One library's section: header (name + sync chip, folds), then its lists. */
  #sectionNav(src) {
    const current = src.placeholder ? this.#key.startsWith('shared:') : this.#key === src.key;
    const collapsed = this.#isCollapsed(src);
    const toggle = el('button', {
      type: 'button', class: 'lib-sec-toggle', 'aria-expanded': String(!collapsed),
      title: collapsed ? `${src.label} 펼치기` : `${src.label} 접기`,
      onclick: () => this.#toggleSection(src, !collapsed),
    },
    icon('chevron-right', { size: 14, className: 'lib-sec-chevron' }),
    src.shared ? sharedIcon(16) : icon('library', { size: 16 }),
    el('span', { class: 'lib-sec-label', title: src.label }, src.label));
    const head = el('div', { class: 'lib-sec-head' }, toggle, src.lib ? this.#miniSync(src) : null);
    if (src.lib) this.#makeDropTarget(head, src, null, { acceptPapers: false, acceptFolders: false });
    const body = collapsed ? null : el('div', { class: 'lib-sec-body' }, this.#sectionBody(src));
    return el('section', {
      class: `lib-sec${current ? ' is-current' : ''}${src.shared ? ' is-shared' : ''}`,
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
      iconButton('folder-plus', this.#multi() ? `${src.label}에 새 폴더` : '새 폴더', () => this.#createFolder(src, null), { size: 'sm' }));
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
    for (const folder of children) {
      const hasChildren = folders.some((f) => f.parentId === folder.id);
      const expanded = hasChildren && st.expanded.has(folder.id);
      const current = this.#key === src.key && this.#page === 'list' && st.collection === `folder:${folder.id}`;
      const item = el('button', {
        type: 'button', class: 'tree-item is-folder', draggable: 'true', 'data-folder': folder.id,
        'aria-current': String(current),
        onclick: () => this.#select(src.key, `folder:${folder.id}`),
      },
      icon(expanded ? 'folder-open' : 'folder', { size: 17 }),
      el('span', { class: 'tree-label', title: folder.name }, folder.name),
      el('span', { class: 'tree-count', title: '하위 폴더 포함 논문 수' }, String(counts.get(folder.id) || 0)));
      item.style.setProperty('--depth', String(depth));
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

      const row = el('div', { class: 'tree-row' }, item);
      row.style.setProperty('--depth', String(depth));
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
  }

  /** Switch library or page through the router (the address shows where one is). */
  #go(key, page = 'list') {
    this.#autoHome = false;
    this.#toggleDrawer(false);
    if (key === MINE) uiState.set('libraryHome', MINE); // an invitee chose 내 서재: #/ stays there from now on
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
    els.dropText.textContent = src?.shared ? `PDF를 놓으면 ${src.label}의 이 목록에 추가됩니다` : 'PDF를 놓으면 이 목록에 추가됩니다';
    if (!src?.lib) { this.#renderUnavailable(src); return; }
    if (this.#page === 'trash') { this.#renderTrash(src, token); return; }
    if (this.#page === 'activity') { this.#renderActivity(src, token); return; }
    this.#renderList(src);
  }

  #setHeader(src, title, crumbs = null) {
    const els = this.#els;
    els.crumbs.replaceChildren(...(crumbs || [el('span', {}, this.#multi() ? src?.label || SHARED_LABEL : '라이브러리')]));
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
      crumbs = [crumb(this.#multi() ? src.label : '전체', 'all')];
      for (const f of chain) crumbs.push(icon('chevron-right', { size: 12 }), crumb(f.name, `folder:${f.id}`));
    }
    this.#setHeader(src, folder ? folder.name : SMART[collection]?.label || '전체', crumbs);
    els.sort.value = collection === 'recent' ? 'opened' : st.sort;
    els.sort.disabled = collection === 'recent';

    // content
    const content = els.content;
    content.replaceChildren();
    if (!allPapers.length && collection === 'all' && !this.#query) {
      content.append(src.shared ? this.#sharedEmpty(src) : this.#onboarding());
      return;
    }
    if (folder) {
      const subs = src.lib.folders.filter((f) => f.parentId === folder.id).sort((a, b) => collator.compare(a.name, b.name));
      if (subs.length) content.append(el('div', { class: 'lib-subfolders' }, subs.map((f) => this.#subfolderChip(src, f))));
    }
    const papers = this.#visiblePapers(allPapers, st);
    if (!papers.length) {
      content.append(this.#emptyCollection(collection, folder));
      return;
    }
    const total = this.#query ? `검색 결과 ${papers.length}편` : `논문 ${papers.length}편`;
    content.append(el('p', { class: 'lib-count-line' }, total));
    const folderNames = new Map(src.lib.folders.map((f) => [f.id, f.name]));
    content.append(el('div', { class: 'paper-list', role: 'list' }, papers.map((p) => this.#paperRow(src, p, folderNames, !folder))));
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

    const row = el('article', { class: 'paper-row', draggable: 'true', 'data-id': paper.id, role: 'listitem' },
      el('div', { class: 'paper-thumb', 'aria-hidden': 'true' }, icon('file-text', { size: 20 })),
      el('div', { class: 'paper-main' },
        el('a', { class: 'paper-link', href, draggable: 'false' }, el('h2', { class: 'paper-title' }, title)),
        metaLine),
      el('div', { class: 'paper-side' }, this.#progressCell(paper), star, more));

    row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.#paperMenu(src, paper, e.clientX, e.clientY); });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const r = row.getBoundingClientRect();
        this.#paperMenu(src, paper, r.left + 60, r.top + 40);
      }
    });
    row.addEventListener('dragstart', (e) => {
      this.#drag = { kind: 'paper', key: src.key, id: paper.id };
      e.dataTransfer.setData(PAPER_MIME, paper.id);
      e.dataTransfer.setData('text/plain', title);
      e.dataTransfer.effectAllowed = 'copyMove';
      row.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => { this.#drag = null; row.classList.remove('is-dragging'); });
    return row;
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
    chip.addEventListener('contextmenu', (e) => { e.preventDefault(); this.#folderMenu(src, folder, e.clientX, e.clientY); });
    this.#makeDropTarget(chip, src, folder.id, { acceptFolders: false });
    return chip;
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

  /** An empty team library: what is shared with whom, and where to start. */
  #sharedEmpty(src) {
    const mine = this.#deps.library;
    const canCopy = Boolean(mine?.papers?.length && typeof mine.copyPaperTo === 'function');
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
        canCopy ? el('li', {}, icon('copy', { size: 16 }), el('span', {}, el('b', {}, '내 서재에서 가져오기'), ' — 내 서재의 논문·폴더 메뉴(⋯)에서 ‘공용 서재로 복사…’를 고르세요.')) : null));
  }

  /** The route names a team library that is not open (yet). */
  #renderUnavailable(src) {
    const els = this.#els;
    const sh = this.#shared;
    const content = els.content;
    const toMine = button(`${MINE_LABEL}로`, { icon: 'arrow-left', onClick: () => this.#go(MINE) });
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
    const actions = [toMine];
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
      el('div', { class: 'icon-wrap' }, sharedIcon(24)), el('h2', {}, title), el('p', {}, text),
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

  /** The owner (admin token saved) can remove the files of papers deleted more than 30 days ago. */
  #trashAdmin(src, old) {
    const relay = this.#deps.relay;
    if (!src.shared || !settings.get().relay?.adminToken || typeof relay?.purgeShared !== 'function') return null;
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
      { label: '폴더로 이동…', icon: 'folder-input', onClick: () => this.#pickFolder(src, paper) },
      { label: '제목 바꾸기', icon: 'pencil', onClick: () => this.#renamePaper(src, paper) },
    ];
    const copy = this.#copyItem(src, 'paper', () => this.#copyDialog(src, { paper }));
    if (copy) items.push(copy);
    items.push('sep', { label: '삭제', icon: 'trash', danger: true, onClick: () => this.#deletePaper(src, paper) });
    contextMenu(items, x, y);
  }

  #folderMenu(src, folder, x, y) {
    const items = [
      { label: '새 하위 폴더', icon: 'folder-plus', onClick: () => this.#createFolder(src, folder.id) },
      { label: '이름 바꾸기', icon: 'pencil', onClick: () => this.#renameFolder(src, folder) },
      { label: '최상위로 옮기기', icon: 'folder-input', disabled: !folder.parentId, onClick: () => this.#moveFolder(src, folder.id, null) },
    ];
    const copy = this.#copyItem(src, 'folder', () => this.#copyDialog(src, { folder }));
    if (copy) items.push(copy);
    items.push('sep', { label: '삭제', icon: 'trash', danger: true, onClick: () => this.#deleteFolder(src, folder) });
    contextMenu(items, x, y);
  }

  /** '공용 서재로 복사…' for 내 서재 items (disabled while 공용 서재 is still connecting). */
  #copyItem(src, kind, onClick) {
    if (src.key !== MINE || !this.#shared?.enabled) return null;
    const method = kind === 'paper' ? 'copyPaperTo' : 'copyFolderTo';
    if (typeof src.lib[method] !== 'function') return null;
    const ready = this.#copyTargets().length > 0;
    return { label: '공용 서재로 복사…', icon: 'copy', disabled: !ready, onClick };
  }

  /** Team libraries that are open (copy targets). */
  #copyTargets() {
    return this.#sources().filter((s) => s.shared && s.lib);
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
    const where = this.#multi() && !parent ? `${src.label}에 만들 ` : '';
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

  #moveFolder(src, id, parentId) {
    if (parentId && this.#chain(src.lib, parentId).some((f) => f.id === id)) {
      toast('폴더를 자기 자신이나 하위 폴더 안으로 옮길 수 없습니다.', { kind: 'warning' });
      return;
    }
    try {
      src.lib.moveFolder(id, parentId);
      if (parentId) { this.#stateOf(src.key).expanded.add(parentId); this.#persist(src.key); }
    } catch (err) { this.#fail(err); }
  }

  #movePaper(src, paperId, folderId) {
    const paper = src.lib.getPaper(paperId);
    if (!paper || (paper.folderId ?? null) === folderId) return;
    try {
      src.lib.movePaper(paperId, folderId);
      const target = folderId ? src.lib.getFolder(folderId)?.name : null;
      toast(target ? `‘${paperTitle(paper)}’을(를) ‘${target}’ 폴더로 옮겼습니다.` : `‘${paperTitle(paper)}’을(를) 폴더에서 뺐습니다.`, { kind: 'success' });
    } catch (err) { this.#fail(err); }
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

  #pickFolder(src, paper) {
    let chosen = paper.folderId ?? null;
    const list = folderRadios(src.lib, chosen, '폴더 없음 (최상위)', (id) => { chosen = id; });
    modal({
      title: '폴더로 이동',
      size: 'sm',
      body: el('div', {}, el('p', { class: 'field-hint', style: { marginTop: '0' } }, paperTitle(paper)), list),
      actions: [
        { label: '취소' },
        { label: '이동', kind: 'primary', onClick: () => this.#movePaper(src, paper.id, chosen) },
      ],
    });
  }

  /** Show `collection` of library `key` (e.g. the folder something was copied or restored into). */
  #reveal(key, collection) {
    const st = this.#stateOf(key);
    st.collection = collection;
    const src = this.#source(key);
    if (src?.lib && collection.startsWith('folder:')) for (const f of this.#chain(src.lib, collection.slice(7)).slice(1)) st.expanded.add(f.id);
    this.#persist(key);
    if (key === this.#key && this.#page === 'list') this.#renderAll();
    else this.#go(key, 'list');
  }

  // ------------------------------------------------------ 공용 서재로 복사

  /**
   * Pick where in 공용 서재 a paper or folder of 내 서재 goes. Only the PDF and the translation are copied (never the
   * owner's highlights, notes or AI results).
   */
  #copyDialog(src, { paper = null, folder = null }) {
    const targets = this.#copyTargets();
    if (!targets.length) { toast('공용 서재가 아직 열리지 않았습니다. 잠시 후 다시 시도해 주세요.', { kind: 'warning' }); return; }
    let target = targets[0];
    let chosen = null;
    const pickerHost = el('div', { class: 'copy-picker' });
    const renderPicker = () => {
      pickerHost.replaceChildren(folderRadios(target.lib, chosen, `${target.label} (최상위)`, (id) => { chosen = id; }, { rootIcon: sharedIcon(16) }));
    };
    const libChoice = targets.length > 1 ? el('div', { class: 'segmented copy-libs', role: 'group', 'aria-label': '복사할 공용 서재' }) : null;
    if (libChoice) {
      const draw = () => libChoice.replaceChildren(...targets.map((t) => button(t.label, {
        size: 'sm', pressed: t === target, onClick: () => { target = t; chosen = null; draw(); renderPicker(); },
      })));
      draw();
    }
    renderPicker();
    const newFolder = button('새 폴더', {
      icon: 'folder-plus', size: 'sm', kind: 'ghost',
      onClick: async () => {
        const parent = chosen ? target.lib.getFolder(chosen) : null;
        const name = await promptDialog(parent ? `‘${parent.name}’ 안에 만들 폴더 이름` : `${target.label}에 만들 폴더 이름`, { placeholder: '예: 섬망 연구', okLabel: '만들기', title: '새 폴더' });
        if (name == null || !name.trim()) return;
        try {
          const f = target.lib.createFolder(name.trim(), chosen);
          if (f?.id) chosen = f.id;
          renderPicker();
        } catch (err) { this.#fail(err); }
      },
    });
    const count = folder ? folderPaperCount(src.lib, folder.id) : 0;
    const what = paper ? `‘${shorten(paperTitle(paper))}’` : `‘${folder.name}’ 폴더(하위 폴더 포함 논문 ${count}편)`;
    modal({
      title: '공용 서재로 복사',
      size: 'sm',
      className: 'copy-dialog',
      body: el('div', {},
        el('p', { class: 'modal-message' }, `${what}을(를) 복사할 위치를 고르세요.`),
        libChoice,
        pickerHost,
        el('div', { class: 'copy-tools' }, newFolder),
        note('info', 'PDF와 번역이 복사되어 공용 서재의 모든 사람이 함께 봅니다. 내 하이라이트·메모·AI 결과는 복사되지 않고 내 서재에 그대로 남습니다.')),
      actions: [
        { label: '취소' },
        { label: '복사', kind: 'primary', onClick: () => { this.#runCopy(src, target, chosen, { paper, folder }); } },
      ],
    });
  }

  async #runCopy(src, target, folderId, { paper = null, folder = null }) {
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
    toast(message, { kind: 'success', timeout: 8000, action: { label: '공용 서재에서 보기', onClick: () => this.#reveal(target.key, reveal) } });
    if (out.failed.length) {
      const lines = out.failed.slice(0, 4).map((f) => `• ${shorten(f.title || f.id, 40)}: ${f.message}`);
      if (out.failed.length > 4) lines.push(`외 ${out.failed.length - 4}편`);
      toast(`복사하지 못한 논문이 있습니다.\n${lines.join('\n')}`, { kind: 'error', timeout: 10000 });
    }
  }

  /** A 내 서재 item dropped on 공용 서재: copy after one question. */
  async #dropCopy(drag, target, folderId) {
    const src = this.#source(drag.key);
    if (!src?.lib) return;
    const item = drag.kind === 'paper' ? src.lib.getPaper(drag.id) : src.lib.getFolder(drag.id);
    if (!item) return;
    const folder = folderId ? target.lib.getFolder(folderId) : null;
    const what = drag.kind === 'paper' ? `‘${shorten(paperTitle(item))}’을(를)` : `‘${item.name}’ 폴더를`;
    const ok = await confirmDialog(`${what} ${target.label}${folder ? `의 ‘${folder.name}’ 폴더` : ''}로 복사할까요?\nPDF와 번역만 복사되고 내 하이라이트·메모·AI 결과는 복사되지 않습니다.`,
      { okLabel: '복사', title: '공용 서재로 복사' });
    if (!ok) return;
    this.#runCopy(src, target, folderId, drag.kind === 'paper' ? { paper: item } : { folder: item });
  }

  // --------------------------------------------------------- drag & drop

  /**
   * Accept drags on a node of library `src`: files (upload), papers / folders of the same library (move) and papers /
   * folders of 내 서재 onto 공용 서재 (copy).
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
      if (d.kind === 'paper') this.#movePaper(src, d.id, folderId);
      else this.#moveFolder(src, d.id, folderId);
    });
  }

  #canCopy(drag, target) {
    if (drag.key !== MINE || !target.shared || !target.lib) return false;
    const mine = this.#deps.library;
    return typeof mine?.[drag.kind === 'paper' ? 'copyPaperTo' : 'copyFolderTo'] === 'function';
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
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/' && !isTypingTarget(e.target) && this.#page === 'list') {
      e.preventDefault();
      this.#els.search.focus();
      this.#els.search.select();
    } else if (e.key === 'Escape' && this.#root.classList.contains('is-drawer-open')) {
      this.#toggleDrawer(false);
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

/** Radio list of a library's folders (nested), with a top-level option first. */
function folderRadios(lib, chosen, rootLabel, onPick, { rootIcon = null } = {}) {
  const list = el('div', { class: 'folder-picker', role: 'radiogroup', 'aria-label': '폴더 선택' });
  const name = `folder-pick-${Math.random().toString(36).slice(2, 8)}`;
  const option = (id, label, depth) => {
    const input = el('input', { type: 'radio', name, value: id ?? '', checked: chosen === id });
    input.addEventListener('change', () => onPick(id));
    return el('label', { class: 'menu-item', style: { paddingLeft: `${10 + depth * 18}px` } },
      input, id ? icon('folder', { size: 16 }) : (rootIcon || icon('library', { size: 16 })), el('span', { class: 'menu-label' }, label));
  };
  list.append(option(null, rootLabel, 0));
  const walk = (parentId, depth) => {
    lib.folders.filter((f) => (f.parentId ?? null) === parentId).sort((a, b) => collator.compare(a.name, b.name))
      .forEach((f) => { list.append(option(f.id, f.name, depth)); walk(f.id, depth + 1); });
  };
  walk(null, 0);
  return list;
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
