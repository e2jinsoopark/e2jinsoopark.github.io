// Stub of js/ui/components.js (SPEC 3.5) for the features harness. renderMarkdown uses the
// real vendored marked + DOMPurify, so sanitisation is exercised for real.
import { marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/dompurify/purify.es.mjs';

window.__toasts = [];

export function toast(message, { kind = 'info', timeout = 3500, action } = {}) {
  window.__toasts.push({ message, kind, action: action?.label ?? null });
  let host = document.getElementById('stub-toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'stub-toasts';
    document.body.append(host);
  }
  const t = document.createElement('div');
  t.className = `toast stub-toast stub-toast--${kind}`;
  t.append(document.createTextNode(message));
  const close = () => t.remove();
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => { close(); action.onClick?.(); });
    t.append(b);
  }
  host.append(t);
  if (timeout > 0) setTimeout(close, timeout);
  return { close, el: t, update: (m) => { t.firstChild.data = m; } };
}

export function modal({ title, body, actions = [], onClose } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'stub-overlay';
  const box = document.createElement('div');
  box.className = 'stub-modal';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const h = document.createElement('h3');
  h.textContent = title ?? '';
  box.append(h);
  if (body) box.append(body);
  const row = document.createElement('div');
  row.className = 'stub-modal__actions';
  const close = () => { overlay.remove(); onClose?.(); };
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = a.label;
    b.dataset.kind = a.kind ?? 'default';
    b.addEventListener('click', () => a.onClick?.());
    row.append(b);
  }
  box.append(row);
  overlay.append(box);
  document.body.append(overlay);
  return { close };
}

export function confirmDialog(message, { okLabel = '확인', danger = false } = {}) {
  return new Promise((resolve) => {
    const p = document.createElement('p');
    p.textContent = message;
    let m = null;
    m = modal({
      title: '확인', body: p,
      actions: [
        { label: '취소', onClick: () => { m.close(); resolve(false); } },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => { m.close(); resolve(true); } },
      ],
    });
  });
}

export function promptDialog(message, { value = '', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.value = value;
    input.placeholder = placeholder;
    let m = null;
    m = modal({
      title: message, body: input,
      actions: [
        { label: '취소', onClick: () => { m.close(); resolve(null); } },
        { label: '확인', kind: 'primary', onClick: () => { m.close(); resolve(input.value); } },
      ],
    });
  });
}

export function popover(anchorRect, content, { placement = 'bottom', onClose, className = '' } = {}) {
  const el = document.createElement('div');
  el.className = `stub-pop ${className}`.trim();
  el.append(content);
  document.body.append(el);
  let closed = false;
  const place = (r) => {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let top = placement === 'top' ? r.top - h - 8 : r.bottom + 8;
    if (top < 8) top = r.bottom + 8;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 8);
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    Object.assign(el.style, { top: `${top}px`, left: `${left}px` });
  };
  place(anchorRect);
  const onDown = (e) => { if (!el.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  document.addEventListener('keydown', onKey);
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey);
    el.remove();
    onClose?.();
  }
  return { close, el, update: (r) => place(r ?? anchorRect) };
}

export function contextMenu(items, x, y) {
  const content = document.createElement('div');
  let p = null;
  for (const it of items) {
    if (it === 'sep') { content.append(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.textContent = it.label;
    b.disabled = Boolean(it.disabled);
    b.addEventListener('click', () => { p.close(); it.onClick?.(); });
    content.append(b);
  }
  p = popover(new DOMRect(x, y, 0, 0), content);
  return { close: p.close };
}

const SID_GROUP = /\[((?:p\d+-\d+)(?:\s*[,;]\s*p\d+-\d+)*)\]/g;

function linkSentences(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (t.parentElement?.closest('code, pre, a')) continue;
    if (SID_GROUP.test(t.data)) targets.push(t);
    SID_GROUP.lastIndex = 0;
  }
  for (const t of targets) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of t.data.matchAll(SID_GROUP)) {
      frag.append(t.data.slice(last, m.index));
      for (const sid of m[1].split(/\s*[,;]\s*/)) {
        const a = document.createElement('a');
        a.className = 'sid-link';
        a.dataset.sid = sid;
        a.href = '#';
        a.textContent = `[${sid}]`;
        frag.append(a);
      }
      last = m.index + m[0].length;
    }
    frag.append(t.data.slice(last));
    t.replaceWith(frag);
  }
}

export async function renderMarkdown(md, { sentenceLinks = true } = {}) {
  const html = DOMPurify.sanitize(marked.parse(String(md ?? '')));
  const tpl = document.createElement('template');
  tpl.innerHTML = html; // sanitized above
  if (sentenceLinks) linkSentences(tpl.content);
  return tpl.content;
}

export function spinner(size = 16) {
  const s = document.createElement('span');
  s.className = 'stub-spin';
  s.style.width = s.style.height = `${size}px`;
  s.setAttribute('role', 'status');
  s.setAttribute('aria-label', '로딩 중');
  return s;
}
