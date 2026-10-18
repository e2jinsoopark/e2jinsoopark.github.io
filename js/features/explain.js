// AI 설명: streaming explanation of a selected passage, or of a captured figure/table region
// (toolbar toggle "그림·표 설명" → viewer region capture). Results are saved to ai.explanations.
import { el, uid } from '../core/util.js';
import { toast } from '../ui/components.js';
import { explain } from '../ai/tasks.js';
import {
  AI_NOT_READY_MESSAGE, anySignal, button, clip, copyText, drainStream, errorMessage, isAbortError,
  markdownStream, sentenceAt, wireSidLinks,
} from './shared.js';
import { floatingCard } from './ui-bits.js';

const MAX_SAVED_EXPLANATIONS = 100;

/** Explain a text selection ({ text, start, end, rect }) next to the reader. */
export function explainSelection(ctx, session, { text, start }) {
  const quote = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!quote) return null;
  const near = Number.isFinite(start) ? sentenceAt(ctx.doc, start) : null;
  return openExplanation(ctx, session, { kind: 'text', quote, nearSid: near?.sid ?? null });
}

/**
 * Open (replacing any previous one) an explanation card and stream into it.
 * @param {{ kind: 'text'|'image', quote?: string, imageDataUrl?: string, nearSid?: string|null,
 *           page?: number, rect?: object }} req
 */
export function openExplanation(ctx, session, req) {
  if (!ctx.settings.isAiReady()) {
    toast(AI_NOT_READY_MESSAGE, { kind: 'error' });
    return null;
  }
  session.explainCard?.close();
  let run = null;
  const cardLife = new AbortController();
  const card = floatingCard({
    title: 'AI 설명',
    badge: req.kind === 'image' ? `그림·표${req.page ? ` · p.${req.page}` : ''}` : '선택한 문장',
    className: 'pf-explain',
    onClose: () => {
      run?.abort();
      cardLife.abort();
      if (session.explainCard === card) session.explainCard = null;
    },
  });
  session.explainCard = card;

  const source = req.kind === 'image'
    ? el('figure', { class: 'pf-explain__figure' }, el('img', { src: req.imageDataUrl, alt: '선택한 그림·표 영역' }))
    : el('blockquote', { class: 'pf-explain__quote' }, clip(req.quote, 320));
  const answer = el('div', { class: 'pf-md pf-explain__answer' });
  const status = el('div', { class: 'pf-explain__status' });
  card.body.append(source, answer, status);
  wireSidLinks(answer, ctx, cardLife.signal);

  let text = '';
  const stopBtn = button('중지', { small: true, kind: 'danger', onClick: () => run?.abort(), attrs: { 'data-action': 'stop' } });
  const retryBtn = button('다시 생성', { small: true, onClick: () => start(), attrs: { 'data-action': 'regenerate' } });
  const copyBtn = button('복사', {
    small: true, attrs: { 'data-action': 'copy' },
    onClick: async () => {
      const ok = await copyText(text);
      toast(ok ? '설명을 복사했습니다.' : '복사하지 못했습니다.', { kind: ok ? 'success' : 'error' });
    },
  });
  const askBtn = req.kind === 'text'
    ? button('채팅에서 이어 묻기', { small: true, attrs: { 'data-action': 'ask' }, onClick: () => { card.close(); session.askInChat({ text: req.quote }); } })
    : null;
  card.foot.append(...[stopBtn, el('span', { class: 'pf-spacer' }), askBtn, copyBtn, retryBtn].filter(Boolean));

  const setBusy = (busy) => {
    stopBtn.hidden = !busy;
    retryBtn.disabled = busy;
    copyBtn.disabled = busy || !text;
    card.el.classList.toggle('is-streaming', busy);
  };

  async function start() {
    run?.abort();
    const mine = new AbortController();
    run = mine;
    const signal = anySignal(mine.signal, ctx.signal);
    text = '';
    answer.replaceChildren();
    status.replaceChildren(el('span', { class: 'pf-muted pf-small' }, req.kind === 'image' ? '그림·표를 읽고 설명하는 중…' : '설명을 만드는 중…'));
    setBusy(true);
    const painter = markdownStream(answer, ctx.doc);
    const superseded = () => run !== mine;
    try {
      const stream = explain(ctx.doc, { quote: req.quote, imageDataUrl: req.imageDataUrl, nearSid: req.nearSid },
        { signal, paperId: ctx.paper?.id });
      const { text: full, model } = await drainStream(stream, (t) => {
        if (superseded()) return;
        text = t;
        if (status.firstChild) status.replaceChildren();
        painter.update(t);
      });
      text = full;
      painter.update(full);
      await painter.flush();
      status.replaceChildren();
      await saveExplanation(ctx, {
        kind: req.kind,
        ...(req.quote ? { quote: req.quote } : {}),
        ...(req.page ? { page: req.page } : {}),
        markdown: full,
        model: model || ctx.settings.model('assist'),
      });
    } catch (err) {
      if (superseded()) { painter.cancel(); return; } // "다시 생성" started a newer stream
      await painter.flush().catch(() => {});
      if (isAbortError(err, signal)) {
        if (!card.closed) status.replaceChildren(el('span', { class: 'pf-muted pf-small' }, '설명을 중지했습니다.'));
      } else {
        console.warn('[features] explain failed', err);
        status.replaceChildren(el('p', { class: 'pf-error' }, errorMessage(err, '설명을 만들지 못했습니다.')));
      }
    } finally {
      if (run === mine) {
        run = null;
        if (!card.closed) setBusy(false);
      }
    }
  }

  start();
  return card;
}

