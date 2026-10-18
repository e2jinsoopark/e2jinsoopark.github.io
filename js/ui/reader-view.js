// Reader view (#/paper/<id>): toolbar, PDF viewer (left) ↔ tabs (right), translation controls, feature host.
import { bus } from '../core/bus.js';
import { settings } from '../core/settings.js';
import { clamp, debounce, el, formatUsd, hash, rafThrottle } from '../core/util.js';
import {
  button, contextMenu, hasOpenLayer, iconButton, messageScreen, modal, progressBar, spinner, toast, uiState,
} from './components.js';
import { icon, resolveIcon } from './icons.js';
import { TranslationPane, isTranslatableSentence } from './translation-pane.js';

const VIEW_MODES = [
  { id: 'original', label: '원문', icon: 'file', title: '원문만 보기' },
  { id: 'side', label: '나란히', icon: 'columns', title: '원문과 번역을 나란히 보기' },
  { id: 'overlay', label: '번역 겹쳐보기', icon: 'layers', title: 'PDF 위에 번역을 겹쳐 보기' },
];
const NARROW_QUERY = '(max-width: 860px)';
const MIN_SIDE_PX = 260;
const DEFAULT_SPLIT = { h: 0.5, v: 0.55 };
const MAX_REMEMBERED_PAGES = 60;
const HOVER_REVEAL_MS = 350;

/**
 * @param {HTMLElement} container
 * @param {{ paperId: string, deps: object, navigate: (hash: string) => void }} opts
 * @returns {{ destroy: () => void }}
 */
export function mountReaderView(container, { paperId, deps, navigate }) {
  const view = new ReaderView(container, { paperId, deps, navigate });
  return { destroy: () => view.destroy() };
}

class ReaderView {
  #deps;
  #lib;
  #navigate;
  #paperId;
  #root;
  #els = {};
  #abort = new AbortController();
  #destroyed = false;
  #cleanup = [];

  #pdf = null;
  #doc = null;
  #viewer = null;
  #pane = null;
  #translator = null;
  #ctx = null;
  #ai = { version: 1 };
  #aiChain = Promise.resolve();
  #featureHandle = null;
  #tabs = [];
  #panelInstances = new Map();
  #activeTab = 'translation';
  #viewerReady = false;
  #overlayOn = false;
  #paneMap = null;

  #viewMode = 'side';
  #fitWidth = true;
  #split = DEFAULT_SPLIT.h;
  /** Active translation requests; a retry may run alongside a full translation. */
  #runs = new Set();
  #activeSid = null;
  #hoverSid = null;
  #revealTimer = null;
  #paneUserScrollAt = 0;
  #pointerInPane = false;
  #lastSyncedSid = null;
  #lastError = { message: '', at: 0 };
  #pendingTranslation = null;
  #countsTimer = null;

  #saveTranslationSoon = debounce(() => this.#flushTranslationSave(), 1500);
  #refreshOverlaySoon = debounce(() => this.#refreshOverlay(), 400);
  #rememberPageSoon = debounce((page) => this.#rememberPage(page), 800);

