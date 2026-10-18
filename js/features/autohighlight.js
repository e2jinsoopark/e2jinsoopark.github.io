// 핵심 밑줄: toolbar toggle that underlines key sentences by category (tasks.keyPoints, run once
// and cached in ai.keyPoints) on the viewer's and pane's 'auto' layers, with a filterable legend.
import { clamp, el } from '../core/util.js';
import { spinner, toast } from '../ui/components.js';
import { keyPoints } from '../ai/tasks.js';
import { AI_NOT_READY_MESSAGE, NO_TEXT_MESSAGE, anySignal, errorMessage, hasDocText, isAbortError } from './shared.js';

/**
 * `color` is a named mark colour: the shell themes these (--mark-<name>[-line]) and they are also
 * valid CSS colour keywords, so any viewer/pane interpretation of mark.color works.
 * `swatch` is the legend colour, following the same tokens.
 */
export const KEYPOINT_CATEGORIES = Object.freeze([
  { id: 'contribution', label: '기여', color: 'purple', swatch: 'var(--mark-purple-line, #7048e8)' },
  { id: 'method', label: '방법', color: 'blue', swatch: 'var(--mark-blue-line, #1c7ed6)' },
  { id: 'result', label: '결과', color: 'green', swatch: 'var(--mark-green-line, #37b24d)' },
  { id: 'limitation', label: '한계', color: 'red', swatch: 'var(--mark-red-line, #e03131)' },
  { id: 'definition', label: '정의', color: 'orange', swatch: 'var(--mark-orange-line, #f76707)' },
]);
const CATEGORY = Object.fromEntries(KEYPOINT_CATEGORIES.map((c) => [c.id, c]));

/** Drop items whose sentence or category is unknown, and duplicate sids. */
export function cleanKeyPoints(doc, items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter((it) => {
    if (!it || !CATEGORY[it.category] || !doc?.sentenceById?.has(it.sid) || seen.has(it.sid)) return false;
    seen.add(it.sid);
    return true;
  }).map((it) => ({ sid: it.sid, category: it.category }));
}

/** Underline marks for the 'auto' layer, one named colour per category. */
export function keyPointMarks(doc, items, hidden = new Set()) {
  const marks = [];
  for (const it of items) {
    const cat = CATEGORY[it.category];
    const s = doc.sentenceById.get(it.sid);
    if (!cat || !s || hidden.has(cat.id)) continue;
    marks.push({ id: `kp-${it.sid}`, start: s.start, end: s.end, color: cat.color, style: 'underline', title: `핵심 · ${cat.label}`, category: cat.id });
  }
  return marks;
}

