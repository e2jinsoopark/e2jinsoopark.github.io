// 관련 논문 panel: Semantic Scholar title match → recommendations, cached in ai.related,
// s2PaperId stored on the paper, optional abstract translation.
import { el } from '../core/util.js';
import { renderMarkdown, spinner, toast } from '../ui/components.js';
import { quickTranslate } from '../ai/tasks.js';
import { anySignal, button, emptyState, errorMessage, externalLink, formatDateTime, isAbortError } from './shared.js';
import { formatAuthors, matchPaper, normalizePaper, recommendations } from './s2.js';
import { ensureStyles } from './styles.js';

class RelatedPanel {
  #ctl = new AbortController();
  #run = null;
  #started = false;

  constructor(container, ctx) {
    ensureStyles();
    this.ctx = ctx;
    this.related = null;
    this.meta = el('span', { class: 'pf-muted pf-small' });
    this.refreshBtn = button('새로고침', { small: true, onClick: () => this.fetch({ rematch: false }), attrs: { 'data-action': 'refresh' } });
    this.body = el('div', { class: 'pf-related__body' });
    this.root = el('section', { class: 'pf-panel pf-related' },
      el('header', { class: 'pf-panel__head' },
        el('div', { class: 'pf-panel__titles' }, el('h2', { class: 'pf-panel__title' }, '관련 논문'), this.meta),
        el('div', { class: 'pf-panel__actions' }, this.refreshBtn)),
      el('div', { class: 'pf-panel__scroll' }, this.body));
    container.append(this.root);
    this.refreshBtn.disabled = true;
  }

