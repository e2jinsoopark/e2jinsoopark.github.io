// Floating menu for a PDF text selection (하이라이트 4색 / 메모 / AI 설명 / 번역 / 채팅에 질문 / 복사)
// and for a click on an existing highlight (색 변경 / 메모 / AI 설명 / 채팅에 질문 / 복사 / 삭제).
import { el, rafThrottle } from '../core/util.js';
import { popover, renderMarkdown, spinner, toast } from '../ui/components.js';
import { quickTranslate } from '../ai/tasks.js';
import { removeWithUndo } from './annotations.js';
import { explainSelection } from './explain.js';
import {
  AI_NOT_READY_MESSAGE, HIGHLIGHT_COLORS, anySignal, clip, copyText, errorMessage, isAbortError,
  pointRect, toRect,
} from './shared.js';

const MARK_CLICK_DEDUPE_MS = 400;

function clearSelection() {
  try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
}

function hasTextSelection() {
  const sel = window.getSelection?.();
  return Boolean(sel && !sel.isCollapsed && sel.toString().trim());
}

function actionButton(label, action, onClick, { danger = false, title } = {}) {
  return el('button', {
    type: 'button', class: `pf-selmenu__btn${danger ? ' is-danger' : ''}`, dataset: { action }, title, onclick: onClick,
  }, label);
}

function colorButtons(current, onPick) {
  return el('div', { class: 'pf-selmenu__colors', role: 'group', 'aria-label': '하이라이트 색' },
    HIGHLIGHT_COLORS.map((c) => el('button', {
      type: 'button', class: `pf-swatch-btn pf-swatch--${c.id}${c.id === current ? ' is-active' : ''}`,
      'aria-label': `${c.label} 하이라이트`, title: `${c.label} 하이라이트`, 'aria-pressed': String(c.id === current),
      dataset: { color: c.id }, onclick: () => onPick(c.id),
    })));
}

const sep = () => el('span', { class: 'pf-selmenu__sep', 'aria-hidden': 'true' });

/**
 * @param {object} ctx FeatureContext
 * @param {import('./session.js').FeatureSession} session
 */
