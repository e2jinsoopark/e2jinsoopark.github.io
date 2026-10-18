// Helpers shared by the reader features (panels, menus, cards). Pure DOM + data utilities;
// anything that needs app state receives the FeatureContext explicitly.
import { el } from '../core/util.js';
import { renderMarkdown, toast } from '../ui/components.js';

export const HIGHLIGHT_COLORS = Object.freeze([
  { id: 'yellow', label: '노랑' },
  { id: 'green', label: '초록' },
  { id: 'blue', label: '파랑' },
  { id: 'pink', label: '분홍' },
]);
export const COLOR_LABELS = Object.freeze(Object.fromEntries(HIGHLIGHT_COLORS.map((c) => [c.id, c.label])));

export const AI_NOT_READY_MESSAGE = 'AI를 쓰려면 설정에서 초대 코드나 API 키를 먼저 입력해 주세요.';
export const NO_TEXT_MESSAGE = '이 PDF에는 추출할 수 있는 텍스트가 없습니다(스캔본일 수 있습니다).';

/** An AbortSignal that aborts as soon as any of the given signals does. Falsy entries are ignored. */
export function anySignal(...signals) {
  const list = signals.filter(Boolean);
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const ctl = new AbortController();
  for (const s of list) {
    if (s.aborted) { ctl.abort(s.reason); break; }
    s.addEventListener('abort', () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

export function isAbortError(err, signal) {
  return Boolean(signal?.aborted) || err?.name === 'AbortError';
}

export function abortError() {
  return new DOMException('작업이 취소되었습니다.', 'AbortError');
}

/** Resolve after `ms`, rejecting with an AbortError if `signal` aborts first. */
export function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });
}

/** User-presentable message for an error (modules throw Errors with Korean messages). */
export function errorMessage(err, fallback = '알 수 없는 오류가 발생했습니다.') {
  const m = err?.message;
  return typeof m === 'string' && m.trim() ? m.trim() : fallback;
}