  constructor(container, { paperId, deps, navigate }) {
    this.#deps = deps;
    this.#lib = deps.library;
    this.#navigate = navigate;
    this.#paperId = paperId;
    this.#els.toolbar = el('header', { class: 'reader-toolbar', role: 'toolbar', 'aria-label': '논문 도구 모음' });
    this.#els.body = el('div', { class: 'reader-body' });
    this.#root = el('div', { class: 'reader', 'data-mode': 'side', 'data-orient': 'h' }, this.#els.toolbar, this.#els.body);
    container.replaceChildren(this.#root);
    this.#renderToolbarSkeleton();
    this.#showLoading('논문을 여는 중…');
    this.#open().catch((err) => this.#showError(err));
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#abort.abort();
    clearTimeout(this.#revealTimer);
    if (this.#runs.size) { try { this.#translator?.cancel(); } catch { /* ignore */ } }
    this.#saveTranslationSoon.cancel();
    this.#flushTranslationSave();
    this.#refreshOverlaySoon.cancel();
    this.#rememberPageSoon.flush?.(this.#viewer?.currentPage);
    clearTimeout(this.#countsTimer);
    if (this.#translator && this.#doc) this.#flushCounts();
    safely(() => this.#featureHandle?.dispose?.());
    for (const inst of this.#panelInstances.values()) safely(() => inst?.destroy?.());
    safely(() => this.#pane?.destroy());
    safely(() => this.#viewer?.destroy());
    if (this.#pdf?.destroy) Promise.resolve().then(() => this.#pdf.destroy()).catch(() => {});
    for (const off of this.#cleanup) safely(off);
    this.#cleanup = [];
    this.#root.remove();
  }

  // ------------------------------------------------------------------ open

  async #open() {
    const paper = this.#lib.getPaper(this.#paperId);
    if (!paper) { this.#showNotFound(); return; }
    this.#setTitle(paper);

    const { loadPdf, extractDocument, PdfViewer } = this.#deps;
    const missing = [!loadPdf && 'js/pdf/pdfjs.js', !extractDocument && 'js/pdf/extract.js', !PdfViewer && 'js/pdf/viewer.js'].filter(Boolean);
    if (missing.length) {
      const err = new Error('PDF 모듈을 불러오지 못해 논문을 열 수 없습니다. 페이지를 새로 고쳐 보세요.');
      err.details = `불러오지 못한 모듈: ${missing.join(', ')}`;
      throw err;
    }

    this.#showLoading('PDF 파일을 불러오는 중…');
    const bytes = await this.#lib.getPdf(paper.id);
    if (this.#destroyed) return;
    if (!bytes?.byteLength) throw new Error('PDF 파일을 찾을 수 없습니다. 동기화가 끝난 뒤 다시 시도하세요.');

    const pdf = await loadPdf(bytes);
    if (this.#destroyed) { safely(() => pdf?.destroy?.()); return; }
    this.#pdf = pdf;

    this.#showLoading('본문 텍스트를 분석하는 중…', 0);
    const doc = await extractDocument(pdf, { onProgress: (a, b) => this.#onExtractProgress(a, b) });
    if (this.#destroyed) return;
    this.#doc = doc;

    const [cached, ai] = await Promise.all([this.#loadData('translation'), this.#loadData('ai')]);
    if (this.#destroyed) return;
    if (ai && typeof ai === 'object') this.#ai = ai;
    await this.#buildReader(cached);
  }

  async #loadData(kind) {
    try {
      return await this.#lib.getPaperData(this.#paperId, kind);
    } catch (err) {
      console.warn('[reader-view] getPaperData', kind, err);
      return null;
    }
  }

  #onExtractProgress(a, b) {
    let ratio = null;
    if (a && typeof a === 'object') {
      const done = a.page ?? a.done ?? a.current ?? a.pagesDone;
      const total = a.numPages ?? a.total ?? a.pages;
      if (Number.isFinite(done) && Number.isFinite(total) && total > 0) ratio = done / total;
      else if (Number.isFinite(a.ratio)) ratio = a.ratio;
    } else if (Number.isFinite(a) && Number.isFinite(b) && b > 0) ratio = a / b;
    else if (Number.isFinite(a) && a <= 1) ratio = a;
    if (ratio != null) this.#els.loadingBar?.set(ratio);
  }

  async #buildReader(cached) {
    const els = this.#els;
    els.viewerHost = el('div', { class: 'viewer-host', tabindex: '0', 'aria-label': 'PDF 원문' });
    els.viewerLoading = el('div', { class: 'reader-loading' }, el('div', { class: 'reader-loading-card' }, spinner(22), el('span', {}, '페이지를 그리는 중…')));
    els.left = el('section', { class: 'reader-left', 'aria-label': '원문' }, els.viewerHost, els.viewerLoading);
    els.divider = el('div', {
      class: 'reader-divider', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical',
      'aria-label': '원문과 번역 사이 경계 (화살표 키로 조절, Enter로 초기화)', 'aria-valuemin': '20', 'aria-valuemax': '80',
      title: '끌어서 너비 조절 · 두 번 클릭하면 반반',
    });
    els.tabbar = el('div', { class: 'tabbar', role: 'tablist', 'aria-label': '오른쪽 패널' });
    els.panels = el('div', { class: 'tabpanels' });
    els.right = el('section', { class: 'reader-right', 'aria-label': '번역과 도구' }, els.tabbar, els.panels);
    els.body.replaceChildren(els.left, els.divider, els.right);
    this.#initSplit();

    // translation tab
    els.tpStatus = el('div', { class: 'tp-header-status', 'aria-live': 'polite' });
    els.syncBtn = button('스크롤 연동', {
      icon: 'scroll-sync', kind: 'ghost', size: 'sm', pressed: settings.get().ui.syncScroll,
      title: 'PDF를 스크롤하면 번역도 같은 위치로 따라갑니다', onClick: () => settings.set({ ui: { syncScroll: !settings.get().ui.syncScroll } }),
    });
    els.tpHost = el('div', { class: 'tp-host' });
    els.translationPanel = el('div', { class: 'tabpanel is-translation' }, el('div', { class: 'tp-header' }, els.tpStatus, els.syncBtn), els.tpHost);

    const { PdfViewer } = this.#deps;
    this.#viewer = new PdfViewer(els.viewerHost, { pdf: this.#pdf, doc: this.#doc });
    this.#pane = new TranslationPane(els.tpHost, { doc: this.#doc });
    this.#translator = this.#createTranslator(cached);
    this.#syncPaneMap(true);

    this.#buildToolbar();
    this.#wirePane();
    this.#wireTranslator();
    this.#wireGlobal();
    this.#setViewMode(uiState.get('viewMode', 'side'), { persist: false, refit: false });

    await this.#viewer.init();
    if (this.#destroyed) return;
    this.#viewerReady = true;
    els.viewerLoading.remove();
    this.#wireViewer();
    this.#refreshOverlay();
    this.#refit();
    const lastPage = (uiState.get('lastPages', {}) || {})[this.#paperId];
    if (Number.isFinite(lastPage) && lastPage > 1) this.#viewer.scrollToPage(lastPage);
    this.#setPageLabel(this.#viewer.currentPage || 1);
    this.#updateZoomLabel();

    this.#ctx = this.#createContext();
    this.#installFeatures();
    this.#buildTabs();
    this.#refreshProgress();
    this.#flushCounts({ lastOpenedAt: Date.now() });
  }

  #createTranslator(cached) {
    const { Translator } = this.#deps;
    const save = (obj) => {
      this.#pendingTranslation = obj;
      this.#saveTranslationSoon();
      return Promise.resolve();
    };
    if (Translator) {
      try {
        return new Translator({ doc: this.#doc, cached, save, paperId: this.#paperId });
      } catch (err) {
        console.warn('[reader-view] Translator', err);
      }
    }
    return new OfflineTranslator(this.#doc, cached);
  }

  /** FeatureContext (SPEC §3.5). */
  #createContext() {
    const view = this;
    return {
      get paper() { return view.#lib.getPaper(view.#paperId) || null; },
      doc: this.#doc,
      pdf: this.#pdf,
      viewer: this.#viewer,
      pane: this.#pane,
      translator: this.#translator,
      library: this.#lib,
      settings,
      bus,
      getAi: () => this.#ai,
      saveAi: (patch) => this.#saveAi(patch),
      addToolbarButton: (spec) => this.#addToolbarButton(spec),
      openPanel: (id) => this.#openPanel(id),
      jumpToSentence: (sid) => this.#jumpToSentence(sid),
      signal: this.#abort.signal,
    };
  }

  #installFeatures() {
    const install = this.#deps.features?.installReaderFeatures;
    if (typeof install !== 'function') return;
    try {
      this.#featureHandle = install(this.#ctx) || null;
    } catch (err) {
      console.warn('[reader-view] installReaderFeatures', err);
      toast(`부가 기능을 준비하지 못했습니다: ${err?.message || err}`, { kind: 'error' });
    }
  }

  #saveAi(patch) {
    this.#ai = { ...this.#ai, ...(patch || {}), version: 1 };
    const snapshot = this.#ai;
    const p = this.#aiChain.then(() => this.#lib.savePaperData(this.#paperId, 'ai', snapshot));
    this.#aiChain = p.catch((err) => console.warn('[reader-view] saveAi', err));
    return p;
  }

  // --------------------------------------------------------------- toolbar

  #renderToolbarSkeleton() {
    const els = this.#els;
    els.title = el('div', { class: 'tb-title' }, '');
    els.toolbar.replaceChildren(this.#backButton(), els.title);
  }

  #backButton() {
    const b = button('라이브러리', { icon: 'arrow-left', kind: 'ghost', title: '라이브러리로 돌아가기', className: 'tb-back', onClick: () => this.#navigate('#/') });
    b.setAttribute('aria-label', '라이브러리로 돌아가기');
    return b;
  }

  #setTitle(paper) {
    const title = paper?.title || paper?.fileName || '제목 없음';
    this.#els.title.textContent = title;
    this.#els.title.title = title;
    document.title = `${title} · 논문 리더`;
  }

  #buildToolbar() {
    const els = this.#els;
    const numPages = this.#doc?.numPages || this.#pdf?.numPages || 1;
    els.pageInput = el('input', { class: 'input tb-page-input', type: 'text', inputmode: 'numeric', value: '1', 'aria-label': `페이지 번호 (전체 ${numPages}쪽)` });
    els.pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.#gotoPage(parseInt(els.pageInput.value, 10) || 1); els.pageInput.blur(); }
      else if (e.key === 'Escape') { els.pageInput.value = String(this.#viewer?.currentPage || 1); els.pageInput.blur(); }
    });
    els.pageInput.addEventListener('change', () => this.#gotoPage(parseInt(els.pageInput.value, 10) || 1));
    els.pageInput.addEventListener('focus', () => els.pageInput.select());
    const pageGroup = el('div', { class: 'tb-group tb-page' },
      iconButton('chevron-left', '이전 페이지 (←)', () => this.#stepPage(-1), { size: 'sm' }),
      els.pageInput, el('span', {}, `/ ${numPages}`),
      iconButton('chevron-right', '다음 페이지 (→)', () => this.#stepPage(1), { size: 'sm' }));

    els.zoomLabel = button('100%', { kind: 'ghost', size: 'sm', className: 'tb-zoom-label', title: '현재 배율 · 클릭하면 폭 맞춤', onClick: () => this.#zoom('fit') });
    const zoomGroup = el('div', { class: 'tb-group tb-zoom' },
      iconButton('zoom-out', '축소 (-)', () => this.#zoom('out'), { size: 'sm' }),
      els.zoomLabel,
      iconButton('zoom-in', '확대 (+)', () => this.#zoom('in'), { size: 'sm' }),
      iconButton('fit-width', '폭 맞춤 (0)', () => this.#zoom('fit'), { size: 'sm', className: 'tb-hide-md' }));

    els.modeBtns = new Map();
    const modes = el('div', { class: 'segmented', role: 'group', 'aria-label': '보기 방식' });
    for (const m of VIEW_MODES) {
      const b = button(m.label, { icon: m.icon, title: m.title, size: 'sm', pressed: m.id === this.#viewMode, onClick: () => this.#setViewMode(m.id) });
      b.querySelector('.btn-label')?.classList.add('tb-collapse');
      els.modeBtns.set(m.id, b);
      modes.append(b);
    }

    els.features = el('div', { class: 'tb-features' });
    els.toolbar.replaceChildren(
      this.#backButton(), els.title, pageGroup, el('span', { class: 'tb-sep' }), zoomGroup, el('span', { class: 'tb-sep' }),
      modes, el('span', { class: 'tb-sep' }), this.#buildTranslateControl(), els.features,
      iconButton('settings', '설정', () => this.#navigate('#/settings')));
  }

  #buildTranslateControl() {
    const main = button('번역 시작', { icon: 'languages', kind: 'primary', className: 'tb-tr-main', onClick: () => this.#runTranslation('all') });
    const more = iconButton('chevron-down', '번역 옵션', () => this.#openTranslateMenu(more), { kind: 'primary', className: 'tb-tr-more' });
    const bar = progressBar(0, { label: '번역 진행률' });
    const pct = el('span', { class: 'tb-pct' });
    const cost = el('span', { class: 'tb-cost', title: '이번 번역에 든 예상 비용' });
    const stop = iconButton('stop', '번역 중지', () => this.#cancelTranslation(), { size: 'sm' });
    const progress = el('div', { class: 'tb-progress', hidden: true }, bar.el, pct, cost, stop);
    const wrap = el('div', { class: 'tb-translate' }, main, more, progress);
    this.#els.tr = { wrap, main, more, bar, pct, cost, stop, progress };
    return wrap;
  }

  #openTranslateMenu(anchor) {
    const tr = this.#translator;
    const page = this.#viewer?.currentPage || 1;
    const failed = this.#pane?.failedSids || [];
    const running = this.#runs.size > 0;
    const available = this.#canTranslate();
    const usage = this.#deps.usage?.usageSummary ? safely(() => this.#deps.usage.usageSummary()) : null;
    const { done, total } = tr?.progress || { done: 0, total: 0 };
    const r = anchor.getBoundingClientRect();
    contextMenu([
      { label: '전체 번역 (현재 페이지부터)', icon: 'languages', disabled: running || !available || done >= total, onClick: () => this.#runTranslation('all') },
      { label: `이 페이지만 번역 (${page}쪽)`, icon: 'file-text', disabled: running || !available, onClick: () => this.#runTranslation('page') },
      { label: `실패한 문장 다시 번역${failed.length ? ` (${failed.length})` : ''}`, icon: 'rotate-ccw', disabled: !available || !failed.length, onClick: () => this.#runTranslation('sids', failed) },
      ...(running ? [{ label: '번역 중지', icon: 'stop', onClick: () => this.#cancelTranslation() }] : []),
      'sep',
      { note: `번역 모델: ${settings.model('translate') || '미설정'} · ${done}/${total} 문장` },
      ...(usage ? [{ note: `이번 달 AI 사용액(추정): ${formatUsd(usage.usd)} · ${usage.calls ?? 0}회` }] : []),
    ], Math.max(8, r.right - 260), r.bottom + 4);
  }

  #refreshProgress() {
    const tr = this.#translator;
    const els = this.#els;
    if (!tr || !els.tr) return;
    const { done = 0, total = 0, costUsd = 0 } = tr.progress || {};
    const running = this.#runs.size > 0;
    const complete = total > 0 && done >= total;
    const available = this.#canTranslate();
    const ratio = total ? done / total : 0;
    const pct = Math.floor(ratio * 100);
    const { main, wrap, progress, bar, cost, stop } = els.tr;

    const label = running ? '번역 중…' : complete ? '번역 완료' : done > 0 ? '이어서 번역' : '번역 시작';
    main.querySelector('.btn-label').textContent = label;
    main.replaceChild(running ? spinner(15) : icon(complete ? 'check' : 'languages', { size: 18 }), main.firstChild);
    main.disabled = running || complete || !available;
    main.title = !available ? this.#unavailableReason() : complete ? '모든 문장을 번역했습니다' : `현재 페이지부터 번역 (${done}/${total} 문장 완료)`;
    wrap.classList.toggle('is-complete', complete && !running);
    progress.hidden = !(running || (done > 0 && !complete));
    bar.set(ratio);
    els.tr.pct.textContent = `${pct}%`;
    cost.textContent = costUsd ? formatUsd(costUsd) : '';
    stop.hidden = !running;

    const failed = this.#pane?.failedSids.length || 0;
    const status = [];
    if (!total) status.push(this.#doc?.hasTextLayer === false ? '스캔 PDF — 번역할 텍스트가 없습니다' : '번역할 문장이 없습니다');
    else status.push(`번역 ${done.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')} 문장 (${pct}%)`);
    if (failed) status.push(`실패 ${failed}`);
    if (costUsd) status.push(`비용 ${formatUsd(costUsd)}`);
    els.tpStatus.replaceChildren(...(running ? [spinner(13)] : []), el('span', {}, status.join(' · ')));
  }

  #canTranslate() {
    const tr = this.#translator;
    return Boolean(tr && tr.available !== false && (tr.progress?.total || 0) > 0);
  }

  #unavailableReason() {
    if (this.#translator?.available === false) return '번역 모듈을 불러오지 못했습니다';
    if (this.#doc?.hasTextLayer === false) return '스캔 PDF라 번역할 텍스트가 없습니다';
    return '번역할 문장이 없습니다';
  }

  #addToolbarButton({ id, icon: iconSpec, title = '', toggle = false, onClick } = {}) {
    const label = title || id || '';
    const btn = el('button', {
      type: 'button', class: 'btn btn-ghost btn-sm tb-feature', 'data-feature': id || null,
      title: label, 'aria-label': label, 'aria-pressed': toggle ? 'false' : null,
    }, resolveIcon(iconSpec, 17), el('span', { class: 'btn-label tb-collapse' }, label));
    let active = false;
    const setActive = (value) => {
      active = Boolean(value);
      if (toggle) btn.setAttribute('aria-pressed', String(active));
    };
    btn.addEventListener('click', async () => {
      const prev = active;
      if (toggle) setActive(!active);
      try {
        await onClick?.(active);
      } catch (err) {
        console.warn('[reader-view] toolbar button', id, err);
        if (toggle) setActive(prev);
        toast(err?.message || '작업을 완료하지 못했습니다.', { kind: 'error' });
      }
    });
    if (id) this.#els.features.querySelector(`[data-feature="${CSS.escape(id)}"]`)?.remove();
    this.#els.features.append(btn);
    return { el: btn, setActive };
  }

  // -------------------------------------------------------------- page & zoom

  #gotoPage(n) {
    const total = this.#doc?.numPages || this.#pdf?.numPages || 1;
    const page = clamp(Math.round(n), 1, total);
    this.#viewer?.scrollToPage(page);
    this.#setPageLabel(page);
  }

  #stepPage(delta) {
    this.#gotoPage((this.#viewer?.currentPage || 1) + delta);
  }

  #setPageLabel(page) {
    const input = this.#els.pageInput;
    if (input && document.activeElement !== input) input.value = String(page);
  }

  #rememberPage(page) {
    if (!Number.isFinite(page)) return;
    const all = { ...(uiState.get('lastPages', {}) || {}) };
    delete all[this.#paperId];
    all[this.#paperId] = page;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_PAGES))) delete all[k];
    uiState.set('lastPages', all);
  }

  #zoom(action) {
    const v = this.#viewer;
    if (!v) return;
    try {
      if (action === 'in') { v.zoomIn(); this.#fitWidth = false; }
      else if (action === 'out') { v.zoomOut(); this.#fitWidth = false; }
      else { v.setZoom('fit-width'); this.#fitWidth = true; }
    } catch (err) {
      console.warn('[reader-view] zoom', err);
    }
    requestAnimationFrame(() => this.#updateZoomLabel());
    setTimeout(() => this.#updateZoomLabel(), 250);
  }

  #updateZoomLabel() {
    const label = this.#els.zoomLabel?.querySelector('.btn-label');
    if (!label) return;
    const z = Number(this.#viewer?.zoom);
    label.textContent = Number.isFinite(z) && z > 0 ? `${Math.round(z * 100)}%` : '폭 맞춤';
  }

  #refit = rafThrottle(() => {
    if (this.#destroyed || !this.#viewerReady) return;
    if (this.#fitWidth) safely(() => this.#viewer.setZoom('fit-width'));
    setTimeout(() => this.#updateZoomLabel(), 120);
  });

  // ------------------------------------------------------------ view mode

  #setViewMode(mode, { persist = true, refit = true } = {}) {
    if (!VIEW_MODES.some((m) => m.id === mode)) mode = 'side';
    this.#viewMode = mode;
    this.#root.dataset.mode = mode;
    for (const [id, b] of this.#els.modeBtns || []) b.setAttribute('aria-pressed', String(id === mode));
    this.#refreshOverlay();
    if (persist) uiState.set('viewMode', mode);
    if (refit) this.#refit();
  }

  #refreshOverlay() {
    if (!this.#viewerReady || !this.#translator) return;
    const on = this.#viewMode === 'overlay';
    if (!on && !this.#overlayOn) return;
    this.#overlayOn = on;
    safely(() => this.#viewer.setTranslationOverlay(on ? this.#translator.translations : null));
  }

  /** The translator may hand out a fresh Map per `translations` read; keep the pane pointed at the current one. */
  #syncPaneMap(repaint) {
    const map = this.#translator.translations;
    if (map === this.#paneMap && !repaint) return;
    this.#paneMap = map;
    this.#pane.setTranslations(map, { repaint });
  }

  // ---------------------------------------------------------------- split

  #initSplit() {
    const els = this.#els;
    const mq = window.matchMedia(NARROW_QUERY);
    const applyOrient = () => {
      const vertical = mq.matches;
      this.#root.dataset.orient = vertical ? 'v' : 'h';
      els.divider.setAttribute('aria-orientation', vertical ? 'horizontal' : 'vertical');
      this.#applySplit(uiState.get(this.#splitKey(), vertical ? DEFAULT_SPLIT.v : DEFAULT_SPLIT.h));
      this.#refit();
    };
    mq.addEventListener('change', applyOrient);
    this.#cleanup.push(() => mq.removeEventListener('change', applyOrient));
    applyOrient();

    els.divider.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      els.divider.setPointerCapture(e.pointerId);
      els.divider.focus({ preventScroll: true });
      this.#root.classList.add('is-resizing');
      const move = (ev) => this.#applySplit(this.#ratioFromPointer(ev));
      const up = () => {
        els.divider.removeEventListener('pointermove', move);
        els.divider.removeEventListener('pointerup', up);
        els.divider.removeEventListener('pointercancel', up);
        this.#root.classList.remove('is-resizing');
        uiState.set(this.#splitKey(), this.#split);
        this.#refit();
      };
      els.divider.addEventListener('pointermove', move);
      els.divider.addEventListener('pointerup', up);
      els.divider.addEventListener('pointercancel', up);
    });
    els.divider.addEventListener('dblclick', () => this.#resetSplit());
    els.divider.addEventListener('keydown', (e) => {
      const vertical = this.#root.dataset.orient === 'v';
      const dec = vertical ? 'ArrowUp' : 'ArrowLeft';
      const inc = vertical ? 'ArrowDown' : 'ArrowRight';
      let next = null;
      if (e.key === dec) next = this.#split - 0.02;
      else if (e.key === inc) next = this.#split + 0.02;
      else if (e.key === 'Home') next = 0.2;
      else if (e.key === 'End') next = 0.8;
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.#resetSplit(); return; }
      if (next == null) return;
      e.preventDefault();
      e.stopPropagation();
      this.#applySplit(next);
      uiState.set(this.#splitKey(), this.#split);
      this.#refit();
    });
  }

  #splitKey() {
    return this.#root.dataset.orient === 'v' ? 'splitRatioV' : 'splitRatio';
  }

  #ratioFromPointer(e) {
    const rect = this.#els.body.getBoundingClientRect();
    const vertical = this.#root.dataset.orient === 'v';
    const size = vertical ? rect.height : rect.width;
    const pos = vertical ? e.clientY - rect.top : e.clientX - rect.left;
    return size > 0 ? pos / size : this.#split;
  }

  #applySplit(ratio) {
    const rect = this.#els.body.getBoundingClientRect();
    const vertical = this.#root.dataset.orient === 'v';
    const size = (vertical ? rect.height : rect.width) || 1000;
    const minRatio = Math.min(0.45, MIN_SIDE_PX / size);
    const r = clamp(Number(ratio) || 0.5, Math.max(0.2, minRatio), Math.min(0.8, 1 - minRatio));
    this.#split = r;
    this.#els.body.style.setProperty(vertical ? '--split-v' : '--split', `${(r * 100).toFixed(2)}%`);
    this.#els.divider.setAttribute('aria-valuenow', String(Math.round(r * 100)));
  }

  #resetSplit() {
    const vertical = this.#root.dataset.orient === 'v';
    this.#applySplit(vertical ? DEFAULT_SPLIT.v : DEFAULT_SPLIT.h);
    uiState.set(this.#splitKey(), this.#split);
    this.#refit();
  }

  // ----------------------------------------------------------------- tabs

  #buildTabs() {
    const els = this.#els;
    const tabs = [{ id: 'translation', title: '번역', icon: 'languages', el: els.translationPanel, spec: null }];
    for (const spec of this.#deps.features?.panels || []) {
      if (!spec?.id || typeof spec.mount !== 'function' || spec.id === 'translation') continue;
      tabs.push({ id: spec.id, title: spec.title || spec.id, icon: spec.icon, spec, el: el('div', { class: 'tabpanel' }) });
    }
    this.#tabs = tabs;
    els.tabbar.replaceChildren();
    els.panels.replaceChildren();
    for (const tab of tabs) {
      const tabId = `rt-tab-${tab.id}`;
      const panelId = `rt-panel-${tab.id}`;
      tab.button = el('button', {
        type: 'button', class: 'tab', role: 'tab', id: tabId, 'aria-controls': panelId,
        'aria-selected': 'false', tabindex: '-1', 'data-tab': tab.id,
        onclick: () => this.#openPanel(tab.id),
      }, resolveIcon(tab.icon, 16), el('span', {}, tab.title));
      tab.el.id = panelId;
      tab.el.setAttribute('role', 'tabpanel');
      tab.el.setAttribute('aria-labelledby', tabId);
      tab.el.hidden = true;
      els.tabbar.append(tab.button);
      els.panels.append(tab.el);
    }
    els.tabbar.addEventListener('keydown', (e) => {
      const i = this.#tabs.findIndex((t) => t.id === this.#activeTab);
      let next = null;
      if (e.key === 'ArrowRight') next = (i + 1) % this.#tabs.length;
      else if (e.key === 'ArrowLeft') next = (i - 1 + this.#tabs.length) % this.#tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = this.#tabs.length - 1;
      if (next == null) return;
      e.preventDefault();
      e.stopPropagation();
      this.#activateTab(this.#tabs[next].id);
      this.#tabs[next].button.focus();
    });
    const saved = uiState.get('readerTab', 'translation');
    this.#activateTab(tabs.some((t) => t.id === saved) ? saved : 'translation');
  }

  /** ctx.openPanel: switch the right-pane tab (and make the right pane visible). */
  #openPanel(id) {
    if (!this.#tabs.some((t) => t.id === id)) {
      console.warn('[reader-view] unknown panel', id);
      return false;
    }
    if (this.#viewMode !== 'side') this.#setViewMode('side');
    this.#activateTab(id);
    uiState.set('readerTab', id);
    return true;
  }

  #activateTab(id) {
    this.#activeTab = id;
    for (const tab of this.#tabs) {
      const on = tab.id === id;
      tab.button.setAttribute('aria-selected', String(on));
      tab.button.tabIndex = on ? 0 : -1;
      tab.el.hidden = !on;
    }
    const tab = this.#tabs.find((t) => t.id === id);
    if (tab?.spec) this.#ensurePanelMounted(tab);
  }

  #ensurePanelMounted(tab) {
    const existing = this.#panelInstances.get(tab.id);
    if (existing) { safely(() => existing.onShow?.()); return; }
    const placeholder = {};
    this.#panelInstances.set(tab.id, placeholder);
    const fail = (err) => {
      console.warn('[reader-view] panel mount', tab.id, err);
      tab.el.replaceChildren(el('div', { class: 'panel-error', role: 'alert' }, `‘${tab.title}’ 패널을 여는 중 오류가 발생했습니다: ${err?.message || err}`));
    };
    try {
      const result = tab.spec.mount(tab.el, this.#ctx);
      if (result && typeof result.then === 'function') {
        result.then((inst) => {
          if (this.#destroyed) { safely(() => inst?.destroy?.()); return; }
          this.#panelInstances.set(tab.id, inst || {});
          if (this.#activeTab === tab.id) safely(() => inst?.onShow?.());
        }, fail);
      } else {
        this.#panelInstances.set(tab.id, result || {});
        safely(() => result?.onShow?.());
      }
    } catch (err) {
      fail(err);
    }
  }

  // ---------------------------------------------------------------- wiring

  #on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.#cleanup.push(() => target.removeEventListener(type, fn, opts));
  }

  #wireViewer() {
    const v = this.#viewer;
    this.#on(v, 'sentencehover', (e) => this.#onViewerHover(e.detail?.sid ?? null));
    this.#on(v, 'sentenceclick', (e) => { if (e.detail?.sid) this.#selectSentence(e.detail.sid, 'viewer'); });
    this.#on(v, 'pagechange', (e) => {
      const page = e.detail?.page;
      if (!Number.isFinite(page)) return;
      this.#setPageLabel(page);
      this.#rememberPageSoon(page);
    });
    this.#on(v, 'visiblesentences', (e) => this.#onVisibleSentences(e.detail?.sids));
    const zoomLabel = rafThrottle(() => this.#updateZoomLabel());
    this.#on(v, 'rendered', zoomLabel);
    // Optional viewer event (e.g. Ctrl+wheel zoom inside the viewer).
    this.#on(v, 'zoomchange', (e) => {
      if (e.detail?.mode) this.#fitWidth = e.detail.mode === 'fit-width';
      zoomLabel();
    });
  }

  #wirePane() {
    const pane = this.#pane;
    const els = this.#els;
    this.#on(pane, 'sentencehover', (e) => {
      const sid = e.detail?.sid ?? null;
      this.#hoverSid = sid;
      safely(() => this.#viewer?.setHoverSentence(sid));
    });
    this.#on(pane, 'sentenceclick', (e) => { if (e.detail?.sid) this.#selectSentence(e.detail.sid, 'pane'); });
    this.#on(pane, 'retry', (e) => { if (e.detail?.sids?.length) this.#runTranslation('sids', e.detail.sids); });
    const markUserScroll = () => { this.#paneUserScrollAt = performance.now(); };
    for (const type of ['wheel', 'touchmove', 'keydown']) this.#on(els.tpHost, type, markUserScroll, { passive: true });
    this.#on(els.right, 'pointerenter', () => { this.#pointerInPane = true; });
    this.#on(els.right, 'pointerleave', () => { this.#pointerInPane = false; });
  }

  #wireTranslator() {
    const tr = this.#translator;
    this.#on(tr, 'update', (e) => {
      const sids = e.detail?.sids;
      this.#syncPaneMap(false);
      this.#pane.update(sids);
      // Optional detail from the AI module: sentences that just failed for good.
      for (const sid of e.detail?.failed || []) this.#pane.setStatus(sid, 'failed');
      if (this.#viewMode === 'overlay') this.#refreshOverlaySoon();
      this.#refreshProgress();
    });
    this.#on(tr, 'progress', () => { this.#refreshProgress(); this.#scheduleCounts(); });
    this.#on(tr, 'error', (e) => {
      const d = e.detail || {};
      for (const sid of d.sids || []) this.#pane.setStatus(sid, 'failed');
      this.#reportError(d.message, d.fatal);
    });
    // Optional event from the AI module: a batch went in flight.
    this.#on(tr, 'pending', (e) => {
      for (const sid of e.detail?.sids || []) if (!this.#translator.translations.has(sid)) this.#pane.setStatus(sid, 'pending');
    });
    this.#on(tr, 'done', () => {
      if (!this.#runs.size) { this.#refreshProgress(); return; }
      for (const run of [...this.#runs]) {
        run.doneSeen = true;
        if (run.settled) this.#finishRun(run);
      }
    });
  }

  #wireGlobal() {
    this.#on(document, 'keydown', (e) => this.#onKeyDown(e));
    const onResize = debounce(() => this.#refit(), 200);
    this.#on(window, 'resize', onResize);
    this.#cleanup.push(() => onResize.cancel());
    this.#cleanup.push(bus.on('settings:change', ({ patch }) => this.#onSettingsChange(patch)));
    this.#on(this.#lib, 'change', () => {
      const paper = this.#lib.getPaper(this.#paperId);
      if (paper) this.#setTitle(paper);
    });
    // Sentences translated on another device (or tab) while this paper is open.
    const sync = this.#lib.sync;
    if (sync?.addEventListener) {
      const path = `papers/${this.#paperId}/translation.json`;
      this.#on(sync, 'remotechange', (e) => {
        if (e.detail?.paths?.includes(path)) this.#mergeRemoteTranslations();
      });
    }

    // [p3-12] sentence links rendered anywhere in the reader (summary, chat, notes…)
    const sidLink = (t) => /** @type {Element} */ (t)?.closest?.('.sid-link[data-sid]');
    this.#on(this.#root, 'click', (e) => {
      const link = sidLink(e.target);
      if (!link) return;
      e.preventDefault();
      this.#jumpToSentence(link.dataset.sid);
    });
    this.#on(this.#root, 'keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const link = sidLink(e.target);
      if (!link) return;
      e.preventDefault();
      this.#jumpToSentence(link.dataset.sid);
    });
    this.#on(this.#root, 'pointerover', (e) => {
      const link = sidLink(e.target);
      if (!link) return;
      safely(() => this.#viewer?.setHoverSentence(link.dataset.sid));
      this.#pane?.setHoverSentence(link.dataset.sid);
    });
    this.#on(this.#root, 'pointerout', (e) => {
      const link = sidLink(e.target);
      if (!link || link.contains(/** @type {Node} */ (e.relatedTarget))) return;
      safely(() => this.#viewer?.setHoverSentence(null));
      this.#pane?.setHoverSentence(null);
    });
  }

  #onSettingsChange(patch) {
    if (!patch || patch.ui?.syncScroll !== undefined) {
      this.#els.syncBtn?.setAttribute('aria-pressed', String(Boolean(settings.get().ui.syncScroll)));
    }
    if (!patch || patch.translate) {
      this.#pane?.update();
      this.#refreshProgress();
    }
  }

  // ------------------------------------------------------- hover / select

  #onViewerHover(sid) {
    this.#hoverSid = sid;
    this.#pane.setHoverSentence(sid);
    safely(() => this.#viewer.setHoverSentence(sid));
    clearTimeout(this.#revealTimer);
    if (!sid || !settings.get().ui.syncScroll || !this.#paneVisible()) return;
    this.#revealTimer = setTimeout(() => {
      if (this.#hoverSid === sid && !this.#pointerInPane) this.#pane.revealSentence(sid);
    }, HOVER_REVEAL_MS);
  }

  #onVisibleSentences(sids) {
    if (!settings.get().ui.syncScroll || !this.#paneVisible() || !Array.isArray(sids)) return;
    if (this.#pointerInPane || performance.now() - this.#paneUserScrollAt < 1200) return;
    const first = sids.find((sid) => this.#pane.getSentenceElement(sid));
    if (!first || first === this.#lastSyncedSid) return;
    this.#lastSyncedSid = first;
    this.#pane.scrollToSentence(first, { block: 'start', flash: false });
  }

  #paneVisible() {
    return this.#viewMode === 'side' && this.#activeTab === 'translation';
  }

  #selectSentence(sid, from) {
    this.#activeSid = sid;
    safely(() => this.#viewer.setActiveSentence(sid));
    this.#pane.setActiveSentence(sid);
    if (from === 'viewer') {
      if (this.#paneVisible()) this.#pane.scrollToSentence(sid, { block: 'center', flash: true });
    } else {
      safely(() => this.#viewer.scrollToSentence(sid, { block: 'center', flash: true }));
    }
  }

  /** ctx.jumpToSentence: scroll both panes to a sentence and flash it. */
  #jumpToSentence(sid) {
    if (!sid || !this.#doc?.sentenceById?.has(sid)) {
      toast('해당 문장을 찾을 수 없습니다.', { kind: 'warning' });
      return false;
    }
    this.#activeSid = sid;
    safely(() => this.#viewer.setActiveSentence(sid));
    this.#pane.setActiveSentence(sid);
    safely(() => this.#viewer.scrollToSentence(sid, { block: 'center', flash: true }));
    this.#pane.scrollToSentence(sid, { block: 'center', flash: true });
    return true;
  }

  #clearActive() {
    this.#activeSid = null;
    safely(() => this.#viewer?.setActiveSentence(null));
    this.#pane?.setActiveSentence(null);
  }

  #onKeyDown(e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || hasOpenLayer() || !this.#viewer) return;
    const target = /** @type {HTMLElement} */ (e.target);
    if (isTypingTarget(target)) return;
    const inRight = this.#els.right?.contains(target);
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowLeft':
        if (target.closest?.('[role="tablist"], [role="separator"], .segmented, .menu')) return;
        e.preventDefault();
        this.#stepPage(e.key === 'ArrowRight' ? 1 : -1);
        break;
      case 'PageDown':
      case 'PageUp':
        if (inRight) return; // let the pane scroll natively
        e.preventDefault();
        this.#stepPage(e.key === 'PageDown' ? 1 : -1);
        break;
      case '+':
      case '=':
        e.preventDefault();
        this.#zoom('in');
        break;
      case '-':
      case '_':
        e.preventDefault();
        this.#zoom('out');
        break;
      case '0':
        e.preventDefault();
        this.#zoom('fit');
        break;
      case 'Escape':
        if (this.#activeSid) { e.preventDefault(); this.#clearActive(); }
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ translate

  async #runTranslation(kind, sids = []) {
    const tr = this.#translator;
    if (!this.#canTranslate()) { toast(this.#unavailableReason(), { kind: 'warning' }); return; }
    if (!settings.isAiReady()) { this.#promptAiSetup(); return; }
    // Retrying single sentences may join a running translation; a second full run may not.
    if (kind !== 'sids' && this.#runs.size) { toast('번역이 이미 진행 중입니다.', { kind: 'warning' }); return; }
    const requested = this.#requestedSids(kind, sids);
    if (!requested.length) {
      toast(kind === 'page' ? '이 페이지에는 새로 번역할 문장이 없습니다.' : '새로 번역할 문장이 없습니다.');
      return;
    }
    const run = { kind, requested, cancelled: false, settled: false, doneSeen: false, timer: null };
    this.#runs.add(run);
    for (const sid of requested) this.#pane.setStatus(sid, 'pending');
    this.#refreshProgress();
    let error = null;
    try {
      if (kind === 'all') await tr.translateAll({ startPage: this.#viewer?.currentPage || 1 });
      else if (kind === 'page') await tr.translatePages([this.#viewer?.currentPage || 1]);
      else await tr.translateSids(requested);
    } catch (err) {
      error = err;
    }
    run.settled = true;
    // Normally the promise resolves once its sentences are settled; if it resolved early, wait for 'done'.
    const map = tr.translations;
    const settled = (sid) => map.has(sid) || (typeof tr.statusOf === 'function' && tr.statusOf(sid) !== 'pending');
    if (error || run.doneSeen || run.cancelled || requested.every(settled)) this.#finishRun(run, error);
  }

  #requestedSids(kind, sids) {
    const map = this.#translator.translations;
    if (kind === 'sids') return [...new Set(sids)].filter((sid) => !map.has(sid) && this.#doc.sentenceById.has(sid));
    const page = this.#viewer?.currentPage || 1;
    return this.#doc.sentences
      .filter((s) => isTranslatableSentence(s) && !map.has(s.sid) && (kind !== 'page' || s.page === page || s.pages?.includes(page)))
      .map((s) => s.sid);
  }

  #finishRun(run, error = null) {
    if (!this.#runs.delete(run)) return;
    clearTimeout(run.timer);
    const tr = this.#translator;
    const map = tr.translations;
    const statusOf = typeof tr.statusOf === 'function' ? (sid) => tr.statusOf(sid) : null;
    let failed = 0;
    for (const sid of run.requested) {
      if (map.has(sid)) { this.#pane.setStatus(sid, null); continue; }
      const status = statusOf ? statusOf(sid) : (run.cancelled ? null : 'failed');
      if (status === 'pending' && !run.cancelled) continue; // still owned by another request
      if (status === 'failed' && !run.cancelled) { this.#pane.setStatus(sid, 'failed'); failed++; }
      else this.#pane.setStatus(sid, null); // cancelled, or dropped before it was attempted
    }
    this.#syncPaneMap(false);
    this.#pane.update(run.requested);
    this.#refreshProgress();
    this.#refreshOverlay();
    this.#scheduleCounts();
    if (run.cancelled) toast('번역을 중지했습니다. 지금까지 번역한 문장은 저장됩니다.');
    else if (error) this.#reportError(error.message || '번역 중 오류가 발생했습니다.', true);
    else if (failed) toast(`${failed}개 문장을 번역하지 못했습니다. 문장 옆 ‘다시 시도’나 번역 메뉴에서 다시 번역할 수 있습니다.`, { kind: 'warning', timeout: 7000 });
    else if (!this.#runs.size) toast('번역을 마쳤습니다.', { kind: 'success' });
  }

  #cancelTranslation() {
    if (!this.#runs.size) return;
    safely(() => this.#translator.cancel());
    for (const run of [...this.#runs]) {
      run.cancelled = true;
      if (run.settled) this.#finishRun(run);
      else run.timer = setTimeout(() => this.#finishRun(run), 1500); // in case the promise never settles
    }
  }

  #reportError(message, fatal = false) {
    const text = message || '번역 중 오류가 발생했습니다.';
    const now = Date.now();
    if (this.#lastError.message === text && now - this.#lastError.at < 6000) return;
    this.#lastError = { message: text, at: now };
    toast(text, { kind: fatal ? 'error' : 'warning', timeout: fatal ? 9000 : 5000 });
  }

  #promptAiSetup() {
    modal({
      title: 'AI 연결이 필요합니다',
      size: 'sm',
      body: el('div', {},
        el('p', {}, '번역하려면 설정에서 Claude 또는 Gemini API 키를 입력하고 모델을 선택하세요.'),
        el('p', { class: 'field-hint' }, 'API 키는 이 브라우저에만 저장되며 해당 AI 서비스로만 전송됩니다.')),
      actions: [
        { label: '나중에' },
        { label: '설정 열기', kind: 'primary', onClick: () => this.#navigate('#/settings') },
      ],
    });
  }

  async #mergeRemoteTranslations() {
    if (typeof this.#translator?.mergeCached !== 'function') return;
    const cached = await this.#loadData('translation');
    if (this.#destroyed || !cached) return;
    const added = this.#translator.mergeCached(cached);
    if (added.length) this.#scheduleCounts();
  }

  #flushTranslationSave() {
    const obj = this.#pendingTranslation;
    if (!obj) return;
    this.#pendingTranslation = null;
    Promise.resolve()
      .then(() => this.#lib.savePaperData(this.#paperId, 'translation', obj))
      .catch((err) => {
        console.warn('[reader-view] save translation', err);
        toast(`번역 결과를 저장하지 못했습니다: ${err?.message || err}`, { kind: 'error' });
      });
  }

  #scheduleCounts() {
    if (this.#countsTimer) return;
    this.#countsTimer = setTimeout(() => { this.#countsTimer = null; this.#flushCounts(); }, 2500);
  }

  /** Keep the library's per-paper progress (translatedCount / sentenceCount) in step. */
  #flushCounts(extra = {}) {
    const paper = this.#lib.getPaper(this.#paperId);
    if (!paper || !this.#translator) return;
    const { done = 0, total = 0 } = this.#translator.progress || {};
    const patch = { ...extra };
    if (paper.translatedCount !== done) patch.translatedCount = done;
    if (paper.sentenceCount !== total) patch.sentenceCount = total;
    if (!Object.keys(patch).length) return;
    try { this.#lib.updatePaper(this.#paperId, patch); } catch (err) { console.warn('[reader-view] updatePaper', err); }
  }

  // ---------------------------------------------------------- body states

  #showLoading(text, ratio = null) {
    const bar = ratio == null ? null : progressBar(ratio, { label: '진행률' });
    this.#els.loadingBar = bar;
    this.#els.body.replaceChildren(el('div', { class: 'reader-loading', role: 'status' },
      el('div', { class: 'reader-loading-card' }, spinner(24), el('span', {}, text), bar?.el)));
  }

  #showNotFound() {
    document.title = '논문을 찾을 수 없음 · 논문 리더';
    this.#els.body.replaceChildren(messageScreen({
      iconName: 'file', tone: 'info', title: '논문을 찾을 수 없습니다',
      message: '삭제되었거나 아직 이 기기로 동기화되지 않은 논문입니다.',
      actions: [{ label: '라이브러리로', kind: 'primary', icon: 'arrow-left', onClick: () => this.#navigate('#/') }],
    }));
  }

  #showError(err) {
    if (this.#destroyed) return;
    console.warn('[reader-view] open failed', err);
    const raw = err?.message || String(err);
    const korean = /[가-힣]/.test(raw);
    const details = [err?.details, korean ? '' : raw, err?.stack].filter(Boolean).join('\n\n');
    this.#els.body.replaceChildren(messageScreen({
      title: '논문을 열 수 없습니다',
      message: korean ? raw : 'PDF를 여는 중 문제가 발생했습니다. 파일이 손상되었거나 지원하지 않는 형식일 수 있습니다.',
      details,
      actions: [
        { label: '라이브러리로', icon: 'arrow-left', onClick: () => this.#navigate('#/') },
        { label: '다시 시도', kind: 'primary', icon: 'refresh', onClick: () => location.reload() },
      ],
    }));
  }
}

/**
 * Stand-in used when js/ai/translator.js failed to load: shows valid cached translations, cannot translate.
 */
class OfflineTranslator extends EventTarget {
  available = false;
  #translations = new Map();
  #total = 0;

  constructor(doc, cached) {
    super();
    const items = cached?.items || {};
    for (const s of doc?.sentences || []) {
      if (isTranslatableSentence(s)) this.#total++;
      const item = items[s.sid];
      if (item?.t && item.h === hash(s.text)) this.#translations.set(s.sid, item.t);
    }
  }

  get translations() { return this.#translations; }
  get progress() { return { done: this.#translations.size, total: this.#total, costUsd: 0 }; }
  async translateAll() { throw new Error('번역 모듈을 불러오지 못해 번역할 수 없습니다.'); }
  async translatePages() { return this.translateAll(); }
  async translateSids() { return this.translateAll(); }
  cancel() {}
}

function safely(fn) {
  try { return fn(); } catch (err) { console.warn('[reader-view]', err); return undefined; }
}

function isTypingTarget(t) {
  return Boolean(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
}
