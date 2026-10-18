// Shared UI primitives: toast, modal, confirm/prompt dialogs, popover, context menu, markdown, spinner.
// Overlays (modal / popover / menu) share one layer stack so Esc and outside clicks close only the topmost one.
import { STORAGE_KEYS, VENDOR } from '../core/config.js';
import { clamp, el, safeStorage, uid } from '../core/util.js';
import { icon } from './icons.js';

// ---------------------------------------------------------------------------
// Per-browser UI state (split ratio, view mode, selected folder…) in localStorage[STORAGE_KEYS.ui]
// ---------------------------------------------------------------------------

export const uiState = {
  get(key, fallback = null) {
    const all = safeStorage.get(STORAGE_KEYS.ui, {});
    return all && typeof all === 'object' && key in all ? all[key] : fallback;
  },
  set(key, value) {
    const all = safeStorage.get(STORAGE_KEYS.ui, {}) || {};
    all[key] = value;
    safeStorage.set(STORAGE_KEYS.ui, all);
  },
};

// ---------------------------------------------------------------------------
// Layer stack
// ---------------------------------------------------------------------------

/** @typedef {{ el: HTMLElement, close: (reason?: string) => void, modal?: boolean, ignore?: Element[] }} Layer */
/** @type {Layer[]} */
const layers = [];
let layerListenersInstalled = false;

function pushLayer(layer) {
  installLayerListeners();
  layers.push(layer);
}

function removeLayer(layer) {
  const i = layers.indexOf(layer);
  if (i >= 0) layers.splice(i, 1);
}

/** True while any modal, popover or menu is open (lets views skip their own Esc handling). */
export function hasOpenLayer() {
  return layers.length > 0;
}

/** Close every open overlay (e.g. on route change). */
export function closeAllLayers() {
  for (const layer of [...layers].reverse()) layer.close('route');
}

function installLayerListeners() {
  if (layerListenersInstalled) return;
  layerListenersInstalled = true;
  // Capture phase so Esc reaches the topmost overlay before any view-level shortcut.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !layers.length) return;
    e.preventDefault();
    e.stopPropagation();
    layers[layers.length - 1].close('escape');
  }, true);
  document.addEventListener('pointerdown', (e) => {
    const target = /** @type {Node} */ (e.target);
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (layer.modal) break; // modals close through their own backdrop
      if (layer.el.contains(target) || layer.ignore?.some((n) => n?.contains?.(target))) break;
      layer.close('outside');
    }
  }, true);
}

// ---------------------------------------------------------------------------
// Buttons & small building blocks (used by the shell views; available to features)
// ---------------------------------------------------------------------------

/**
 * Standard button.
 * @param {string} label  visible text ('' for icon-only — then `title` is required)
 * @param {{ icon?: string, kind?: 'primary'|'danger'|'default'|'ghost'|'subtle', size?: 'sm'|'md',
 *           title?: string, onClick?: (e: MouseEvent) => void, type?: string, className?: string,
 *           disabled?: boolean, pressed?: boolean }} [opts]
 */
export function button(label, { icon: iconName, kind = 'default', size = 'md', title, onClick, type = 'button',
  className = '', disabled = false, pressed } = {}) {
  const iconOnly = !label;
  const node = el('button', {
    type,
    class: ['btn', `btn-${kind}`, size === 'sm' && 'btn-sm', iconOnly && 'btn-icon', className].filter(Boolean).join(' '),
    title: title || null,
    'aria-label': iconOnly ? title : null,
    'aria-pressed': pressed == null ? null : String(Boolean(pressed)),
    disabled,
    onclick: onClick,
  }, iconName ? icon(iconName, { size: size === 'sm' ? 16 : 18 }) : null, label ? el('span', { class: 'btn-label' }, label) : null);
  return node;
}

/** Icon-only button with an accessible label. */
export function iconButton(iconName, label, onClick, opts = {}) {
  return button('', { ...opts, icon: iconName, title: label, onClick, kind: opts.kind || 'ghost' });
}

