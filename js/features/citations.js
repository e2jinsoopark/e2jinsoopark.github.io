// Link previews on PDF hover: a citation that lands inside a bibliography entry shows a reference
// card (with lazy Semantic Scholar lookup); any other internal link shows a rendered preview of
// the target area; external links show their address.
import { clamp, el } from '../core/util.js';
import { popover, spinner } from '../ui/components.js';
import {
  anySignal, button, clip, errorMessage, externalLink, isAbortError, safeHref, toRect,
} from './shared.js';
import { formatAuthors, lookupReference } from './s2.js';

const SHOW_DELAY_MS = 140;
const HIDE_GRACE_MS = 280;
const PREVIEW_CSS_WIDTH = 440;

/**
 * Bibliography entry a link target points into, or null. `target` is in PDF user space
 * (origin bottom-left, like scrollToPdfPoint); Reference.bbox is taken as top-left origin,
 * matching renderRegion/regioncapture. Destinations usually point at (or just above) the
 * entry's first line, so the closest entry top within a small tolerance wins.
 */
export function findReferenceAt(doc, target) {
  if (!target || !Number.isFinite(target.page) || target.y == null) return null;
  const pageH = doc?.pages?.[target.page - 1]?.height;
  if (!Number.isFinite(pageH)) return null;
  const ty = pageH - target.y;
  const tx = Number.isFinite(target.x) ? target.x : null;
  let best = null;
  let bestDist = Infinity;
  for (const ref of doc.references || []) {
    const b = ref.bbox;
    if (ref.page !== target.page || !b) continue;
    if (tx != null && (tx < b.x - 24 || tx > b.x + b.w + 24)) continue;
    if (ty < b.y - 18 || ty > b.y + b.h + 4) continue;
    const dist = Math.abs(ty - b.y);
    if (dist < bestDist) { bestDist = dist; best = ref; }
  }
  return best;
}

/** Region (PDF units, top-left origin) to preview around a link target. */
export function previewRegion(doc, target) {
  const pg = doc?.pages?.[target.page - 1];
  const W = pg?.width || 612;
  const H = pg?.height || 792;
  if (target.y == null) return { x: 0, y: 0, w: W, h: Math.round(H * 0.32) };
  const w = Math.min(W, Math.max(W * 0.5, 280));
  const h = Math.min(H, Math.round(H * 0.3));
  const tx = Number.isFinite(target.x) ? target.x : 0;
  const ty = H - target.y;
  return { x: clamp(tx - 20, 0, W - w), y: clamp(ty - 16, 0, H - h), w, h };
}

