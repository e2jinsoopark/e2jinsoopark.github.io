// 요약 panel: structured Korean summary (한 줄 요약 / 연구 목적 / 연구 방법 / 주요 결과 / 제한점 / 임상·연구적 시사점),
// cached in ai.summary, regenerate on demand, sentence chips jump to the source.
import { el } from '../core/util.js';
import { spinner, toast } from '../ui/components.js';
import { summarize } from '../ai/tasks.js';
import {
  NO_TEXT_MESSAGE, aiGate, button, copyText, emptyState, errorMessage, formatDateTime,
  hasDocText, isAbortError, renderModelMarkdown, wireSidLinks,
} from './shared.js';
import { ensureStyles } from './styles.js';

class SummaryPanel {
  #ctl = new AbortController(); // panel lifetime
  #run = null;                  // in-flight summarize()
  #shown = false;
  #loaded = false;              // cached summary read (autoStart must wait for it)

  constructor(container, ctx) {
    ensureStyles();
    this.ctx = ctx;
    this.summary = null;
    this.status = el('div', { class: 'pf-summary__status' });
    this.toc = el('nav', { class: 'pf-toc', 'aria-label': '요약 목차' });
    this.body = el('article', { class: 'pf-md pf-summary__body' });
    this.meta = el('span', { class: 'pf-muted pf-small' });
    this.regenBtn = button('다시 만들기', { small: true, onClick: () => this.generate(), attrs: { 'data-action': 'regenerate' } });
    this.copyBtn = button('복사', { small: true, onClick: () => this.copy(), attrs: { 'data-action': 'copy' } });
    this.root = el('section', { class: 'pf-panel pf-summary' },
      el('header', { class: 'pf-panel__head' },
        el('div', { class: 'pf-panel__titles' }, el('h2', { class: 'pf-panel__title' }, 'AI 요약'), this.meta),
        el('div', { class: 'pf-panel__actions' }, this.copyBtn, this.regenBtn)),
      el('div', { class: 'pf-panel__scroll' }, this.paperCard(), this.toc, this.status, this.body));
    container.append(this.root);
    wireSidLinks(this.body, ctx, this.#ctl.signal);
    // A summary made in another tab or on another device shows up here (and is never paid for twice).
    const off = ctx.bus?.on?.('paper:ai-change', ({ paperId, ai } = {}) => {
      if (paperId !== ctx.paper?.id || this.#run || !ai?.summary?.markdown) return;
      if (this.summary?.markdown === ai.summary.markdown) return;
      this.summary = ai.summary;
      this.renderSummary();
    });
    if (off) this.#ctl.signal.addEventListener('abort', off, { once: true });
    this.load();
  }

  paperCard() {
    const { doc, paper } = this.ctx;
    const title = doc?.meta?.title || paper?.title || paper?.fileName || '';
    const authors = doc?.meta?.authors || paper?.authors || '';
    const year = doc?.meta?.year || paper?.year || '';
    return el('div', { class: 'pf-paper-card' },
      el('div', { class: 'pf-paper-card__title' }, title),
      authors || year ? el('div', { class: 'pf-muted pf-small' }, [authors, year].filter(Boolean).join(' · ')) : null);
  }

  async load() {
    try {
      const ai = (await this.ctx.getAi()) || {};
      if (ai.summary?.markdown) this.summary = ai.summary;
    } catch (err) {
      console.warn('[features] summary load failed', err);
    }
    this.#loaded = true;
    if (this.#ctl.signal.aborted) return;
    if (this.summary) await this.renderSummary();
    else this.renderIdle();
  }

  /** Opening the tab never spends money by itself: the summary is made when the user asks (요약 만들기). */
  onShow() {
    this.#shown = true;
  }

  renderIdle() {
    this.setButtons();
    this.toc.replaceChildren();
    this.body.replaceChildren();
    if (!hasDocText(this.ctx.doc)) {
      this.status.replaceChildren(emptyState(NO_TEXT_MESSAGE, '텍스트가 있는 PDF에서만 요약할 수 있습니다.'));
    } else if (!this.ctx.settings.isAiReady()) {
      this.status.replaceChildren(aiGate());
    } else {
      this.status.replaceChildren(el('div', { class: 'pf-empty' },
        el('p', { class: 'pf-empty__title' }, '이 논문의 핵심을 한국어로 정리합니다.'),
        el('p', { class: 'pf-muted' }, '한 줄 요약 · 연구 목적 · 연구 방법 · 주요 결과 · 제한점 · 임상·연구적 시사점'),
        button('요약 만들기', { kind: 'primary', onClick: () => this.generate(), attrs: { 'data-action': 'generate' } }),
        el('p', { class: 'pf-muted pf-small' }, `요약·채팅 모델(${this.ctx.settings.model('assist') || '미설정'})로 논문 전체를 한 번 읽습니다. 만든 요약은 저장되어 다시 열 때 비용이 들지 않습니다.`)));
    }
  }

  async generate() {
    if (!hasDocText(this.ctx.doc)) return;
    if (!this.ctx.settings.isAiReady()) { this.renderIdle(); return; }
    this.#run?.abort();
    const run = new AbortController();
    this.#run = run;
    // Only 취소 stops the request: closing the paper lets it finish and be saved (its input is already billed).
    const signal = run.signal;
    this.setButtons(true);
    this.status.replaceChildren(el('div', { class: 'pf-loading' },
      spinner(18), el('span', {}, this.summary ? '요약을 다시 만드는 중…' : '요약을 만드는 중… (보통 10~30초)'),
      button('취소', { small: true, onClick: () => run.abort(), attrs: { 'data-action': 'cancel' } })));
    try {
      const { markdown, usage, model } = await summarize(this.ctx.doc, { signal, paperId: this.ctx.paper?.id });
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      this.summary = {
        markdown: String(markdown ?? ''),
        model: model || usage?.model || this.ctx.settings.model('assist'),
        createdAt: Date.now(),
      };
      const saved = this.ctx.saveAi({ summary: this.summary });
      if (!this.#ctl.signal.aborted) await this.renderSummary();
      await saved;
    } catch (err) {
      if (this.#run !== run) return; // superseded by a newer generate()
      if (isAbortError(err, signal)) {
        if (this.#ctl.signal.aborted) return;
        if (this.summary) await this.renderSummary(); else this.renderIdle();
        return;
      }
      console.warn('[features] summarize failed', err);
      this.status.replaceChildren(el('div', { class: 'pf-error-box' },
        el('p', {}, errorMessage(err, '요약을 만들지 못했습니다.')),
        button('다시 시도', { small: true, onClick: () => this.generate(), attrs: { 'data-action': 'retry' } })));
    } finally {
      if (this.#run === run) {
        this.#run = null;
        if (!this.#ctl.signal.aborted) this.setButtons();
      }
    }
  }

  async renderSummary() {
    const s = this.summary;
    this.status.replaceChildren();
    await renderModelMarkdown(this.body, s.markdown, this.ctx.doc);
    this.buildToc();
    this.meta.textContent = [s.model, formatDateTime(s.createdAt)].filter(Boolean).join(' · ');
    this.setButtons();
  }

  /** Section chips from the summary's headings, so long summaries are quick to navigate. */
  buildToc() {
    const heads = [...this.body.querySelectorAll('h1, h2, h3')];
    const chips = heads.map((h) => el('button', {
      type: 'button', class: 'pf-chip',
      onclick: () => h.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    }, h.textContent.trim()));
    this.toc.replaceChildren(...chips);
    this.toc.hidden = chips.length < 2;
  }

  setButtons(busy = false) {
    this.regenBtn.disabled = busy || !this.summary || !this.ctx.settings.isAiReady();
    this.copyBtn.disabled = busy || !this.summary;
  }

  async copy() {
    if (!this.summary) return;
    const ok = await copyText(this.summary.markdown);
    toast(ok ? '요약을 복사했습니다.' : '복사하지 못했습니다.', { kind: ok ? 'success' : 'error' });
  }

  destroy() {
    this.#ctl.abort(); // an in-flight summary keeps running and is saved when it arrives
    this.root.remove();
  }
}

export const summaryPanel = {
  id: 'summary',
  title: '요약',
  icon: 'sparkles',
  mount(container, ctx) {
    const panel = new SummaryPanel(container, ctx);
    return { onShow: () => panel.onShow(), destroy: () => panel.destroy() };
  },
};