/** Indeterminate-capable progress bar. `set(ratio)` with ratio in [0,1]. */
export function progressBar(ratio = 0, { label = '진행률' } = {}) {
  const fill = el('span', { class: 'progress-fill' });
  const node = el('span', { class: 'progress', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  const set = (r) => {
    const pct = Math.round(clamp(Number(r) || 0, 0, 1) * 100);
    fill.style.width = `${pct}%`;
    node.setAttribute('aria-valuenow', String(pct));
  };
  set(ratio);
  return { el: node, set };
}

/** Full-area message screen used for errors, empty and not-found states. */
export function messageScreen({ iconName = 'alert-circle', tone = 'error', title, message, details, actions = [] }) {
  return el('div', { class: `message-screen tone-${tone}`, role: tone === 'error' ? 'alert' : null },
    el('div', { class: 'message-card' },
      el('div', { class: 'message-icon' }, icon(iconName, { size: 28 })),
      el('h1', { class: 'message-title' }, title),
      message ? el('p', { class: 'message-text' }, message) : null,
      details ? el('details', { class: 'message-details' },
        el('summary', {}, '자세한 정보'),
        el('pre', {}, details)) : null,
      actions.length ? el('div', { class: 'message-actions' },
        actions.map((a) => button(a.label, { kind: a.kind || 'default', icon: a.icon, onClick: a.onClick }))) : null));
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastRegion = null;
const TOAST_ICONS = { info: 'info', success: 'check-circle', error: 'alert-circle', warning: 'alert-triangle' };
const MAX_TOASTS = 4;

function getToastRegion() {
  if (!toastRegion || !toastRegion.isConnected) {
    toastRegion = el('div', { class: 'toast-region', role: 'region', 'aria-label': '알림' });
    document.body.append(toastRegion);
  }
  return toastRegion;
}

/**
 * Show a transient notification.
 * @param {string} message
 * @param {{ kind?: 'info'|'success'|'error'|'warning', timeout?: number, action?: { label: string, onClick: () => void } }} [opts]
 *   timeout 0 keeps the toast until it is closed.
 * @returns {{ close: () => void, update: (message: string, kind?: string) => void, el: HTMLElement }}
 */
export function toast(message, { kind = 'info', timeout = 3500, action } = {}) {
  const region = getToastRegion();
  const msg = el('div', { class: 'toast-msg' }, String(message ?? ''));
  const iconWrap = el('span', { class: 'toast-icon' }, icon(TOAST_ICONS[kind] || 'info', { size: 18 }));
  const node = el('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, iconWrap, msg);
  let timer = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 160);
  };
  const arm = () => {
    clearTimeout(timer);
    if (timeout > 0) timer = setTimeout(close, timeout);
  };

  if (action) {
    node.append(button(action.label, { kind: 'subtle', size: 'sm', className: 'toast-action', onClick: () => { close(); action.onClick?.(); } }));
  }
  node.append(iconButton('x', '알림 닫기', close, { size: 'sm', className: 'toast-close' }));
  node.addEventListener('pointerenter', () => clearTimeout(timer));
  node.addEventListener('pointerleave', arm);

  while (region.children.length >= MAX_TOASTS) region.firstElementChild.remove();
  region.append(node);
  arm();

  return {
    el: node,
    close,
    update(text, newKind) {
      msg.textContent = String(text ?? '');
      if (newKind && newKind !== kind) {
        node.classList.replace(`toast-${kind}`, `toast-${newKind}`);
        kind = newKind;
        iconWrap.replaceChildren(icon(TOAST_ICONS[kind] || 'info', { size: 18 }));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Modal & dialogs
// ---------------------------------------------------------------------------

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog. An action closes the modal after its onClick resolves, unless onClick returns `false`.
 * If onClick throws, the error message is shown as a toast and the modal stays open.
 * @param {{ title?: string, body?: Node|string, actions?: Array<{ label: string, kind?: 'primary'|'danger'|'default',
 *           onClick?: (ctx: { close: Function }) => any, autofocus?: boolean }>, onClose?: (reason: string) => void,
 *           size?: 'sm'|'md'|'lg', className?: string }} opts
 * @returns {{ close: (reason?: string) => void, el: HTMLElement }}
 */
export function modal({ title = '', body, actions = [], onClose, size = 'md', className = '' } = {}) {
  const prevFocus = /** @type {HTMLElement|null} */ (document.activeElement);
  const titleId = uid('modal');
  const dialog = el('div', {
    class: ['modal', `modal-${size}`, className].filter(Boolean).join(' '),
    role: 'dialog', 'aria-modal': 'true', tabindex: '-1',
    'aria-labelledby': title ? titleId : null,
    'aria-label': title ? null : '대화 상자',
  });
  const backdrop = el('div', { class: 'modal-backdrop' }, dialog);
  let closed = false;

  const close = (reason = 'close') => {
    if (closed) return;
    closed = true;
    removeLayer(layer);
    backdrop.classList.add('is-leaving');
    setTimeout(() => backdrop.remove(), 140);
    if (prevFocus?.isConnected) prevFocus.focus?.({ preventScroll: true });
    try { onClose?.(reason); } catch (err) { console.warn('[components] modal onClose', err); }
  };
  const layer = { el: dialog, close, modal: true };

  const header = el('div', { class: 'modal-header' },
    title ? el('h2', { class: 'modal-title', id: titleId }, title) : el('span'),
    iconButton('x', '닫기', () => close('dismiss'), { className: 'modal-close' }));
  const bodyWrap = el('div', { class: 'modal-body' }, typeof body === 'string' ? el('p', {}, body) : body);
  dialog.append(header, bodyWrap);

  if (actions.length) {
    const footer = el('div', { class: 'modal-footer' });
    for (const action of actions) {
      const btn = button(action.label, { kind: action.kind || 'default' });
      if (action.autofocus) btn.dataset.autofocus = '';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const result = await action.onClick?.({ close });
          if (result !== false) close('action');
        } catch (err) {
          console.warn('[components] modal action', err);
          toast(err?.message || '작업을 완료하지 못했습니다.', { kind: 'error' });
        } finally {
          btn.disabled = false;
        }
      });
      footer.append(btn);
    }
    dialog.append(footer);
  }

  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close('backdrop'); });
  dialog.addEventListener('keydown', (e) => trapFocus(e, dialog));

  document.body.append(backdrop);
  pushLayer(layer);
  const initial = dialog.querySelector('[data-autofocus], [autofocus]')
    || bodyWrap.querySelector('input, textarea, select')
    || dialog.querySelector('.modal-footer .btn-primary, .modal-footer .btn-danger')
    || dialog;
  /** @type {HTMLElement} */ (initial).focus({ preventScroll: true });
  return { close, el: dialog };
}

function trapFocus(e, container) {
  if (e.key !== 'Tab') return;
  const items = [...container.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/**
 * Yes/no dialog.
 * @returns {Promise<boolean>}
 */
export function confirmDialog(message, { okLabel = '확인', danger = false, title = '', cancelLabel = '취소' } = {}) {
  return new Promise((resolve) => {
    let result = false;
    modal({
      title,
      size: 'sm',
      body: el('p', { class: 'modal-message' }, message),
      actions: [
        { label: cancelLabel, onClick: () => { result = false; } },
        { label: okLabel, kind: danger ? 'danger' : 'primary', autofocus: true, onClick: () => { result = true; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

/**
 * Single-line text input dialog.
 * @returns {Promise<string|null>}  the entered text, or null when cancelled
 */
export function promptDialog(message, { value = '', placeholder = '', okLabel = '확인', title = '' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const input = el('input', { class: 'input', type: 'text', value, placeholder: placeholder || null, 'aria-label': message, autocomplete: 'off', spellcheck: 'false' });
    const body = el('label', { class: 'field' }, el('span', { class: 'field-label' }, message), input);
    const dlg = modal({
      title,
      size: 'sm',
      body,
      actions: [
        { label: '취소', onClick: () => { result = null; } },
        { label: okLabel, kind: 'primary', onClick: () => { result = input.value; } },
      ],
      onClose: () => resolve(result),
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        result = input.value;
        dlg.close('action');
      }
    });
    input.select();
  });
}

// ---------------------------------------------------------------------------
// Popover & context menu
// ---------------------------------------------------------------------------

const GAP = 6;
const EDGE = 8;

/**
 * Floating panel anchored to a rect. Closes on outside pointerdown or Esc.
 * @param {DOMRect|{left:number,top:number,right:number,bottom:number,width:number,height:number}} anchorRect
 * @param {Node} content
 * @param {{ placement?: 'bottom'|'top'|'left'|'right'|'bottom-start'|'bottom-end'|'top-start'|'top-end',
 *           onClose?: (reason: string) => void, className?: string, ignoreOutside?: Element[],
 *           role?: string, label?: string }} [opts]
 * @returns {{ close: (reason?: string) => void, el: HTMLElement, update: (rect?: DOMRect) => void }}
 */
export function popover(anchorRect, content, { placement = 'bottom', onClose, className = '', ignoreOutside = [], role = 'dialog', label } = {}) {
  const node = el('div', { class: ['popover', className].filter(Boolean).join(' '), role, 'aria-label': label || null }, content);
  let rect = anchorRect;
  let closed = false;
  const close = (reason = 'close') => {
    if (closed) return;
    closed = true;
    removeLayer(layer);
    window.removeEventListener('resize', reposition);
    node.remove();
    try { onClose?.(reason); } catch (err) { console.warn('[components] popover onClose', err); }
  };
  const layer = { el: node, close, ignore: ignoreOutside };
  const reposition = () => placeNode(node, rect, placement);

  node.style.visibility = 'hidden';
  document.body.append(node);
  reposition();
  node.style.visibility = '';
  window.addEventListener('resize', reposition);
  pushLayer(layer);
  return {
    close,
    el: node,
    update(newRect) {
      if (newRect) rect = newRect;
      reposition();
    },
  };
}

function placeNode(node, rect, placement) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  const [side, align = 'center'] = placement.split('-');
  let top;
  let left;
  const alignX = () => (align === 'start' ? rect.left : align === 'end' ? rect.right - w : rect.left + rect.width / 2 - w / 2);
  const alignY = () => (align === 'start' ? rect.top : align === 'end' ? rect.bottom - h : rect.top + rect.height / 2 - h / 2);

  if (side === 'top' || side === 'bottom') {
    const below = rect.bottom + GAP;
    const above = rect.top - GAP - h;
    const fitsBelow = below + h <= vh - EDGE;
    const fitsAbove = above >= EDGE;
    top = side === 'bottom' ? (fitsBelow || !fitsAbove ? below : above) : (fitsAbove || !fitsBelow ? above : below);
    left = alignX();
  } else {
    const right = rect.right + GAP;
    const leftPos = rect.left - GAP - w;
    const fitsRight = right + w <= vw - EDGE;
    const fitsLeft = leftPos >= EDGE;
    left = side === 'right' ? (fitsRight || !fitsLeft ? right : leftPos) : (fitsLeft || !fitsRight ? leftPos : right);
    top = alignY();
  }
  node.style.left = `${Math.round(clamp(left, EDGE, Math.max(EDGE, vw - w - EDGE)))}px`;
  node.style.top = `${Math.round(clamp(top, EDGE, Math.max(EDGE, vh - h - EDGE)))}px`;
}

let activeMenu = null;

/**
 * Context menu at viewport coordinates. Keyboard: ↑/↓/Home/End move, Enter/Space activate, Esc/Tab close.
 * @param {Array<{ label: string, icon?: string, onClick?: () => void, danger?: boolean, disabled?: boolean } | { note: string } | 'sep'>} items
 *   `{ note }` renders a non-interactive line of small print (e.g. usage info).
 * @param {number} x
 * @param {number} y
 * @returns {{ close: () => void }}
 */
export function contextMenu(items, x, y) {
  activeMenu?.close('replaced');
  const prevFocus = /** @type {HTMLElement|null} */ (document.activeElement);
  const menu = el('div', { class: 'menu', role: 'menu' });
  let closed = false;
  const close = (reason = 'close') => {
    if (closed) return;
    closed = true;
    removeLayer(layer);
    menu.remove();
    if (activeMenu === handle) activeMenu = null;
    if (reason === 'escape' && prevFocus?.isConnected) prevFocus.focus({ preventScroll: true });
  };
  const layer = { el: menu, close };
  const handle = { close };

  for (const item of items) {
    if (item === 'sep') { menu.append(el('div', { class: 'menu-sep', role: 'separator' })); continue; }
    if (item && 'note' in item) { menu.append(el('div', { class: 'menu-footer', role: 'presentation' }, item.note)); continue; }
    const btn = el('button', {
      type: 'button', role: 'menuitem', tabindex: '-1',
      class: `menu-item${item.danger ? ' is-danger' : ''}`,
      disabled: Boolean(item.disabled),
    }, el('span', { class: 'menu-icon' }, item.icon ? icon(item.icon, { size: 16 }) : null), el('span', { class: 'menu-label' }, item.label));
    btn.addEventListener('click', () => {
      close('select');
      try { item.onClick?.(); } catch (err) { console.warn('[components] menu item', err); }
    });
    menu.append(btn);
  }

  menu.addEventListener('keydown', (e) => {
    const enabled = [...menu.querySelectorAll('.menu-item:not([disabled])')];
    const i = enabled.indexOf(/** @type {Element} */ (document.activeElement));
    let next = null;
    if (e.key === 'ArrowDown') next = enabled[(i + 1) % enabled.length];
    else if (e.key === 'ArrowUp') next = enabled[(i - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    else if (e.key === 'Tab') { e.preventDefault(); close('tab'); return; }
    if (next) { e.preventDefault(); /** @type {HTMLElement} */ (next).focus(); }
  });
  menu.addEventListener('contextmenu', (e) => e.preventDefault());

  menu.style.visibility = 'hidden';
  document.body.append(menu);
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = x + w > window.innerWidth - EDGE ? x - w : x;
  const top = y + h > window.innerHeight - EDGE ? y - h : y;
  menu.style.left = `${Math.round(clamp(left, EDGE, Math.max(EDGE, window.innerWidth - w - EDGE)))}px`;
  menu.style.top = `${Math.round(clamp(top, EDGE, Math.max(EDGE, window.innerHeight - h - EDGE)))}px`;
  menu.style.visibility = '';
  pushLayer(layer);
  activeMenu = handle;
  /** @type {HTMLElement|null} */ (menu.querySelector('.menu-item:not([disabled])'))?.focus({ preventScroll: true });
  return handle;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

let markdownLibs = null;

function loadMarkdownLibs() {
  if (!markdownLibs) {
    markdownLibs = Promise.all([import(VENDOR.marked), import(VENDOR.dompurify)])
      .then(([markedMod, purifyMod]) => ({
        marked: new markedMod.Marked({ gfm: true, breaks: true, async: false, extensions: [CJK_STRONG_EXTENSION] }),
        // A private DOMPurify instance, so hooks/config elsewhere can never weaken ours.
        purify: purifyMod.default(window),
      }))
      .catch((err) => {
        markdownLibs = null;
        console.warn('[components] markdown libs', err);
        throw new Error('문서 표시 모듈을 불러오지 못했습니다.');
      });
  }
  return markdownLibs;
}

// CommonMark's flanking rules reject `**41%**에서`: a closing `**` right after punctuation must be followed by
// whitespace or punctuation, but Korean particles attach directly to the word. Model output does this all the
// time, so a bold run that touches a CJK character on either side is tokenized leniently; everything else keeps
// the standard rules. The result is an ordinary `strong` token, so escaping and sanitizing are unchanged.
const CJK_CHAR = /[\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u3400-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;
const CJK_STRONG = /^\*\*(?![\s*])((?:\\.|[^*\n\\]|\*(?!\*))+?)(?<![\s\\])\*\*/;
const CJK_STRONG_EXTENSION = {
  name: 'cjkStrong',
  level: 'inline',
  start(src) {
    const i = src.indexOf('**');
    return i < 0 ? undefined : i;
  },
  tokenizer(src, tokens) {
    const m = CJK_STRONG.exec(src);
    if (!m) return undefined;
    const prev = tokens?.at(-1)?.raw?.slice(-1) || '';
    if (!CJK_CHAR.test(prev) && !CJK_CHAR.test(src.charAt(m[0].length))) return undefined;
    return { type: 'strong', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
  },
};

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'object', 'embed', 'base', 'link', 'meta'],
  FORBID_ATTR: ['style', 'id', 'name', 'srcset', 'action', 'formaction'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/(?:png|jpe?g|gif|webp);)/i,
  RETURN_DOM_FRAGMENT: true,
};
const SAFE_LINK = /^(?:https?:|mailto:)/i;
const SAFE_IMG = /^data:image\/(?:png|jpe?g|gif|webp);/i;
const SID_GROUP = /\[\s*(p\d+-\d+(?:\s*[,;]\s*p\d+-\d+)*)\s*\]/g;

/**
 * Render untrusted Markdown (model output) to a sanitized fragment.
 * marked → DOMPurify (private instance) → link/image hardening → optional [p3-12] sentence links.
 * @param {string} md
 * @param {{ sentenceLinks?: boolean }} [opts]
 * @returns {Promise<DocumentFragment>}
 */
export async function renderMarkdown(md, { sentenceLinks = true } = {}) {
  const { marked, purify } = await loadMarkdownLibs();
  const html = marked.parse(String(md ?? ''));
  /** @type {DocumentFragment} */
  const frag = purify.sanitize(html, PURIFY_CONFIG);
  hardenLinks(frag); // while still inert (DOMPurify's own document), before anything can load
  const out = document.importNode(frag, true);
  for (const table of out.querySelectorAll('table')) {
    const wrap = el('div', { class: 'md-table-wrap' });
    table.replaceWith(wrap);
    wrap.append(table);
  }
  if (sentenceLinks) linkifySentenceIds(out);
  return out;
}

function hardenLinks(root) {
  for (const a of root.querySelectorAll('a')) {
    const href = a.getAttribute('href') || '';
    if (SAFE_LINK.test(href.trim())) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      // In-page anchors would hijack the hash router; anything else is unsafe.
      a.removeAttribute('href');
    }
  }
  for (const img of root.querySelectorAll('img')) {
    if (!SAFE_IMG.test(img.getAttribute('src') || '')) img.remove();
  }
}

function linkifySentenceIds(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.includes('[')) return NodeFilter.FILTER_REJECT;
      return node.parentElement?.closest('a, code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  for (const textNode of targets) {
    const text = textNode.nodeValue;
    SID_GROUP.lastIndex = 0;
    if (!SID_GROUP.test(text)) continue;
    SID_GROUP.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(SID_GROUP)) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const sids = m[1].split(/\s*[,;]\s*/);
      sids.forEach((sid, i) => {
        if (i) frag.append(' ');
        frag.append(sentenceLink(sid));
      });
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    textNode.replaceWith(frag);
  }
}

function sentenceLink(sid) {
  const page = sid.slice(1, sid.indexOf('-'));
  return el('a', {
    class: 'sid-link', 'data-sid': sid, role: 'link', tabindex: '0',
    title: `${page}쪽 해당 문장으로 이동`,
  }, sid);
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

/** Small loading indicator. */
export function spinner(size = 16) {
  return el('span', {
    class: 'spinner', role: 'status', 'aria-label': '불러오는 중',
    style: { width: `${size}px`, height: `${size}px` },
  });
}