export function installAutoHighlight(ctx, session, { signal }) {
  const state = { active: false, items: null, hidden: new Set(), running: null, settingByUs: false };
  let legend = null;

  const btn = ctx.addToolbarButton?.({
    id: 'auto-highlight', icon: 'underline', title: '핵심 밑줄', toggle: true,
    onClick: (active) => (active ? turnOn({ user: true }) : turnOff({ user: true })),
  });

  function rememberPreference(on) {
    if (ctx.settings.get().ui?.showAutoHighlights === on) return;
    state.settingByUs = true;
    try { ctx.settings.set({ ui: { showAutoHighlights: on } }); } finally { state.settingByUs = false; }
  }

  async function cachedItems() {
    try {
      const ai = (await ctx.getAi()) || {};
      const items = cleanKeyPoints(ctx.doc, ai.keyPoints?.items);
      return items.length ? items : null;
    } catch { return null; }
  }

  /** `user`: the toolbar was clicked. Only a click may spend an AI call; otherwise cached results only. */
  async function turnOn({ user = false } = {}) {
    state.active = true;
    btn?.setActive?.(true);
    if (user) rememberPreference(true);
    state.items ??= await cachedItems();
    if (!state.active || signal.aborted) return;
    if (state.items) { render(); return; }
    if (!user) { setInactive(); return; }
    if (!hasDocText(ctx.doc)) { toast(NO_TEXT_MESSAGE, { kind: 'error' }); setInactive(); return; }
    if (!ctx.settings.isAiReady()) { toast(AI_NOT_READY_MESSAGE, { kind: 'error' }); setInactive(); return; }
    analyze();
  }

  function turnOff({ user = false } = {}) {
    // An analysis in flight keeps running: its cost is already incurred and the result gets cached.
    if (user) rememberPreference(false);
    setInactive();
  }

  function setInactive() {
    state.active = false;
    btn?.setActive?.(false);
    ctx.viewer?.setMarks?.('auto', []);
    ctx.pane?.setMarks?.('auto', []);
    hideLegend();
  }

  async function analyze() {
    if (state.running) return;
    const run = new AbortController();
    state.running = run;
    showLegend();
    try {
      const { items, usage, model } = await keyPoints(ctx.doc, { signal: anySignal(run.signal, ctx.signal, signal), paperId: ctx.paper?.id });
      const clean = cleanKeyPoints(ctx.doc, items);
      state.items = clean;
      await ctx.saveAi({
        keyPoints: { items: clean, model: model || usage?.model || ctx.settings.model('assist'), createdAt: Date.now() },
      });
      if (!clean.length) toast('핵심 문장을 찾지 못했습니다.');
      if (state.active) render();
    } catch (err) {
      if (isAbortError(err)) return;
      console.warn('[features] keyPoints failed', err);
      toast(errorMessage(err, '핵심 문장을 찾지 못했습니다.'), { kind: 'error' });
      if (state.active) setInactive();
    } finally {
      if (state.running === run) state.running = null;
      if (state.active && legend) showLegend();
    }
  }

  function render() {
    const marks = keyPointMarks(ctx.doc, state.items || [], state.hidden);
    ctx.viewer?.setMarks?.('auto', marks);
    ctx.pane?.setMarks?.('auto', marks);
    showLegend();
  }

  // --- legend -------------------------------------------------------------------------------

  function showLegend() {
    if (!legend) {
      legend = el('div', { class: 'pf-kp-legend', role: 'region', 'aria-label': '핵심 밑줄 범례' });
      document.body.append(legend);
    }
    if (state.running && !state.items) {
      legend.replaceChildren(el('span', { class: 'pf-kp-legend__title' }, '핵심 밑줄'),
        el('span', { class: 'pf-loading' }, spinner(14), el('span', {}, '핵심 문장을 찾는 중…')));
    } else {
      const counts = {};
      for (const it of state.items || []) counts[it.category] = (counts[it.category] || 0) + 1;
      legend.replaceChildren(
        el('span', { class: 'pf-kp-legend__title' }, '핵심 밑줄'),
        ...KEYPOINT_CATEGORIES.filter((c) => counts[c.id]).map((c) => el('button', {
          type: 'button', class: `pf-kp-chip${state.hidden.has(c.id) ? ' is-off' : ''}`, dataset: { category: c.id },
          'aria-pressed': String(!state.hidden.has(c.id)), title: state.hidden.has(c.id) ? '보이기' : '숨기기',
          onclick: () => { if (state.hidden.has(c.id)) state.hidden.delete(c.id); else state.hidden.add(c.id); render(); },
        }, el('span', { class: 'pf-kp-chip__line', style: { background: c.swatch } }), `${c.label} ${counts[c.id]}`)),
        el('button', {
          type: 'button', class: 'pf-link-btn', dataset: { action: 'reanalyze' }, disabled: Boolean(state.running),
          title: 'AI로 핵심 문장을 다시 찾습니다',
          onclick: () => { state.items = null; analyze(); },
        }, state.running ? '분석 중…' : '다시 분석'),
        el('button', { type: 'button', class: 'pf-icon-btn', 'aria-label': '핵심 밑줄 끄기', onclick: () => turnOff({ user: true }) }, '×'));
    }
    placeLegend();
  }

  /**
   * Top-left of the PDF pane, just under the toolbar, and never wider than that pane: it must not
   * cover the right pane's tabs (at 1024 px the full legend is wider than half the window) or the
   * toolbar. Falls back to the window's left edge when the viewer exposes no container.
   */
  function placeLegend() {
    if (!legend) return;
    const r = btn?.el?.isConnected ? btn.el.getBoundingClientRect() : null;
    const host = ctx.viewer?.container?.isConnected ? ctx.viewer.container.getBoundingClientRect() : null;
    let top = r && r.height ? r.bottom + 8 : 64;
    let left = 16;
    let maxWidth = window.innerWidth - 32;
    if (host && host.width > 0) {
      top = Math.max(top, host.top + 8);
      left = host.left + 12;
      maxWidth = Math.max(160, host.width - 24);
    }
    Object.assign(legend.style, {
      top: `${Math.round(clamp(top, 8, window.innerHeight - 48))}px`,
      left: `${Math.round(left)}px`,
      maxWidth: `${Math.round(maxWidth)}px`,
    });
  }

  function hideLegend() {
    legend?.remove();
    legend = null;
  }

  window.addEventListener('resize', placeLegend, { signal });
  // The split divider and view modes resize the PDF pane without a window resize.
  if (ctx.viewer?.container && typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => placeLegend());
    ro.observe(ctx.viewer.container);
    signal.addEventListener('abort', () => ro.disconnect(), { once: true });
  }

  const offSettings = ctx.bus?.on?.('settings:change', ({ settings } = {}) => {
    if (state.settingByUs) return;
    const want = Boolean(settings?.ui?.showAutoHighlights);
    if (want && !state.active) turnOn({ user: false });
    else if (!want && state.active) setInactive();
  });

  signal.addEventListener('abort', () => {
    offSettings?.();
    state.running?.abort();
    hideLegend();
  }, { once: true });

  if (ctx.settings.get().ui?.showAutoHighlights) turnOn({ user: false });
}
