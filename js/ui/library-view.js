// Library view (#/): folder tree, paper list with search/sort, PDF upload, drag-drop, sync status.
import { LIMITS } from '../core/config.js';
import { settings } from '../core/settings.js';
import { debounce, el, formatBytes, formatDate } from '../core/util.js';
import {
  button, confirmDialog, contextMenu, iconButton, modal, progressBar, promptDialog, spinner, toast, uiState,
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
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

/**
 * @param {HTMLElement} container
 * @param {{ deps: object, navigate: (hash: string) => void }} opts
 * @returns {{ destroy: () => void }}
 */
export function mountLibraryView(container, { deps, navigate }) {
  const view = new LibraryView(container, deps, navigate);
  return { destroy: () => view.destroy() };
}

class LibraryView {
  #deps;
  #lib;
  #navigate;
  #root;
  #els = {};
  #state;
  #expanded;
  #cleanup = [];
  #renderQueued = false;
  #dragFolderId = null;
  #dragDepth = 0;
  #uploading = false;

  constructor(container, deps, navigate) {
    this.#deps = deps;
    this.#lib = deps.library;
    this.#navigate = navigate;
    const saved = uiState.get('library', {}) || {};
    this.#state = { collection: saved.collection || 'all', sort: saved.sort || 'added', query: '' };
    this.#expanded = new Set(saved.expanded || []);
    if (!this.#collectionExists(this.#state.collection)) this.#state.collection = 'all';

    this.#root = this.#build();
    container.replaceChildren(this.#root);
    this.#renderAll();

    this.#listen(this.#lib, 'change', () => this.#scheduleRender());
    this.#listen(this.#lib, 'syncstatus', () => this.#renderSync());
    this.#listen(document, 'keydown', (e) => this.#onKeyDown(e));
  }

  destroy() {
    for (const off of this.#cleanup) off();
    this.#cleanup = [];
    // "…을(를) 추가했습니다 [열기]" is stale once the library is left (and would cover the reader's panes).
    this.#uploadToast?.close?.();
    this.#root.remove();
  }

  #uploadToast = null;

  // ---------------------------------------------------------------- build

  #build() {
    const els = this.#els;
    els.nav = el('nav', { class: 'lib-nav', 'aria-label': '폴더' });
    els.nav.addEventListener('contextmenu', (e) => {
      if (/** @type {Element} */ (e.target).closest('.tree-item')) return;
      e.preventDefault();
      contextMenu([{ label: '새 폴더', icon: 'folder-plus', onClick: () => this.#createFolder(null) }], e.clientX, e.clientY);
    });

    const sidebar = el('aside', { class: 'lib-sidebar', 'aria-label': '라이브러리 탐색' },
      el('div', { class: 'lib-brand' },
        el('span', { class: 'lib-brand-mark' }, icon('book-open', { size: 18 })),
        el('div', {}, el('div', { class: 'lib-brand-name' }, '논문 리더'), el('div', { class: 'lib-brand-sub' }, '원문과 번역을 나란히'))),
      els.nav,
      el('div', { class: 'lib-sidebar-footer' },
        button('설정', { icon: 'settings', kind: 'ghost', className: 'lib-settings-btn', onClick: () => this.#navigate('#/settings') })));

    els.crumbs = el('div', { class: 'lib-crumbs' });
    els.title = el('h1', { class: 'lib-title' });
    els.search = el('input', {
      class: 'input lib-search', type: 'search', placeholder: '제목·저자·연도 검색', 'aria-label': '논문 검색',
      autocomplete: 'off', spellcheck: 'false',
    });
    const onSearch = debounce(() => { this.#state.query = els.search.value.trim(); this.#renderMain(); }, 120);
    els.search.addEventListener('input', onSearch);
    els.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && els.search.value) { e.preventDefault(); els.search.value = ''; onSearch.flush(); }
    });
    els.sort = el('select', { class: 'select lib-sort', 'aria-label': '정렬 기준' },
      SORTS.map((s) => el('option', { value: s.id }, `정렬: ${s.label}`)));
    els.sort.addEventListener('change', () => { this.#state.sort = els.sort.value; this.#persist(); this.#renderMain(); });
    els.syncChip = el('button', { type: 'button', class: 'chip lib-sync', onclick: () => this.#onSyncClick() });
    els.fileInput = el('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: true, hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
    els.fileInput.addEventListener('change', () => {
      const files = [...els.fileInput.files];
      els.fileInput.value = '';
      this.#upload(files, this.#currentFolderId());
    });
    els.uploadBtn = button('PDF 추가', { icon: 'upload', kind: 'primary', onClick: () => els.fileInput.click(), title: 'PDF 파일 추가 (여러 개 선택 가능)' });

    const header = el('header', { class: 'lib-header' },
      iconButton('menu', '폴더 목록 열기', () => this.#toggleDrawer(true), { className: 'lib-menu-btn' }),
      el('div', { class: 'lib-title-wrap' }, els.crumbs, els.title),
      el('div', { class: 'lib-actions' },
        el('label', { class: 'input-with-icon' }, icon('search', { size: 16 }), els.search),
        els.sort, els.syncChip, els.uploadBtn, els.fileInput));

    els.content = el('div', { class: 'lib-content' });
    els.dropOverlay = el('div', { class: 'drop-overlay', hidden: true },
      el('div', {}, icon('upload', { size: 30 }), el('span', {}, 'PDF를 놓으면 이 목록에 추가됩니다')));
    const main = el('main', { class: 'lib-main' }, header, els.content, els.dropOverlay);
    this.#bindFileDrop(main);

    const root = el('div', { class: 'library' }, sidebar, el('div', { class: 'sidebar-scrim', onclick: () => this.#toggleDrawer(false) }), main);
    return root;
  }

  #listen(target, type, fn) {
    target.addEventListener(type, fn);
    this.#cleanup.push(() => target.removeEventListener(type, fn));
  }

  #scheduleRender() {
    if (this.#renderQueued) return;
    this.#renderQueued = true;
    requestAnimationFrame(() => { this.#renderQueued = false; this.#renderAll(); });
  }

  #renderAll() {
    if (!this.#collectionExists(this.#state.collection)) this.#state.collection = 'all';
    this.#renderNav();
    this.#renderMain();
    this.#renderSync();
  }

  #persist() {
    uiState.set('library', { collection: this.#state.collection, sort: this.#state.sort, expanded: [...this.#expanded] });
  }

  // --------------------------------------------------------------- sidebar

  #renderNav() {
    const papers = this.#lib.papers;
    const folders = this.#lib.folders;
    const counts = folderCounts(papers, folders);

    const smart = el('ul', { class: 'tree', role: 'list' },
      this.#smartItem('all', papers.length),
      this.#smartItem('recent', papers.filter((p) => p.lastOpenedAt).length),
      this.#smartItem('starred', papers.filter((p) => p.starred).length));

    const heading = el('div', { class: 'lib-nav-heading' },
      el('span', {}, '폴더'),
      iconButton('folder-plus', '새 폴더', () => this.#createFolder(null), { size: 'sm' }));
    this.#makeDropTarget(heading, null, { acceptPapers: false });

    const tree = this.#folderTree(folders, null, 0, counts);
    const section = el('div', { class: 'lib-nav-section' }, heading,
      tree.childElementCount ? tree : el('p', { class: 'field-hint', style: { padding: '2px 10px' } }, '폴더가 없습니다. 위의 새 폴더 버튼을 눌러 만들어 보세요.'));
    this.#els.nav.replaceChildren(smart, section);
  }

  #smartItem(id, count) {
    const meta = SMART[id];
    const btn = el('button', {
      type: 'button', class: 'tree-item', 'aria-current': String(this.#state.collection === id),
      onclick: () => this.#selectCollection(id),
    }, icon(meta.icon, { size: 17 }), el('span', { class: 'tree-label' }, meta.label), el('span', { class: 'tree-count' }, String(count)));
    if (id === 'all') {
      btn.title = '논문을 여기로 끌어다 놓으면 폴더에서 빠집니다';
      this.#makeDropTarget(btn, null, { acceptFolders: false });
    }
    return el('li', {}, btn);
  }

  #folderTree(folders, parentId, depth, counts) {
    const list = el('ul', { class: 'tree', role: 'list' });
    const children = folders.filter((f) => (f.parentId ?? null) === parentId).sort((a, b) => collator.compare(a.name, b.name));
    for (const folder of children) {
      const hasChildren = folders.some((f) => f.parentId === folder.id);
      const expanded = hasChildren && this.#expanded.has(folder.id);
      const item = el('button', {
        type: 'button', class: 'tree-item is-folder', draggable: 'true', 'data-folder': folder.id,
        'aria-current': String(this.#state.collection === `folder:${folder.id}`),
        onclick: () => this.#selectCollection(`folder:${folder.id}`),
      },
      icon(expanded ? 'folder-open' : 'folder', { size: 17 }),
      el('span', { class: 'tree-label', title: folder.name }, folder.name),
      el('span', { class: 'tree-count', title: '하위 폴더 포함 논문 수' }, String(counts.get(folder.id) || 0)));
      item.style.setProperty('--depth', String(depth));
      item.addEventListener('contextmenu', (e) => { e.preventDefault(); this.#folderMenu(folder, e.clientX, e.clientY); });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const r = item.getBoundingClientRect();
          this.#folderMenu(folder, r.left + 24, r.bottom);
        }
      });
      item.addEventListener('dragstart', (e) => {
        this.#dragFolderId = folder.id;
        e.dataTransfer.setData(FOLDER_MIME, folder.id);
        e.dataTransfer.effectAllowed = 'move';
        item.classList.add('is-dragging');
      });
      item.addEventListener('dragend', () => { this.#dragFolderId = null; item.classList.remove('is-dragging'); });
      this.#makeDropTarget(item, folder.id);

      const row = el('div', { class: 'tree-row' }, item);
      row.style.setProperty('--depth', String(depth));
      if (hasChildren) {
        row.prepend(el('button', {
          type: 'button', class: 'tree-toggle', 'aria-expanded': String(expanded),
          'aria-label': expanded ? `${folder.name} 접기` : `${folder.name} 펼치기`,
          onclick: (e) => { e.stopPropagation(); this.#toggleExpanded(folder.id); },
        }, icon('chevron-right', { size: 14 })));
      }
      const li = el('li', {}, row);
      if (expanded) li.append(this.#folderTree(folders, folder.id, depth + 1, counts));
      list.append(li);
    }
    return list;
  }

  #toggleExpanded(id, force) {
    const open = force ?? !this.#expanded.has(id);
    if (open) this.#expanded.add(id); else this.#expanded.delete(id);
    this.#persist();
    this.#renderNav();
  }

  #selectCollection(id) {
    this.#state.collection = id;
    if (id.startsWith('folder:')) {
      // make sure every ancestor is expanded so the selection is visible
      for (const f of this.#chain(id.slice(7)).slice(1)) this.#expanded.add(f.id);
    }
    this.#persist();
    this.#toggleDrawer(false);
    this.#renderNav();
    this.#renderMain();
  }

  #toggleDrawer(open) {
    this.#root.classList.toggle('is-drawer-open', open);
  }

  // ------------------------------------------------------------------ main

  #renderMain() {
    const { collection } = this.#state;
    const els = this.#els;
    const allPapers = this.#lib.papers;
    const folder = collection.startsWith('folder:') ? this.#lib.getFolder(collection.slice(7)) : null;

    // header
    els.crumbs.replaceChildren();
    if (folder) {
      const chain = this.#chain(folder.id).slice(1).reverse();
      const crumb = (label, target) => el('button', { type: 'button', onclick: () => this.#selectCollection(target) }, label);
      els.crumbs.append(crumb('전체', 'all'));
      for (const f of chain) els.crumbs.append(icon('chevron-right', { size: 12 }), crumb(f.name, `folder:${f.id}`));
    } else {
      els.crumbs.append(el('span', {}, '라이브러리'));
    }
    els.title.textContent = folder ? folder.name : SMART[collection]?.label || '전체';
    els.sort.value = collection === 'recent' ? 'opened' : this.#state.sort;
    els.sort.disabled = collection === 'recent';

    // content
    const content = els.content;
    content.replaceChildren();
    if (!allPapers.length && collection === 'all' && !this.#state.query) {
      content.append(this.#onboarding());
      return;
    }
    if (folder) {
      const subs = this.#lib.folders.filter((f) => f.parentId === folder.id).sort((a, b) => collator.compare(a.name, b.name));
      if (subs.length) content.append(el('div', { class: 'lib-subfolders' }, subs.map((f) => this.#subfolderChip(f))));
    }
    const papers = this.#visiblePapers(allPapers, collection);
    if (!papers.length) {
      content.append(this.#emptyCollection(collection, folder));
      return;
    }
    const total = this.#state.query ? `검색 결과 ${papers.length}편` : `논문 ${papers.length}편`;
    content.append(el('p', { class: 'lib-count-line' }, total));
    const folderNames = new Map(this.#lib.folders.map((f) => [f.id, f.name]));
    content.append(el('div', { class: 'paper-list', role: 'list' }, papers.map((p) => this.#paperRow(p, folderNames, !folder))));
  }

  #visiblePapers(all, collection) {
    let list = all;
    if (collection === 'recent') list = all.filter((p) => p.lastOpenedAt);
    else if (collection === 'starred') list = all.filter((p) => p.starred);
    else if (collection.startsWith('folder:')) {
      const id = collection.slice(7);
      list = all.filter((p) => p.folderId === id);
    }
    const q = this.#state.query.toLowerCase();
    if (q) {
      list = list.filter((p) => [p.title, p.authors, p.fileName, p.year].some((v) => v != null && String(v).toLowerCase().includes(q)));
    }
    const sort = collection === 'recent' ? 'opened' : this.#state.sort;
    const sorted = [...list];
    if (sort === 'title') sorted.sort((a, b) => collator.compare(paperTitle(a), paperTitle(b)));
    else if (sort === 'opened') sorted.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0) || (b.addedAt || 0) - (a.addedAt || 0));
    else sorted.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return sorted;
  }

  #paperRow(paper, folderNames, showFolder) {
    const href = `#/paper/${encodeURIComponent(paper.id)}`;
    const title = paperTitle(paper);
    const meta = [];
    if (paper.authors) meta.push(el('span', { class: 'paper-authors', title: paper.authors }, paper.authors));
    if (paper.year) meta.push(el('span', {}, String(paper.year)));
    if (paper.pages) meta.push(el('span', {}, `${paper.pages}쪽`));
    if (paper.size) meta.push(el('span', {}, formatBytes(paper.size)));
    if (showFolder && paper.folderId && folderNames.has(paper.folderId)) {
      meta.push(el('span', { class: 'paper-folder' }, icon('folder', { size: 13 }), folderNames.get(paper.folderId)));
    }
    if (paper.addedAt) meta.push(el('span', {}, `${formatDate(paper.addedAt)} 추가`));
    const metaLine = el('div', { class: 'paper-meta' });
    meta.forEach((m, i) => { if (i) metaLine.append(el('span', { class: 'sep', 'aria-hidden': 'true' }, '·')); metaLine.append(m); });

    const star = iconButton('star', paper.starred ? '즐겨찾기 해제' : '즐겨찾기', () => {
      this.#lib.updatePaper(paper.id, { starred: !paper.starred });
    }, { className: 'star-btn', pressed: Boolean(paper.starred) });
    const more = iconButton('more-horizontal', '논문 메뉴', () => {
      const r = more.getBoundingClientRect();
      this.#paperMenu(paper, r.right - 190, r.bottom + 4);
    });

    const row = el('article', { class: 'paper-row', draggable: 'true', 'data-id': paper.id, role: 'listitem' },
      el('div', { class: 'paper-thumb', 'aria-hidden': 'true' }, icon('file-text', { size: 20 })),
      el('div', { class: 'paper-main' },
        el('a', { class: 'paper-link', href, draggable: 'false' }, el('h2', { class: 'paper-title' }, title)),
        metaLine),
      el('div', { class: 'paper-side' }, this.#progressCell(paper), star, more));

    row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.#paperMenu(paper, e.clientX, e.clientY); });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const r = row.getBoundingClientRect();
        this.#paperMenu(paper, r.left + 60, r.top + 40);
      }
    });
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(PAPER_MIME, paper.id);
      e.dataTransfer.setData('text/plain', title);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
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

  #subfolderChip(folder) {
    const chip = el('button', { type: 'button', class: 'subfolder', onclick: () => this.#selectCollection(`folder:${folder.id}`) },
      icon('folder', { size: 17 }), folder.name);
    chip.addEventListener('contextmenu', (e) => { e.preventDefault(); this.#folderMenu(folder, e.clientX, e.clientY); });
    this.#makeDropTarget(chip, folder.id, { acceptFolders: false });
    return chip;
  }

  #emptyCollection(collection, folder) {
    let title = '논문이 없습니다';
    let text = 'PDF를 끌어다 놓거나 ‘PDF 추가’를 눌러 논문을 추가하세요.';
    if (this.#state.query) {
      title = '검색 결과가 없습니다';
      text = `‘${this.#state.query}’에 맞는 논문을 찾지 못했습니다.`;
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
    return el('div', { class: 'empty-state' }, el('div', {},
      el('div', { class: 'icon-wrap' }, icon(this.#state.query ? 'search' : 'inbox', { size: 24 })),
      el('h2', {}, title), el('p', {}, text)));
  }

  #onboarding() {
    const ai = settings.isAiReady();
    const sync = settings.isSyncReady();
    const mock = settings.get().provider === 'mock';
    const dropzone = el('div', { class: 'dropzone' },
      el('div', { class: 'icon-wrap' }, icon('upload', { size: 24 })),
      el('div', { class: 'dropzone-title' }, '논문 PDF를 이곳에 끌어다 놓으세요'),
      el('div', { class: 'dropzone-hint' }, `여러 파일을 한 번에 올릴 수 있습니다 · 파일당 최대 ${formatBytes(LIMITS.maxPdfBytes)}`),
      button('PDF 선택', { icon: 'file', kind: 'primary', onClick: () => this.#els.fileInput.click() }));
    const step = (n, done, title, text, action) => el('li', { class: `step${done ? ' is-done' : ''}` },
      el('span', { class: 'step-num' }, done ? icon('check', { size: 16 }) : String(n)),
      el('div', {}, el('div', { class: 'step-title' }, title), el('div', { class: 'step-text' }, text)),
      action || el('span'));
    return el('section', { class: 'onboarding', 'aria-label': '시작하기' },
      el('div', { class: 'onboarding-hero' },
        el('h2', {}, '첫 논문을 추가해 보세요'),
        el('p', {}, '왼쪽에는 PDF 원문, 오른쪽에는 한국어 번역이 나란히 표시되고,\n한쪽 문장에 마우스를 올리면 반대쪽의 같은 문장이 함께 강조됩니다.')),
      dropzone,
      el('ol', { class: 'steps' },
        step(1, ai, 'AI 번역 연결',
          mock ? '테스트 모드(모의 AI)로 실행 중입니다. 실제 번역에는 설정에서 API 키가 필요합니다.'
            : ai ? 'AI API 키가 설정되어 있습니다.' : '설정에서 Claude 또는 Gemini API 키를 입력하세요. 키는 이 브라우저에만 저장됩니다.',
          button(ai && !mock ? '변경' : '설정 열기', { kind: ai && !mock ? 'ghost' : 'subtle', icon: 'key', size: 'sm', onClick: () => this.#navigate('#/settings/ai') })),
        step(2, sync, '(선택) GitHub 동기화',
          sync ? 'GitHub 비공개 저장소와 동기화하도록 설정되어 있습니다.' : '비공개 저장소 하나를 연결하면 여러 기기에서 같은 라이브러리·번역·메모를 사용할 수 있습니다.',
          button(sync ? '변경' : '설정 열기', { kind: sync ? 'ghost' : 'subtle', icon: 'git-branch', size: 'sm', onClick: () => this.#navigate('#/settings/sync') })),
        step(3, false, 'PDF 올리고 읽기', '논문을 열고 ‘번역 시작’을 누르면 현재 페이지부터 번역됩니다. 번역은 저장되어 다시 열 때 비용이 들지 않습니다.')));
  }

  // ------------------------------------------------------------- menus

  #paperMenu(paper, x, y) {
    contextMenu([
      { label: '열기', icon: 'book-open', onClick: () => this.#navigate(`#/paper/${encodeURIComponent(paper.id)}`) },
      { label: paper.starred ? '즐겨찾기 해제' : '즐겨찾기 추가', icon: 'star', onClick: () => this.#lib.updatePaper(paper.id, { starred: !paper.starred }) },
      { label: '폴더로 이동…', icon: 'folder-input', onClick: () => this.#pickFolder(paper) },
      { label: '제목 바꾸기', icon: 'pencil', onClick: () => this.#renamePaper(paper) },
      'sep',
      { label: '삭제', icon: 'trash', danger: true, onClick: () => this.#deletePaper(paper) },
    ], x, y);
  }

  #folderMenu(folder, x, y) {
    contextMenu([
      { label: '새 하위 폴더', icon: 'folder-plus', onClick: () => this.#createFolder(folder.id) },
      { label: '이름 바꾸기', icon: 'pencil', onClick: () => this.#renameFolder(folder) },
      { label: '최상위로 옮기기', icon: 'folder-input', disabled: !folder.parentId, onClick: () => this.#moveFolder(folder.id, null) },
      'sep',
      { label: '삭제', icon: 'trash', danger: true, onClick: () => this.#deleteFolder(folder) },
    ], x, y);
  }

  async #createFolder(parentId) {
    const parent = parentId ? this.#lib.getFolder(parentId) : null;
    const name = await promptDialog(parent ? `‘${parent.name}’ 안에 만들 폴더 이름` : '새 폴더 이름', { placeholder: '예: 섬망 연구', okLabel: '만들기', title: '새 폴더' });
    if (name == null || !name.trim()) return;
    try {
      const folder = this.#lib.createFolder(name.trim(), parentId);
      if (parentId) this.#expanded.add(parentId);
      this.#persist();
      if (folder?.id) this.#selectCollection(`folder:${folder.id}`);
      toast(`‘${name.trim()}’ 폴더를 만들었습니다.`, { kind: 'success' });
    } catch (err) { this.#fail(err); }
  }

  async #renameFolder(folder) {
    const name = await promptDialog('폴더 이름', { value: folder.name, okLabel: '바꾸기', title: '이름 바꾸기' });
    if (name == null || !name.trim() || name.trim() === folder.name) return;
    try { this.#lib.renameFolder(folder.id, name.trim()); } catch (err) { this.#fail(err); }
  }

  async #deleteFolder(folder) {
    const parent = folder.parentId ? this.#lib.getFolder(folder.parentId) : null;
    const ok = await confirmDialog(
      `‘${folder.name}’ 폴더를 삭제할까요?\n안에 있는 논문과 하위 폴더는 ${parent ? `‘${parent.name}’ 폴더로` : '최상위로'} 옮겨집니다. 논문은 삭제되지 않습니다.`,
      { okLabel: '폴더 삭제', danger: true, title: '폴더 삭제' });
    if (!ok) return;
    try {
      this.#lib.deleteFolder(folder.id);
      if (this.#state.collection === `folder:${folder.id}`) this.#state.collection = parent ? `folder:${parent.id}` : 'all';
      this.#persist();
      toast(`‘${folder.name}’ 폴더를 삭제했습니다.`);
    } catch (err) { this.#fail(err); }
  }

  #moveFolder(id, parentId) {
    if (parentId && this.#chain(parentId).some((f) => f.id === id)) {
      toast('폴더를 자기 자신이나 하위 폴더 안으로 옮길 수 없습니다.', { kind: 'warning' });
      return;
    }
    try {
      this.#lib.moveFolder(id, parentId);
      if (parentId) { this.#expanded.add(parentId); this.#persist(); }
    } catch (err) { this.#fail(err); }
  }

  #movePaper(paperId, folderId) {
    const paper = this.#lib.getPaper(paperId);
    if (!paper || (paper.folderId ?? null) === folderId) return;
    try {
      this.#lib.movePaper(paperId, folderId);
      const target = folderId ? this.#lib.getFolder(folderId)?.name : null;
      toast(target ? `‘${paperTitle(paper)}’을(를) ‘${target}’ 폴더로 옮겼습니다.` : `‘${paperTitle(paper)}’을(를) 폴더에서 뺐습니다.`, { kind: 'success' });
    } catch (err) { this.#fail(err); }
  }

  async #renamePaper(paper) {
    const title = await promptDialog('논문 제목', { value: paperTitle(paper), okLabel: '바꾸기', title: '제목 바꾸기' });
    if (title == null || !title.trim()) return;
    try { this.#lib.updatePaper(paper.id, { title: title.trim() }); } catch (err) { this.#fail(err); }
  }

  async #deletePaper(paper) {
    const ok = await confirmDialog(`‘${paperTitle(paper)}’을(를) 라이브러리에서 삭제할까요?\n번역·메모·AI 결과도 함께 지워집니다.`, { okLabel: '삭제', danger: true, title: '논문 삭제' });
    if (!ok) return;
    try {
      this.#lib.deletePaper(paper.id);
      toast('논문을 삭제했습니다.');
    } catch (err) { this.#fail(err); }
  }

  #pickFolder(paper) {
    let chosen = paper.folderId ?? null;
    const list = el('div', { class: 'folder-picker', role: 'radiogroup', 'aria-label': '이동할 폴더' });
    const option = (id, label, depth) => {
      const input = el('input', { type: 'radio', name: 'folder-pick', value: id ?? '', checked: chosen === id });
      input.addEventListener('change', () => { chosen = id; });
      return el('label', { class: 'menu-item', style: { paddingLeft: `${10 + depth * 18}px` } },
        input, icon(id ? 'folder' : 'library', { size: 16 }), el('span', { class: 'menu-label' }, label));
    };
    list.append(option(null, '폴더 없음 (최상위)', 0));
    const walk = (parentId, depth) => {
      this.#lib.folders.filter((f) => (f.parentId ?? null) === parentId).sort((a, b) => collator.compare(a.name, b.name))
        .forEach((f) => { list.append(option(f.id, f.name, depth)); walk(f.id, depth + 1); });
    };
    walk(null, 0);
    modal({
      title: '폴더로 이동',
      size: 'sm',
      body: el('div', {}, el('p', { class: 'field-hint', style: { marginTop: '0' } }, paperTitle(paper)), list),
      actions: [
        { label: '취소' },
        { label: '이동', kind: 'primary', onClick: () => this.#movePaper(paper.id, chosen) },
      ],
    });
  }

  // --------------------------------------------------------- drag & drop

  /**
   * Accept paper / folder drags (move) and file drags (upload) on a node.
   * @param {HTMLElement} node
   * @param {string|null} folderId  target folder (null = top level)
   */
  #makeDropTarget(node, folderId, { acceptPapers = true, acceptFolders = true } = {}) {
    const accepts = (dt) => {
      const types = [...dt.types];
      if (types.includes('Files')) return 'copy';
      if (acceptPapers && types.includes(PAPER_MIME)) return 'move';
      if (acceptFolders && types.includes(FOLDER_MIME) && this.#dragFolderId && this.#canDropFolder(this.#dragFolderId, folderId)) return 'move';
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
      if ([...dt.types].includes('Files')) { this.#upload([...dt.files], folderId); return; }
      const paperId = dt.getData(PAPER_MIME);
      if (paperId && acceptPapers) { this.#movePaper(paperId, folderId); return; }
      const draggedFolder = dt.getData(FOLDER_MIME);
      if (draggedFolder && acceptFolders) this.#moveFolder(draggedFolder, folderId);
    });
  }

  #canDropFolder(dragId, targetId) {
    if (dragId === targetId) return false;
    const dragged = this.#lib.getFolder(dragId);
    if (!dragged || (dragged.parentId ?? null) === targetId) return false;
    return !targetId || !this.#chain(targetId).some((f) => f.id === dragId);
  }

  #bindFileDrop(main) {
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    main.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      this.#dragDepth++;
      this.#els.dropOverlay.hidden = false;
    });
    main.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      this.#dragDepth = Math.max(0, this.#dragDepth - 1);
      if (!this.#dragDepth) this.#els.dropOverlay.hidden = true;
    });
    main.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    main.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.#hideDropOverlay();
      this.#upload([...e.dataTransfer.files], this.#currentFolderId());
    });
  }

  #hideDropOverlay() {
    this.#dragDepth = 0;
    this.#els.dropOverlay.hidden = true;
  }

  // ---------------------------------------------------------------- upload

  /** bytes → loadPdf → quickMeta → library.addPaper, one file at a time. */
  async #upload(files, folderId) {
    if (!files.length) return;
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
    const status = toast(`PDF 추가 준비 중… (0/${pdfs.length})`, { timeout: 0 });
    status.el.querySelector('.toast-icon')?.replaceChildren(spinner(16));
    const added = [];
    const failed = [];
    try {
      for (const [i, file] of pdfs.entries()) {
        status.update(`PDF 추가 중… (${i + 1}/${pdfs.length})\n${file.name}`);
        try {
          added.push(await this.#addOne(file, folderId, loadPdf, quickMeta));
        } catch (err) {
          console.warn('[library-view] upload failed', file.name, err);
          failed.push({ name: file.name, message: err?.message || '알 수 없는 오류' });
        }
      }
    } finally {
      status.close();
      this.#uploading = false;
      this.#els.uploadBtn.disabled = false;
    }
    if (added.length === 1) {
      const paper = added[0];
      const title = paperTitle(paper);
      this.#uploadToast = toast(`‘${title.length > 60 ? `${title.slice(0, 59)}…` : title}’을(를) 추가했습니다.`, {
        kind: 'success', timeout: 6000,
        action: { label: '열기', onClick: () => this.#navigate(`#/paper/${encodeURIComponent(paper.id)}`) },
      });
    } else if (added.length > 1) {
      toast(`논문 ${added.length}편을 추가했습니다.`, { kind: 'success' });
    }
    if (failed.length) {
      const lines = failed.slice(0, 4).map((f) => `• ${f.name}: ${f.message}`);
      if (failed.length > 4) lines.push(`외 ${failed.length - 4}개`);
      toast(`추가하지 못한 파일이 있습니다.\n${lines.join('\n')}`, { kind: 'error', timeout: 9000 });
    }
  }

  async #addOne(file, folderId, loadPdf, quickMeta) {
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
    return this.#lib.addPaper(bytes, { fileName: file.name, folderId, meta });
  }

  // ------------------------------------------------------------------ sync

  #renderSync() {
    const chip = this.#els.syncChip;
    const st = this.#lib.sync?.status || { state: 'disabled' };
    const last = st.lastSyncAt ? `마지막 동기화: ${new Date(st.lastSyncAt).toLocaleString('ko-KR')}` : '';
    const pending = st.pending ? `대기 중인 변경 ${st.pending}개` : '';
    let cls = 'is-off';
    let glyph = icon('cloud-off', { size: 15 });
    let text = 'GitHub 동기화: 꺼짐';
    let tip = '설정에서 GitHub 동기화를 켤 수 있습니다';
    switch (st.state) {
      case 'syncing': cls = 'is-busy'; glyph = spinner(13); text = '동기화 중…'; tip = pending || 'GitHub와 동기화하는 중'; break;
      case 'idle':
        cls = 'is-ok'; glyph = icon('cloud-check', { size: 15 });
        text = st.pending ? `동기화 대기 ${st.pending}` : '동기화 완료';
        tip = [last, pending, '클릭하면 지금 동기화합니다'].filter(Boolean).join('\n');
        break;
      case 'error': cls = 'is-error'; glyph = icon('alert-circle', { size: 15 }); text = '동기화 오류'; tip = st.message || '동기화 중 오류가 발생했습니다'; break;
      case 'offline': cls = 'is-off'; glyph = icon('cloud-off', { size: 15 }); text = '오프라인'; tip = [pending, '연결되면 자동으로 동기화합니다'].filter(Boolean).join('\n'); break;
      default: break;
    }
    chip.className = `chip lib-sync ${cls}`;
    chip.title = tip;
    chip.setAttribute('aria-label', `${text}. ${tip}`);
    chip.replaceChildren(glyph, el('span', {}, text));
  }

  async #onSyncClick() {
    const sync = this.#lib.sync;
    const st = sync?.status || { state: 'disabled' };
    if (!sync || st.state === 'disabled') { this.#navigate('#/settings'); return; }
    if (st.state === 'error') {
      toast(st.message || '동기화 중 오류가 발생했습니다.', { kind: 'error', timeout: 8000, action: { label: '설정', onClick: () => this.#navigate('#/settings') } });
    }
    if (st.state === 'syncing') return;
    try { await sync.syncNow(); } catch (err) { this.#fail(err); }
  }

  // ----------------------------------------------------------------- misc

  #onKeyDown(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/' && !isTypingTarget(e.target)) {
      e.preventDefault();
      this.#els.search.focus();
      this.#els.search.select();
    } else if (e.key === 'Escape' && this.#root.classList.contains('is-drawer-open')) {
      this.#toggleDrawer(false);
    }
  }

  #currentFolderId() {
    const c = this.#state.collection;
    return c.startsWith('folder:') ? c.slice(7) : null;
  }

  #collectionExists(c) {
    if (SMART[c]) return true;
    return c.startsWith('folder:') && Boolean(this.#lib.getFolder(c.slice(7)));
  }

  /** The folder followed by its ancestors, nearest first: [self, parent, grandparent, …]. */
  #chain(folderId) {
    const out = [];
    const seen = new Set();
    let f = this.#lib.getFolder(folderId);
    while (f && !seen.has(f.id)) {
      seen.add(f.id);
      out.push(f);
      f = f.parentId ? this.#lib.getFolder(f.parentId) : null;
    }
    return out;
  }

  #fail(err) {
    console.warn('[library-view]', err);
    toast(err?.message || '작업을 완료하지 못했습니다.', { kind: 'error' });
  }
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