export function installCitations(ctx, session, { signal }) {
  const { viewer, doc } = ctx;
  if (!viewer) return;
  let showTimer = null;
  let hideTimer = null;
  /** @type {{ key: string, pop: any, abort: AbortController } | null} */
  let current = null;

  const cancelHide = () => { clearTimeout(hideTimer); hideTimer = null; };
  const scheduleHide = () => {
    clearTimeout(showTimer);
    cancelHide();
    hideTimer = setTimeout(close, HIDE_GRACE_MS);
  };

  function close() {
    cancelHide();
    if (!current) return;
    const c = current;
    current = null;
    c.abort.abort();
    c.pop.close();
  }

  const keyOf = (d) => (d.kind === 'external' ? `x:${d.url}` : `i:${d.target?.page}:${d.target?.x}:${d.target?.y}`);

  function onHover(detail) {
    if (!detail) return;
    cancelHide();
    const key = keyOf(detail);
    if (current?.key === key) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(detail, key), SHOW_DELAY_MS);
  }

  function show(detail, key) {
    const rect = toRect(detail.clientRect);
    if (!rect) return;
    let content;
    const abort = new AbortController();
    if (detail.kind === 'external') {
      if (!safeHref(detail.url)) return;
      content = externalCard(detail.url);
    } else if (detail.target) {
      const ref = findReferenceAt(doc, detail.target);
      content = ref ? referenceCard(ref, detail.target, abort.signal) : previewCard(detail.target, abort.signal, rect);
    } else {
      return;
    }
    close();
    const entry = { key, abort, pop: null };
    entry.pop = popover(rect, content, {
      placement: 'bottom',
      className: 'pf-pop pf-pop--cite',
      onClose: () => { if (current === entry) { current = null; abort.abort(); } },
    });
    current = entry;
    entry.rect = rect;
    // Moving into the popover keeps it open; leaving it starts the grace timer again.
    entry.pop.el?.addEventListener('pointerenter', cancelHide);
    entry.pop.el?.addEventListener('pointerleave', scheduleHide);
  }

  const goTo = (target) => {
    viewer.scrollToPdfPoint?.(target.page, target.x ?? 0, target.y ?? doc.pages?.[target.page - 1]?.height ?? 0);
    close();
  };

  function externalCard(url) {
    const safe = safeHref(url);
    const host = (() => { try { return new URL(safe).host; } catch { return ''; } })();
    return el('div', { class: 'pf-cite pf-cite--external' },
      el('div', { class: 'pf-pop__head' }, '외부 링크', host ? el('span', { class: 'pf-muted' }, ` · ${host}`) : null),
      el('div', { class: 'pf-cite__url' }, clip(safe, 200)),
      el('div', { class: 'pf-pop__foot' }, externalLink(safe, '새 탭에서 열기')));
  }

  function referenceCard(ref, target, abortSignal) {
    const label = ref.n != null ? `참고문헌 ${ref.n}` : `참고문헌 ${ref.index + 1}`;
    const result = el('div', { class: 'pf-cite__s2' });
    const searchBtn = button('Semantic Scholar 검색', { small: true, attrs: { 'data-action': 's2-search' } });
    searchBtn.addEventListener('click', () => lookup(ref, result, searchBtn, abortSignal));
    const node = el('div', { class: 'pf-cite pf-cite--ref' },
      el('div', { class: 'pf-pop__head' }, label, el('span', { class: 'pf-muted' }, ` · p.${ref.page}`)),
      el('p', { class: 'pf-cite__text' }, clip(ref.text, 700)),
      result,
      el('div', { class: 'pf-pop__foot' }, searchBtn,
        button('참고문헌으로 이동', { small: true, onClick: () => goTo(target), attrs: { 'data-action': 'goto' } })));
    // A lookup done earlier for this entry is shown immediately.
    const cached = session.refLookups.get(ref.index);
    if (cached) lookup(ref, result, searchBtn, abortSignal);
    return node;
  }

  async function lookup(ref, box, btn, abortSignal) {
    btn.disabled = true;
    box.replaceChildren(el('div', { class: 'pf-loading' }, spinner(14), el('span', {}, '찾는 중…')));
    let promise = session.refLookups.get(ref.index);
    if (!promise) {
      const apiKey = ctx.settings.get().semanticScholar?.apiKey || '';
      // Not tied to the popover: a lookup survives the card closing and is reused next hover.
      promise = lookupReference(ref.text, { apiKey, signal: ctx.signal });
      session.refLookups.set(ref.index, promise);
      promise.catch(() => session.refLookups.delete(ref.index));
    }
    try {
      const paper = await promise;
      if (abortSignal.aborted) return;
      box.replaceChildren(paper ? paperSummary(paper) : el('p', { class: 'pf-muted pf-small' }, 'Semantic Scholar에서 찾지 못했습니다.'));
      current?.pop.update?.(current.rect);
    } catch (err) {
      if (isAbortError(err) || abortSignal.aborted) return;
      box.replaceChildren(el('p', { class: 'pf-error' }, errorMessage(err, '검색하지 못했습니다.')));
      btn.disabled = false;
    }
  }

  function paperSummary(p) {
    const meta = [formatAuthors(p.authors), p.year, p.venue, p.citationCount != null ? `인용 ${p.citationCount}회` : '']
      .filter(Boolean).join(' · ');
    return el('div', { class: 'pf-cite__paper' },
      el('div', { class: 'pf-cite__title' }, externalLink(p.url, p.title || '(제목 없음)')),
      meta ? el('div', { class: 'pf-muted pf-small' }, meta) : null,
      p.abstract ? el('p', { class: 'pf-cite__abs' }, clip(p.abstract, 600)) : el('p', { class: 'pf-muted pf-small' }, '초록 없음'));
  }

  function previewCard(target, abortSignal, anchorRect) {
    const region = previewRegion(doc, target);
    const frame = el('div', { class: 'pf-cite__frame', style: { width: `${PREVIEW_CSS_WIDTH}px`, aspectRatio: `${region.w} / ${region.h}` } },
      el('div', { class: 'pf-loading' }, spinner(16)));
    const node = el('div', { class: 'pf-cite pf-cite--preview' },
      el('div', { class: 'pf-pop__head' }, `p.${target.page} 미리보기`),
      frame,
      el('div', { class: 'pf-pop__foot' }, button('이 위치로 이동', { small: true, onClick: () => goTo(target), attrs: { 'data-action': 'goto' } })));
    const signalForRender = anySignal(abortSignal, ctx.signal);
    Promise.resolve(viewer.renderRegion?.(target.page, region, PREVIEW_CSS_WIDTH))
      .then((canvas) => {
        if (signalForRender.aborted) return;
        if (!(canvas instanceof HTMLCanvasElement)) throw new Error('미리보기를 만들 수 없습니다.');
        canvas.classList.add('pf-cite__canvas');
        frame.replaceChildren(canvas);
        frame.style.aspectRatio = '';
        current?.pop.update?.(anchorRect);
      })
      .catch((err) => {
        if (signalForRender.aborted) return;
        console.warn('[features] renderRegion failed', err);
        frame.replaceChildren(el('p', { class: 'pf-error' }, '미리보기를 그리지 못했습니다.'));
      });
    return node;
  }

  viewer.addEventListener('linkhover', (e) => onHover(e.detail), { signal });
  viewer.addEventListener('linkleave', () => { clearTimeout(showTimer); if (current) scheduleHide(); }, { signal });
  signal.addEventListener('abort', () => { clearTimeout(showTimer); close(); }, { once: true });
}