export function installSelectionMenu(ctx, session, { signal }) {
  const { viewer } = ctx;
  if (!viewer) return;
  const store = session.annotations;
  /** @type {{ kind: 'selection'|'mark'|'note'|'translate', pop: any, abort?: AbortController } | null} */
  let current = null;
  let lastPointer = { x: 0, y: 0 };
  let lastMarkClickAt = 0;

  const close = () => {
    if (!current) return;
    const c = current;
    current = null;
    c.abort?.abort();
    c.pop.close();
  };

  function open(kind, rect, content, extra = {}) {
    close();
    const entry = { kind, ...extra };
    entry.pop = popover(rect, content, {
      placement: 'top',
      className: `pf-pop pf-pop--${kind}`,
      onClose: () => {
        if (current === entry) { current = null; entry.abort?.abort(); }
      },
    });
    current = entry;
    return entry;
  }

  /** Keep the PDF selection alive while the user clicks menu buttons. */
  const keepSelection = (node) => {
    node.addEventListener('mousedown', (e) => { if (!e.target.closest('textarea, input')) e.preventDefault(); });
    return node;
  };

  // --- menus ------------------------------------------------------------------------------

  function openSelectionMenu(anchor) {
    const rect = toRect(anchor.rect);
    if (!rect) return;
    const existing = store.findExact(anchor.start, anchor.end);
    const menu = keepSelection(el('div', { class: 'pf-selmenu', role: 'toolbar', 'aria-label': '선택한 텍스트' },
      colorButtons(existing?.color ?? null, (color) => highlight(anchor, color)),
      sep(),
      actionButton('메모', 'note', () => addNote(anchor)),
      actionButton('AI 설명', 'explain', () => { close(); explainSelection(ctx, session, anchor); }),
      actionButton('번역', 'translate', () => translate(anchor.text, rect)),
      actionButton('채팅에 질문', 'ask', () => askInChat(anchor.text, anchor.start, anchor.end)),
      actionButton('복사', 'copy', () => copy(anchor.text))));
    open('selection', rect, menu);
  }

  function openMarkMenu(item, rect) {
    const menu = keepSelection(el('div', { class: 'pf-selmenu pf-selmenu--mark', role: 'toolbar', 'aria-label': '하이라이트' },
      el('div', { class: 'pf-selmenu__row' },
        colorButtons(item.color, (color) => { store.update(item.id, { color }); close(); }),
        sep(),
        actionButton(item.note ? '메모 편집' : '메모', 'note', () => openNoteEditor(item.id, rect)),
        actionButton('AI 설명', 'explain', () => {
          close();
          explainSelection(ctx, session, { text: item.quote, start: item.anchor.start, end: item.anchor.end, rect });
        }),
        actionButton('채팅에 질문', 'ask', () => askInChat(item.quote, item.anchor.start, item.anchor.end)),
        actionButton('복사', 'copy', () => copy(item.quote)),
        actionButton('삭제', 'delete', () => { close(); removeWithUndo(store, item.id); }, { danger: true })),
      item.note ? el('p', { class: 'pf-selmenu__note' }, clip(item.note, 220)) : null));
    open('mark', rect, menu);
  }

  function openNoteEditor(id, rect) {
    const item = store.get(id);
    if (!item) return;
    const area = el('textarea', { class: 'pf-textarea', rows: '4', placeholder: '메모를 입력하세요 (Ctrl+Enter 저장)', 'aria-label': '메모' });
    area.value = item.note;
    const save = () => { store.update(id, { note: area.value.trim() }); close(); };
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    const content = el('div', { class: 'pf-noteedit' },
      el('div', { class: 'pf-pop__head' }, '메모'),
      el('blockquote', { class: 'pf-pop__quote' }, clip(item.quote, 200)),
      area,
      el('div', { class: 'pf-pop__foot' },
        el('button', { type: 'button', class: 'pf-btn pf-btn--sm', onclick: close }, '취소'),
        el('button', { type: 'button', class: 'pf-btn pf-btn--sm pf-btn--primary', dataset: { action: 'save-note' }, onclick: save }, '저장')));
    open('note', rect, content);
    setTimeout(() => area.focus(), 0);
  }

  function translate(text, rect) {
    const body = el('div', { class: 'pf-qt__body' });
    let result = '';
    const copyBtn = el('button', {
      type: 'button', class: 'pf-btn pf-btn--sm', disabled: true,
      onclick: () => copy(result),
    }, '번역 복사');
    const content = el('div', { class: 'pf-qt' },
      el('div', { class: 'pf-pop__head' }, '빠른 번역'),
      el('blockquote', { class: 'pf-pop__quote' }, clip(text, 240)),
      body,
      el('div', { class: 'pf-pop__foot' }, copyBtn, el('button', { type: 'button', class: 'pf-btn pf-btn--sm', onclick: close }, '닫기')));
    if (!ctx.settings.isAiReady()) {
      body.append(el('p', { class: 'pf-error' }, AI_NOT_READY_MESSAGE));
      open('translate', rect, content);
      return;
    }
    body.append(el('div', { class: 'pf-loading' }, spinner(14), el('span', {}, '번역하는 중…')));
    const abort = new AbortController();
    const entry = open('translate', rect, content, { abort });
    quickTranslate(text, { signal: anySignal(abort.signal, ctx.signal, signal), paperId: ctx.paper?.id })
      .then(async ({ text: ko }) => {
        if (current !== entry) return;
        result = String(ko ?? '');
        body.replaceChildren(await renderMarkdown(result, { sentenceLinks: false }));
        copyBtn.disabled = !result;
        entry.pop.update?.(rect);
      })
      .catch((err) => {
        if (isAbortError(err) || current !== entry) return;
        body.replaceChildren(el('p', { class: 'pf-error' }, errorMessage(err, '번역하지 못했습니다.')));
      });
  }

  // --- actions ----------------------------------------------------------------------------

  function highlight(anchor, color) {
    const existing = store.findExact(anchor.start, anchor.end);
    if (existing) store.update(existing.id, { color });
    else store.add({ start: anchor.start, end: anchor.end, quote: anchor.text, color });
    close();
    clearSelection();
  }

  function addNote(anchor) {
    const rect = toRect(anchor.rect);
    const item = store.findExact(anchor.start, anchor.end)
      ?? store.add({ start: anchor.start, end: anchor.end, quote: anchor.text, color: 'yellow' });
    clearSelection();
    openNoteEditor(item.id, rect);
  }

  function askInChat(text, start, end) {
    close();
    clearSelection();
    session.askInChat({ text, start, end });
  }

  async function copy(text) {
    const ok = await copyText(text);
    toast(ok ? '복사했습니다.' : '복사하지 못했습니다.', { kind: ok ? 'success' : 'error' });
    if (current?.kind === 'selection' || current?.kind === 'mark') close();
  }

  // --- highlight hit-testing ----------------------------------------------------------------

  /**
   * Annotation whose mark element is under the last pointer position. Used for viewers that draw
   * clickable `[data-mark-id]` elements instead of emitting 'markclick' (the real viewer emits it,
   * so a click on the unhighlighted part of a partly highlighted sentence opens nothing).
   */
  function annotationAtPointer() {
    for (const node of document.elementsFromPoint(lastPointer.x, lastPointer.y)) {
      const id = node.dataset?.markId ?? (node.closest?.('[data-layer="annotations"]') ? node.dataset?.id : undefined);
      const hit = id && store.get(id);
      if (hit) return hit;
    }
    return null;
  }

  // --- wiring -------------------------------------------------------------------------------

  document.addEventListener('pointerdown', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, { capture: true, signal });

  viewer.addEventListener('selectionchange', (e) => {
    const anchor = e.detail?.anchor ?? null;
    if (anchor && anchor.text?.trim() && Number.isFinite(anchor.start) && anchor.end > anchor.start) {
      openSelectionMenu(anchor);
    } else if (current?.kind === 'selection') {
      close();
    }
  }, { signal });

  // The viewer hit-tests its (pointer-transparent) marks and reports clicks on them.
  viewer.addEventListener('markclick', (e) => {
    const { layer, id, clientRect } = e.detail || {};
    if (layer && layer !== 'annotations') return;
    const item = store.get(id);
    if (!item) return;
    lastMarkClickAt = Date.now();
    openMarkMenu(item, toRect(clientRect) ?? pointRect(lastPointer.x, lastPointer.y));
  }, { signal });

  viewer.addEventListener('sentenceclick', (e) => {
    if (Date.now() - lastMarkClickAt < MARK_CLICK_DEDUPE_MS || hasTextSelection()) return;
    if (!ctx.doc?.sentenceById?.has(e.detail?.sid)) return;
    const item = annotationAtPointer();
    if (item) openMarkMenu(item, pointRect(lastPointer.x, lastPointer.y));
  }, { signal });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current && !e.defaultPrevented) close();
  }, { signal });

  // Follow the selection while the PDF scrolls; detached popovers (note/translate) stay put.
  const onScroll = rafThrottle((target) => {
    if (!current || current.pop.el?.contains(target)) return;
    if (current.kind === 'mark') { close(); return; }
    if (current.kind !== 'selection') return;
    const rect = toRect(viewer.getSelectionAnchor?.()?.rect);
    if (rect) current.pop.update?.(rect);
    else close();
  });
  document.addEventListener('scroll', (e) => onScroll(e.target), { capture: true, passive: true, signal });

  signal.addEventListener('abort', close, { once: true });
}