/** Timestamps may be epoch ms or ISO strings depending on who wrote them. */
export function toMillis(v) {
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

export function formatDateTime(ts) {
  const ms = toMillis(ts);
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Collapse whitespace and cut to `max` chars with an ellipsis. */
export function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…` : s;
}

/** Normalise a DOMRect-like object ({x,y,width,height} or {left,top,...}) to a DOMRect, or null. */
export function toRect(r) {
  if (!r) return null;
  const x = r.x ?? r.left;
  const y = r.y ?? r.top;
  const w = r.width ?? (r.right != null ? r.right - x : 0);
  const h = r.height ?? (r.bottom != null ? r.bottom - y : 0);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return new DOMRect(x, y, w, h);
}

export function pointRect(x, y) {
  return new DOMRect(x, y, 1, 1);
}

/** Only http(s) URLs from untrusted data may become hrefs. */
export function safeHref(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch { return null; }
}

export function externalLink(href, ...children) {
  const safe = safeHref(href);
  if (!safe) return el('span', {}, ...children);
  return el('a', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, ...children);
}

// --- document geometry -------------------------------------------------------------------

/** Index of the last sentence whose start ≤ offset (sentences are in reading order), or -1. */
export function sentenceIndexAt(doc, offset) {
  const list = doc?.sentences || [];
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= offset) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** The sentence containing (or immediately preceding) a doc offset. */
export function sentenceAt(doc, offset) {
  const i = sentenceIndexAt(doc, offset);
  return i >= 0 ? doc.sentences[i] : (doc?.sentences?.[0] ?? null);
}

/** Page number for a doc offset (same rule as extract.docOffsetToPage, kept local to avoid a hard dependency). */
export function pageAt(doc, offset) {
  const pages = doc?.pages || [];
  for (const p of pages) if (offset < p.textEnd) return p.pageNumber;
  return pages.at(-1)?.pageNumber ?? 1;
}

/** Scroll both panes to the sentence holding `offset`; falls back to the viewer's offset scroll. */
export function jumpToOffset(ctx, offset) {
  const s = sentenceAt(ctx.doc, offset);
  if (s && typeof ctx.jumpToSentence === 'function') ctx.jumpToSentence(s.sid);
  else ctx.viewer?.scrollToOffset?.(offset);
}

export function hasDocText(doc) {
  return Boolean(doc && doc.hasTextLayer !== false && doc.sentences?.length);
}

// --- markdown output ---------------------------------------------------------------------

/**
 * Post-process rendered model output: sentence links become compact page chips (unknown ids are
 * defused into plain text), and external links open safely in a new tab.
 */
export function decorateMarkdown(root, doc) {
  for (const a of root.querySelectorAll('a.sid-link[data-sid]')) {
    const s = doc?.sentenceById?.get(a.dataset.sid);
    if (!s) {
      a.replaceWith(el('span', { class: 'pf-sid-missing', title: '문서에서 찾을 수 없는 인용' }, a.textContent));
      continue;
    }
    a.classList.add('pf-sid');
    a.textContent = `${s.page}쪽`;
    a.title = clip(s.text, 180);
    a.setAttribute('role', 'button');
    a.setAttribute('tabindex', '0');
    a.removeAttribute('target');
  }
  for (const a of root.querySelectorAll('a[href]:not(.sid-link)')) {
    const href = safeHref(a.getAttribute('href'));
    if (!href) { a.removeAttribute('href'); continue; }
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
}

/** Render model markdown (sanitised by renderMarkdown) into `target`, replacing its content. */
export async function renderModelMarkdown(target, md, doc, { sentenceLinks = true } = {}) {
  try {
    const frag = await renderMarkdown(md, { sentenceLinks });
    target.replaceChildren(frag);
    decorateMarkdown(target, doc);
  } catch (err) {
    console.warn('[features] renderMarkdown failed', err);
    target.textContent = md;
  }
}

/**
 * Delegated handling for sentence chips inside `root`: click/Enter jumps both panes,
 * hover highlights the sentence on both sides.
 */
export function wireSidLinks(root, ctx, signal) {
  const sidOf = (target) => {
    const a = target?.closest?.('a.sid-link[data-sid]');
    return a && root.contains(a) && ctx.doc?.sentenceById?.has(a.dataset.sid) ? a : null;
  };
  const hover = (sid) => {
    ctx.viewer?.setHoverSentence?.(sid);
    ctx.pane?.setHoverSentence?.(sid);
  };
  // stopPropagation: the reader view also delegates .sid-link clicks on its root; jump once.
  root.addEventListener('click', (e) => {
    const a = sidOf(e.target);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    ctx.jumpToSentence?.(a.dataset.sid);
  }, { signal });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const a = sidOf(e.target);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    ctx.jumpToSentence?.(a.dataset.sid);
  }, { signal });
  root.addEventListener('pointerover', (e) => {
    const a = sidOf(e.target);
    if (a) hover(a.dataset.sid);
  }, { signal });
  root.addEventListener('pointerout', (e) => {
    const a = sidOf(e.target);
    if (a && !a.contains(e.relatedTarget)) hover(null);
  }, { signal });
}

const nextFrame = () => new Promise((resolve) => {
  // rAF pauses in background tabs; the timeout keeps streams (and their saves) moving.
  const t = setTimeout(resolve, 60);
  requestAnimationFrame(() => { clearTimeout(t); resolve(); });
});

/**
 * Incremental markdown painter for streamed output. `update(text)` may be called per chunk;
 * paints are coalesced to one per frame and never overlap. `flush()` resolves once the latest
 * text is on screen; `cancel()` stops all further painting (e.g. a superseded stream).
 */
export function markdownStream(target, doc, { onPaint } = {}) {
  let text = '';
  let painted = null;
  let loop = null;
  let cancelled = false;
  const pending = () => !cancelled && painted !== text;
  const kick = () => {
    if (loop || !pending()) return loop ?? Promise.resolve();
    loop = (async () => {
      await nextFrame();
      while (pending()) {
        const snapshot = text;
        const scratch = document.createElement('div');
        await renderModelMarkdown(scratch, snapshot, doc);
        if (cancelled) return;
        target.replaceChildren(...scratch.childNodes);
        painted = snapshot;
        onPaint?.();
        if (pending()) await nextFrame();
      }
    })().finally(() => {
      loop = null;
      if (pending()) kick();
    });
    return loop;
  };
  return {
    update(next) { text = next; return kick(); },
    async flush() { while (loop || pending()) await (loop ?? kick()); },
    cancel() { cancelled = true; },
  };
}

/**
 * Drain a tasks.* stream. Text chunks may be strings or { type:'text', text }; the final
 * { done: true, usage, model? } carries usage. `onText(fullText, chunk)` is called per chunk.
 * @returns {Promise<{ text: string, usage: object|null, model: string|null }>}
 */
export async function drainStream(iterable, onText) {
  let text = '';
  let usage = null;
  let model = null;
  for await (const chunk of iterable) {
    if (typeof chunk === 'string') {
      text += chunk;
      onText?.(text, chunk);
    } else if (chunk && typeof chunk === 'object') {
      if (chunk.done) {
        usage = chunk.usage ?? null;
        model = chunk.model ?? usage?.model ?? null;
      } else if (typeof chunk.text === 'string') {
        text += chunk.text;
        onText?.(text, chunk.text);
      }
    }
  }
  return { text, usage, model };
}

// --- misc UI ------------------------------------------------------------------------------

/** Copy text to the clipboard; falls back to execCommand for insecure contexts. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through */ }
  const ta = el('textarea', { readonly: true, style: { position: 'fixed', left: '-9999px', opacity: '0' } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

let aiNotReadyToast = null;
/**
 * A missing key is a setup step, not an error: one warning toast (never stacked) with a way to 설정.
 * Used by every AI action that cannot start yet.
 */
export function notifyAiNotReady(message = AI_NOT_READY_MESSAGE) {
  if (aiNotReadyToast?.el?.isConnected) return aiNotReadyToast;
  aiNotReadyToast = toast(message, {
    kind: 'warning', timeout: 8000,
    action: { label: '설정 열기', onClick: () => { location.hash = '#/settings'; } },
  });
  return aiNotReadyToast;
}

/** Box shown in place of an AI feature when no provider key is configured. */
export function aiGate(message = AI_NOT_READY_MESSAGE) {
  return el('div', { class: 'pf-empty' },
    el('p', {}, message),
    el('a', { class: 'pf-btn pf-btn--primary', href: '#/settings' }, '설정 열기'));
}

export function emptyState(title, hint) {
  return el('div', { class: 'pf-empty' },
    el('p', { class: 'pf-empty__title' }, title),
    hint ? el('p', { class: 'pf-muted' }, hint) : null);
}

export function button(label, { kind = 'default', onClick, title, icon, small = false, disabled = false, attrs = {} } = {}) {
  const cls = ['pf-btn', kind !== 'default' ? `pf-btn--${kind}` : '', small ? 'pf-btn--sm' : ''].filter(Boolean).join(' ');
  return el('button', { type: 'button', class: cls, title, disabled, onclick: onClick, ...attrs },
    icon ? el('span', { class: 'pf-btn__icon', 'aria-hidden': 'true' }, icon) : null, label);
}