  get signal() { return this.#ctl.signal; }

  paperTitle() {
    const { doc, paper } = this.ctx;
    return (doc?.meta?.title || paper?.title || paper?.fileName || '').trim();
  }

  currentS2Id() {
    const { library, paper } = this.ctx;
    return library?.getPaper?.(paper.id)?.s2PaperId ?? paper?.s2PaperId ?? null;
  }

  /** Data is fetched lazily the first time the tab is shown (it costs a network round trip). */
  onShow() {
    if (this.#started) return;
    this.#started = true;
    this.loadCached();
  }

  async loadCached() {
    try {
      const ai = (await this.ctx.getAi()) || {};
      if (Array.isArray(ai.related?.items)) {
        this.related = ai.related;
        this.render();
        return;
      }
    } catch (err) {
      console.warn('[features] related cache read failed', err);
    }
    if (!this.signal.aborted) this.fetch({ rematch: false });
  }

  /**
   * @param {{ rematch?: boolean, query?: string }} opts rematch ignores the stored s2PaperId;
   *   query overrides the title used for matching.
   */
  async fetch({ rematch = false, query } = {}) {
    this.#run?.abort();
    const run = new AbortController();
    this.#run = run;
    const signal = anySignal(run.signal, this.signal, this.ctx.signal);
    const apiKey = this.ctx.settings.get().semanticScholar?.apiKey || '';
    this.refreshBtn.disabled = true;
    this.body.replaceChildren(el('div', { class: 'pf-loading' }, spinner(18), el('span', {}, 'Semantic Scholar에서 찾는 중…')));
    try {
      let s2Id = rematch || query ? null : this.currentS2Id();
      let matched = s2Id && this.related?.s2PaperId === s2Id ? this.related.paper ?? null : null;
      if (!s2Id) {
        const title = query ?? this.paperTitle();
        matched = title ? await matchPaper(title, { apiKey, signal }) : null;
        if (!matched) { this.renderNotFound(title); return; }
        s2Id = matched.paperId;
        if (s2Id !== this.currentS2Id()) this.ctx.library?.updatePaper?.(this.ctx.paper.id, { s2PaperId: s2Id });
      }
      const items = await recommendations(s2Id, { apiKey, signal });
      this.related = { s2PaperId: s2Id, paper: matched, items, fetchedAt: Date.now() };
      this.render();
      await this.ctx.saveAi({ related: this.related });
    } catch (err) {
      if (isAbortError(err, signal) || this.#run !== run) return;
      console.warn('[features] related fetch failed', err);
      this.renderError(err);
    } finally {
      if (this.#run === run) {
        this.#run = null;
        if (!this.signal.aborted) this.refreshBtn.disabled = !this.related && !this.currentS2Id();
      }
    }
  }

  render() {
    const r = this.related;
    this.meta.textContent = r?.fetchedAt ? `Semantic Scholar · ${formatDateTime(r.fetchedAt)}` : '';
    this.refreshBtn.disabled = false;
    const head = this.matchedCard(r);
    if (!r.items.length) {
      this.body.replaceChildren(head, emptyState('추천 논문이 없습니다.', 'Semantic Scholar가 이 논문에 대한 추천을 아직 만들지 않았을 수 있습니다.'));
      return;
    }
    this.body.replaceChildren(head, el('ol', { class: 'pf-related__list' }, r.items.map((p) => this.itemView(p))));
  }

  matchedCard(r) {
    const p = r.paper ? normalizePaper(r.paper) : null;
    const fix = el('button', { type: 'button', class: 'pf-link-btn', dataset: { action: 'rematch' }, onclick: () => this.renderNotFound(this.paperTitle(), { wrongMatch: true }) },
      '다른 논문으로 다시 찾기');
    if (!p?.title) {
      return el('div', { class: 'pf-related__match' },
        el('span', { class: 'pf-muted pf-small' }, '기준 논문: '),
        externalLink(`https://www.semanticscholar.org/paper/${encodeURIComponent(r.s2PaperId)}`, 'Semantic Scholar에서 보기'), ' ', fix);
    }
    return el('div', { class: 'pf-related__match' },
      el('div', { class: 'pf-muted pf-small' }, '기준 논문 (Semantic Scholar 매칭)'),
      el('div', { class: 'pf-related__match-title' }, externalLink(p.url, p.title)),
      el('div', { class: 'pf-muted pf-small' }, [p.year, p.citationCount != null ? `인용 ${p.citationCount}회` : ''].filter(Boolean).join(' · '), ' · ', fix));
  }

  itemView(p) {
    const abs = el('p', { class: 'pf-related__abs is-clamped' }, p.abstract);
    const ko = el('div', { class: 'pf-related__ko pf-md', hidden: true });
    const actions = el('div', { class: 'pf-related__actions' });
    if (p.abstract) {
      actions.append(
        el('button', {
          type: 'button', class: 'pf-link-btn', dataset: { action: 'expand' },
          onclick: (e) => {
            const open = abs.classList.toggle('is-clamped');
            e.currentTarget.textContent = open ? '초록 펼치기' : '초록 접기';
          },
        }, '초록 펼치기'),
        el('button', { type: 'button', class: 'pf-link-btn', dataset: { action: 'translate' }, onclick: (e) => this.translate(p, ko, e.currentTarget) }, '초록 번역'));
    }
    return el('li', { class: 'pf-related__item' },
      el('div', { class: 'pf-related__title' }, externalLink(p.url, p.title || '(제목 없음)')),
      el('div', { class: 'pf-muted pf-small' },
        [formatAuthors(p.authors), p.year, p.citationCount != null ? `인용 ${p.citationCount}회` : ''].filter(Boolean).join(' · ')),
      p.abstract ? abs : el('p', { class: 'pf-muted pf-small' }, '초록 없음'),
      ko, actions);
  }

  /** First click translates; afterwards the button just shows/hides the translation. */
  async translate(p, target, btn) {
    if (btn.dataset.done) {
      target.hidden = !target.hidden;
      btn.textContent = target.hidden ? '번역 보기' : '번역 숨기기';
      return;
    }
    if (!this.ctx.settings.isAiReady()) { toast('AI를 쓰려면 설정에서 API 키를 먼저 입력해 주세요.', { kind: 'error' }); return; }
    btn.disabled = true;
    target.hidden = false;
    target.replaceChildren(el('div', { class: 'pf-loading' }, spinner(14), el('span', {}, '번역하는 중…')));
    try {
      const { text } = await quickTranslate(p.abstract, { signal: anySignal(this.signal, this.ctx.signal), paperId: this.ctx.paper?.id });
      target.replaceChildren(await renderMarkdown(String(text ?? ''), { sentenceLinks: false }));
      btn.dataset.done = '1';
      btn.textContent = '번역 숨기기';
      btn.disabled = false;
    } catch (err) {
      if (isAbortError(err)) return;
      target.replaceChildren(el('p', { class: 'pf-error' }, errorMessage(err, '번역하지 못했습니다.')));
      btn.disabled = false;
    }
  }

  /** No (or a wrong) match: let the user correct the search query. */
  renderNotFound(title, { wrongMatch = false } = {}) {
    const input = el('input', { class: 'pf-input', type: 'search', 'aria-label': '논문 제목', placeholder: '논문 제목을 입력하세요' });
    input.value = title || '';
    const go = () => { const q = input.value.trim(); if (q) this.fetch({ query: q, rematch: true }); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) go(); });
    this.body.replaceChildren(el('div', { class: 'pf-empty pf-related__search' },
      el('p', { class: 'pf-empty__title' }, wrongMatch ? '찾을 논문 제목을 고쳐 입력하세요.' : 'Semantic Scholar에서 이 논문을 찾지 못했습니다.'),
      el('p', { class: 'pf-muted pf-small' }, '정확한 영문 제목으로 검색하면 잘 찾습니다.'),
      el('div', { class: 'pf-row' }, input, button('다시 찾기', { kind: 'primary', onClick: go, attrs: { 'data-action': 'search' } })),
      wrongMatch && this.related ? button('취소', { small: true, onClick: () => this.render() }) : null));
    input.focus();
  }

  renderError(err) {
    this.body.replaceChildren(el('div', { class: 'pf-error-box' },
      el('p', {}, errorMessage(err, '관련 논문을 불러오지 못했습니다.')),
      button('다시 시도', { small: true, onClick: () => this.fetch({ rematch: false }), attrs: { 'data-action': 'retry' } })));
  }

  destroy() {
    this.#ctl.abort();
    this.#run?.abort();
    this.root.remove();
  }
}

export const relatedPanel = {
  id: 'related',
  title: '관련 논문',
  icon: 'book-open',
  mount(container, ctx) {
    const panel = new RelatedPanel(container, ctx);
    return { onShow: () => panel.onShow(), destroy: () => panel.destroy() };
  },
};
