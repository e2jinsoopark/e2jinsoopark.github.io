// Link previews on PDF hover: a citation that lands inside a bibliography entry shows a reference
// card (keyless lookup: DOI or Crossref -> Europe PMC / PubMed for abstract and citation count,
// Semantic Scholar only if nothing matched; automatic once the user has agreed, see scholarly.js);
// any other internal link shows a rendered preview of the target area; external links show their address.
import { clamp, el } from '../core/util.js';
import { popover, spinner } from '../ui/components.js';
import { abstractNodes, linkBadges } from './paper-bits.js';
import { ensureRelatedStyles } from './related-styles.js';
import { formatAuthors } from './s2.js';
import { CONSENT_TEXT, grantConsent, hasConsent, lookupReference, primaryUrl } from './scholarly.js';
import {
  anySignal, button, clip, errorMessage, externalLink, isAbortError, safeHref, toRect,
} from './shared.js';

const SHOW_DELAY_MS = 140;
const HIDE_GRACE_MS = 280;
const PREVIEW_CSS_WIDTH = 440;
const ABSTRACT_MAX = 900;

/** Cut a multi-line text to about `max` characters, keeping its line breaks. */
function clipLines(text, max) {
  const lines = String(text ?? '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  let left = max;
  for (const line of lines) {
    if (left <= 0) break;
    out.push(line.length > left ? `${line.slice(0, Math.max(0, left - 1)).trimEnd()}…` : line);
    left -= line.length;
  }
  return out.join('\n');
}

/**
 * Link target point in PDF units with top-left origin. The viewer supplies `target.pt` (crop-box and
 * rotation correct); otherwise the user-space y (bottom-left origin) is flipped against the page height,
 * which is only exact for pages whose box starts at the origin.
 */
export function targetPoint(doc, target) {
  if (!target || !Number.isFinite(target.page)) return null;
  if (target.pt && Number.isFinite(target.pt.y)) {
    return { x: Number.isFinite(target.pt.x) ? target.pt.x : null, y: target.pt.y };
  }
  const pageH = doc?.pages?.[target.page - 1]?.height;
  if (target.y == null || !Number.isFinite(pageH)) return null;
  return { x: Number.isFinite(target.x) ? target.x : null, y: pageH - target.y };
}

/**
 * Bibliography entry a link target points into, or null. The viewer's `target.refIndex` (index into
 * doc.references) wins when present. Otherwise destinations usually point at (or just above) the
 * entry's first line, so the closest entry top within a small tolerance wins; Reference.bbox uses a
 * top-left origin like renderRegion/regioncapture.
 */
export function findReferenceAt(doc, target) {
  if (!target || !Number.isFinite(target.page)) return null;
  const refs = doc?.references || [];
  if (Number.isInteger(target.refIndex)) {
    const ref = refs.find((r) => r.index === target.refIndex);
    if (ref) return ref;
  }
  const pt = targetPoint(doc, target);
  if (!pt) return null;
  let best = null;
  let bestDist = Infinity;
  for (const ref of refs) {
    const b = ref.bbox;
    if (ref.page !== target.page || !b) continue;
    if (pt.x != null && (pt.x < b.x - 24 || pt.x > b.x + b.w + 24)) continue;
    if (pt.y < b.y - 18 || pt.y > b.y + b.h + 4) continue;
    const dist = Math.abs(pt.y - b.y);
    if (dist < bestDist) { bestDist = dist; best = ref; }
  }
  return best;
}

/** Region (PDF units, top-left origin) to preview around a link target. */
export function previewRegion(doc, target) {
  const pg = doc?.pages?.[target.page - 1];
  const W = pg?.width || 612;
  const H = pg?.height || 792;
  const pt = targetPoint(doc, target);
  if (!pt) return { x: 0, y: 0, w: W, h: Math.round(H * 0.32) };
  const w = Math.min(W, Math.max(W * 0.5, 280));
  const h = Math.min(H, Math.round(H * 0.3));
  const tx = pt.x ?? 0;
  return { x: clamp(tx - 20, 0, W - w), y: clamp(pt.y - 16, 0, H - h), w, h };
}

export function installCitations(ctx, session, { signal }) {
  const { viewer, doc } = ctx;
  if (!viewer) return;
  ensureRelatedStyles();
  /** Reference index -> AbortController of a lookup still running (aborted when its card closes). */
  const running = new Map();
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
    const lookupBtn = button('논문 정보 찾기', { small: true, attrs: { 'data-action': 'ref-lookup' } });
    lookupBtn.addEventListener('click', () => {
      if (hasConsent()) lookup(ref, result, lookupBtn, abortSignal);
      else askConsent(ref, result, lookupBtn, abortSignal);
    });
    const node = el('div', { class: 'pf-cite pf-cite--ref' },
      el('div', { class: 'pf-pop__head' }, label, el('span', { class: 'pf-muted' }, ` · ${ref.page}쪽`)),
      el('p', { class: 'pf-cite__text' }, clip(ref.text, 700)),
      result,
      el('div', { class: 'pf-pop__foot' }, lookupBtn,
        button('참고문헌으로 이동', { small: true, onClick: () => goTo(target), attrs: { 'data-action': 'goto' } })));
    // Earlier lookups are shown at once; after the one-time consent, entries are looked up on hover.
    if (session.refLookups.has(ref.index) || hasConsent()) lookup(ref, result, lookupBtn, abortSignal);
    return node;
  }

  /** Nothing is sent before the once-per-browser consent (shared with the 관련 논문 panel). */
  function askConsent(ref, box, btn, abortSignal) {
    btn.hidden = true;
    box.replaceChildren(el('div', { class: 'pf-cite__consent' },
      el('p', { class: 'pf-muted pf-small' }, CONSENT_TEXT),
      el('div', { class: 'pf-row' }, button('동의하고 찾기', {
        kind: 'primary', small: true, attrs: { 'data-action': 'scholar-consent' },
        onClick: () => { grantConsent(); btn.hidden = false; lookup(ref, box, btn, abortSignal); },
      }))));
    current?.pop.update?.(current.rect);
  }

  async function lookup(ref, box, btn, abortSignal) {
    btn.disabled = true;
    box.replaceChildren(el('div', { class: 'pf-loading' }, spinner(14), el('span', {}, 'PubMed·Crossref에서 찾는 중…')));
    let promise = session.refLookups.get(ref.index);
    if (!promise) {
      const ctl = new AbortController();
      const s2ApiKey = ctx.settings?.get?.()?.semanticScholar?.apiKey || '';
      promise = lookupReference(ref.text, { signal: anySignal(ctl.signal, ctx.signal), s2ApiKey });
      session.refLookups.set(ref.index, promise);
      running.set(ref.index, ctl);
      const settle = () => { if (running.get(ref.index) === ctl) running.delete(ref.index); };
      promise.then(settle, () => {
        settle();
        if (session.refLookups.get(ref.index) === promise) session.refLookups.delete(ref.index);
      });
    }
    // A lookup still running when its card closes is dropped (sweeping across many citations must not
    // queue requests); a finished one stays cached for the next hover.
    abortSignal.addEventListener('abort', () => {
      const ctl = running.get(ref.index);
      if (!ctl) return;
      running.delete(ref.index);
      if (session.refLookups.get(ref.index) === promise) session.refLookups.delete(ref.index);
      ctl.abort();
    }, { once: true });
    try {
      const paper = await promise;
      if (abortSignal.aborted) return;
      box.replaceChildren(paper ? paperSummary(paper)
        : el('p', { class: 'pf-muted pf-small' }, 'PubMed·Europe PMC·Crossref·Semantic Scholar에서 찾지 못했습니다.'));
      btn.hidden = true;
      current?.pop.update?.(current.rect);
    } catch (err) {
      if (isAbortError(err) || abortSignal.aborted) return;
      box.replaceChildren(el('p', { class: 'pf-error' }, errorMessage(err, '검색하지 못했습니다.')));
      btn.textContent = '다시 찾기';
      btn.disabled = false;
      current?.pop.update?.(current.rect);
    }
  }

  function paperSummary(p) {
    const cites = p.citationCount != null
      ? `인용 ${p.citationCount}회${p.citationSource && p.citationSource !== 'Europe PMC' ? ` (${p.citationSource})` : ''}`
      : '';
    const venue = [p.journal || p.venue, p.year].filter(Boolean).join(' · ');
    const meta = [formatAuthors(p.authors), venue, cites].filter(Boolean).join(' · ');
    const abs = clipLines(p.abstract, ABSTRACT_MAX);
    return el('div', { class: 'pf-cite__paper' },
      el('div', { class: 'pf-cite__title' }, externalLink(primaryUrl(p), p.title || '(제목 없음)')),
      meta ? el('div', { class: 'pf-muted pf-small' }, meta) : null,
      abs ? el('div', { class: 'pf-cite__abs' }, abstractNodes(abs)) : el('p', { class: 'pf-muted pf-small' }, '초록 없음'),
      linkBadges(p, 'pf-cite__links'),
      p.sources?.length ? el('div', { class: 'pf-cite__source' }, `출처: ${p.sources.join(' → ')}`) : null);
  }

  function previewCard(target, abortSignal, anchorRect) {
    const region = previewRegion(doc, target);
    const frame = el('div', { class: 'pf-cite__frame', style: { width: `${PREVIEW_CSS_WIDTH}px`, aspectRatio: `${region.w} / ${region.h}` } },
      el('div', { class: 'pf-loading' }, spinner(16)));
    const node = el('div', { class: 'pf-cite pf-cite--preview' },
      el('div', { class: 'pf-pop__head' }, `${target.page}쪽 미리보기`),
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