async function saveExplanation(ctx, entry) {
  try {
    const ai = (await ctx.getAi()) || {};
    const list = Array.isArray(ai.explanations) ? ai.explanations : [];
    const next = [...list, { id: uid('x'), createdAt: Date.now(), ...entry }].slice(-MAX_SAVED_EXPLANATIONS);
    await ctx.saveAi({ explanations: next });
  } catch (err) {
    console.warn('[features] explanation save failed', err);
  }
}

/**
 * Sentence to give the model as context for a captured region: the caption on that page closest
 * to the region (by on-screen distance), else the first body sentence of the page.
 */
export function nearestCaptionSid(ctx, page, rect) {
  const onPage = (ctx.doc?.sentences || []).filter((s) => s.page === page || s.pages?.includes(page));
  const captions = onPage.filter((s) => s.kind === 'caption');
  const pool = captions.length ? captions : onPage.filter((s) => s.kind === 'body');
  if (!pool.length) return null;
  const zoom = Number(ctx.viewer?.zoom);
  if (!rect || !Number.isFinite(zoom) || zoom <= 0 || typeof ctx.viewer?.getSentenceRects !== 'function') return pool[0].sid;
  const top = rect.y * zoom;
  const bottom = (rect.y + rect.h) * zoom;
  let best = pool[0].sid;
  let bestDist = Infinity;
  for (const s of pool) {
    for (const r of ctx.viewer.getSentenceRects(s.sid) || []) {
      if (r.page !== page) continue;
      const dist = Math.max(0, r.y - bottom, top - (r.y + r.h));
      if (dist < bestDist) { bestDist = dist; best = s.sid; }
    }
  }
  return best;
}

/** Toolbar toggle "그림·표 설명": drag a region on a page → explain the captured image. */
export function installRegionExplain(ctx, session, { signal }) {
  const { viewer } = ctx;
  let capturing = false;
  let hint = null;
  const btn = ctx.addToolbarButton?.({
    id: 'explain-region', icon: 'image', title: '그림·표 설명', toggle: true,
    onClick: (active) => setCapture(Boolean(active)),
  });

  function setCapture(on) {
    if (on && !ctx.settings.isAiReady()) { toast(AI_NOT_READY_MESSAGE, { kind: 'error' }); on = false; }
    if (on && typeof viewer?.setRegionCapture !== 'function') on = false;
    capturing = on;
    viewer?.setRegionCapture?.(on);
    btn?.setActive?.(on);
    hint?.close?.();
    hint = on ? toast('설명할 그림이나 표를 드래그해서 선택하세요. (Esc: 취소)', { timeout: 0 }) : null;
  }

  viewer?.addEventListener('regioncapture', (e) => {
    const d = e.detail;
    if (!capturing || !/^data:image\/(png|jpeg|webp);base64,/.test(d?.dataUrl ?? '')) return;
    setCapture(false);
    openExplanation(ctx, session, {
      kind: 'image', imageDataUrl: d.dataUrl, page: d.page, rect: d.rect,
      nearSid: nearestCaptionSid(ctx, d.page, d.rect),
    });
  }, { signal });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && capturing) setCapture(false);
  }, { signal });

  signal.addEventListener('abort', () => {
    hint?.close?.();
    if (capturing) viewer?.setRegionCapture?.(false);
    session.explainCard?.close();
  }, { once: true });
}
