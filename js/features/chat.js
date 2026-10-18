// 채팅 panel: streaming Q&A about the paper, history persisted in ai.chat, quote prefill from
// the selection menu, sentence citation chips, stop button, clear history.
import { el, uid } from '../core/util.js';
import { confirmDialog, toast } from '../ui/components.js';
import { chat } from '../ai/tasks.js';
import {
  NO_TEXT_MESSAGE, aiGate, anySignal, button, clip, copyText, drainStream, errorMessage, hasDocText,
  isAbortError, markdownStream, notifyAiNotReady, renderModelMarkdown, wireSidLinks,
} from './shared.js';
import { getSession } from './session.js';
import { ensureStyles } from './styles.js';

const MAX_HISTORY = 200;
const SUGGESTIONS = [
  '이 연구의 목적과 주요 결과를 쉽게 설명해 주세요.',
  '연구 방법(설계·대상·도구)을 정리해 주세요.',
  '간호 실무에 주는 시사점은 무엇인가요?',
  '이 연구의 한계와 후속 연구 방향은 무엇인가요?',
];

/**
 * Stored message: { id, role: 'user'|'assistant', content, ts, quote?, model?, stopped? }.
 * The model sees a user quote as a markdown blockquote ahead of the question.
 */
function toModelMessage(m) {
  const content = m.role === 'user' && m.quote ? `> ${m.quote.replace(/\n/g, ' ')}\n\n${m.content}` : m.content;
  return { role: m.role, content };
}

class ChatPanel {
  #ctl = new AbortController();
  #stream = null; // AbortController of the in-flight answer
  #shown = false;

  constructor(container, ctx) {
    ensureStyles();
    this.ctx = ctx;
    this.session = getSession(ctx);
    this.history = [];
    this.quote = null;
    const signal = this.#ctl.signal;

    this.list = el('div', { class: 'pf-chat__list', role: 'log', 'aria-live': 'polite' });
    this.scroller = el('div', { class: 'pf-panel__scroll pf-chat__scroll' }, this.list);
    this.quoteBox = el('div', { class: 'pf-chat__quote', hidden: true });
    this.input = el('textarea', {
      class: 'pf-chat__input', rows: '1', 'aria-label': '질문 입력',
      placeholder: '논문에 대해 질문하세요', title: 'Enter: 보내기 · Shift+Enter: 줄바꿈',
    });
    this.sendBtn = button('보내기', { kind: 'primary', onClick: () => this.send(), attrs: { 'data-action': 'send' } });
    this.stopBtn = button('중지', { kind: 'danger', onClick: () => this.stop(), attrs: { 'data-action': 'stop', hidden: true } });
    this.clearBtn = button('기록 지우기', { small: true, onClick: () => this.clear(), attrs: { 'data-action': 'clear' } });
    this.root = el('section', { class: 'pf-panel pf-chat' },
      el('header', { class: 'pf-panel__head' },
        el('div', { class: 'pf-panel__titles' }, el('h2', { class: 'pf-panel__title' }, '논문과 대화')),
        el('div', { class: 'pf-panel__actions' }, this.clearBtn)),
      this.scroller,
      el('div', { class: 'pf-chat__composer' }, this.quoteBox,
        el('div', { class: 'pf-chat__row' }, this.input, this.sendBtn, this.stopBtn)));
    container.append(this.root);

    wireSidLinks(this.list, ctx, signal);
    this.input.addEventListener('keydown', (e) => {
      // e.isComposing / 229: Korean IME is still composing — Enter must not send half a syllable.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        this.send();
      }
    }, { signal });
    this.input.addEventListener('input', () => this.autosize(), { signal });
    this.session.addEventListener('chatquote', () => this.takeQuote(), { signal });
    // Messages added in another tab or on another device appear here (when no answer is streaming).
    const off = ctx.bus?.on?.('paper:ai-change', ({ paperId, ai } = {}) => {
      if (paperId !== ctx.paper?.id || this.#stream) return;
      const next = chatFrom(ai);
      if (sameIds(next, this.history)) return;
      this.history = next;
      this.renderAll();
    });
    if (off) signal.addEventListener('abort', off, { once: true });

    this.loading = this.load();
    this.takeQuote();
  }

  async load() {
    try {
      this.history = chatFrom((await this.ctx.getAi()) || {});
    } catch (err) {
      console.warn('[features] chat load failed', err);
      this.history = [];
    }
    if (this.#ctl.signal.aborted) return;
    await this.renderAll();
  }

  onShow() {
    this.#shown = true;
    this.scrollToBottom(true);
    if (this.quote) this.input.focus();
  }

  takeQuote() {
    const q = this.session.takeChatQuote();
    if (!q?.text) return;
    this.setQuote(q);
    this.input.focus();
  }

  setQuote(q) {
    this.quote = q && q.text ? { text: String(q.text).replace(/\s+/g, ' ').trim(), start: q.start, end: q.end } : null;
    if (!this.quote) {
      this.quoteBox.hidden = true;
      this.quoteBox.replaceChildren();
      return;
    }
    this.quoteBox.hidden = false;
    this.quoteBox.replaceChildren(
      el('span', { class: 'pf-chat__quote-label' }, '인용'),
      el('span', { class: 'pf-chat__quote-text', title: this.quote.text }, clip(this.quote.text, 160)),
      el('button', { type: 'button', class: 'pf-icon-btn', 'aria-label': '인용 지우기', onclick: () => this.setQuote(null) }, '×'));
  }

  async renderAll() {
    this.list.replaceChildren();
    if (!this.history.length) {
      this.list.append(this.intro());
    } else {
      for (const m of this.history) await this.appendMessage(m);
    }
    this.clearBtn.disabled = !this.history.length || Boolean(this.#stream);
    this.scrollToBottom(true);
  }

  intro() {
    if (!hasDocText(this.ctx.doc)) return el('div', { class: 'pf-empty' }, el('p', {}, NO_TEXT_MESSAGE));
    if (!this.ctx.settings.isAiReady()) return aiGate();
    return el('div', { class: 'pf-chat__intro' },
      el('p', { class: 'pf-empty__title' }, '이 논문에 대해 무엇이든 물어보세요.'),
      el('p', { class: 'pf-muted pf-small' }, '답변에 붙는 ‘3쪽’ 같은 칩을 누르면 근거 문장으로 이동합니다.'),
      el('div', { class: 'pf-chat__suggest' },
        SUGGESTIONS.map((q) => el('button', { type: 'button', class: 'pf-chip', onclick: () => this.send(q) }, q))));
  }

  /** Append one message bubble; returns its body element. */
  async appendMessage(m, { streaming = false } = {}) {
    const body = el('div', { class: 'pf-msg__body' });
    const bubble = el('div', { class: `pf-msg pf-msg--${m.role}${streaming ? ' is-streaming' : ''}`, dataset: { id: m.id } });
    if (m.role === 'user') {
      if (m.quote) bubble.append(el('blockquote', { class: 'pf-msg__quote' }, clip(m.quote, 280)));
      body.textContent = m.content;
      bubble.append(body);
    } else {
      body.classList.add('pf-md');
      bubble.append(body);
      if (m.content) await renderModelMarkdown(body, m.content, this.ctx.doc);
      if (m.stopped) bubble.append(el('div', { class: 'pf-msg__note' }, '응답을 중지했습니다.'));
      if (!streaming) bubble.append(this.messageTools(m));
    }
    this.list.append(bubble);
    return body;
  }

  messageTools(m) {
    return el('div', { class: 'pf-msg__tools' },
      el('button', {
        type: 'button', class: 'pf-link-btn',
        onclick: async () => {
          const ok = await copyText(m.content);
          toast(ok ? '답변을 복사했습니다.' : '복사하지 못했습니다.', { kind: ok ? 'success' : 'error' });
        },
      }, '복사'));
  }

  async send(text = this.input.value) {
    const question = String(text ?? '').trim();
    if (!question || this.#stream) return;
    if (!this.ctx.settings.isAiReady()) {
      notifyAiNotReady();
      return;
    }
    const quote = this.quote;
    const userMsg = { id: uid('m'), role: 'user', content: question, ts: Date.now() };
    if (quote) userMsg.quote = quote.text;
    const reply = { id: uid('m'), role: 'assistant', content: '', ts: Date.now() };
    const run = new AbortController();
    this.#stream = run; // claim the slot before any await so a double Enter can't start two answers
    this.setStreaming(true);
    await this.loading; // history must be in place before the first exchange renders/commits
    const prior = this.history.map(toModelMessage);

    this.input.value = '';
    this.autosize();
    this.setQuote(null);
    this.list.querySelector('.pf-chat__intro, .pf-empty')?.remove();
    await this.appendMessage(userMsg);
    const body = await this.appendMessage(reply, { streaming: true });
    const bubble = body.parentElement;
    this.scrollToBottom(true);

    const signal = anySignal(run.signal, this.#ctl.signal, this.ctx.signal);
    const painter = markdownStream(body, this.ctx.doc, { onPaint: () => this.scrollToBottom() });
    let streamed = '';
    try {
      const stream = chat(this.ctx.doc, prior, question, { signal, quote: quote?.text, paperId: this.ctx.paper?.id });
      const { text: answer, model } = await drainStream(stream, (full) => {
        streamed = full;
        painter.update(full);
      });
      reply.content = answer;
      if (model) reply.model = model;
      painter.update(answer);
      await painter.flush();
      this.finishBubble(bubble, reply);
      await this.commit(userMsg, reply);
    } catch (err) {
      await painter.flush().catch(() => {});
      if (isAbortError(err, signal)) {
        this.handleStopped(bubble, userMsg, { ...reply, content: streamed });
      } else {
        console.warn('[features] chat failed', err);
        this.handleFailed(bubble, question, quote, err);
      }
    } finally {
      if (this.#stream === run) this.#stream = null;
      if (!this.#ctl.signal.aborted) this.setStreaming(false);
    }
  }

  finishBubble(bubble, reply) {
    bubble.classList.remove('is-streaming');
    bubble.append(this.messageTools(reply));
  }

  /** A stopped answer keeps whatever streamed so far; an empty one is dropped and the question restored. */
  handleStopped(bubble, userMsg, reply) {
    const stoppedReply = { ...reply, stopped: true };
    if (this.#ctl.signal.aborted || this.ctx.signal?.aborted) {
      // Panel or paper closed mid-answer: keep the partial answer, skip the UI.
      if (reply.content) this.commit(userMsg, stoppedReply);
      return;
    }
    if (!reply.content.trim()) {
      bubble.previousElementSibling?.remove();
      bubble.remove();
      this.input.value = userMsg.content;
      this.autosize();
      if (userMsg.quote) this.setQuote({ text: userMsg.quote });
      if (!this.history.length) this.list.append(this.intro());
      return;
    }
    bubble.classList.remove('is-streaming');
    bubble.append(el('div', { class: 'pf-msg__note' }, '응답을 중지했습니다.'), this.messageTools(stoppedReply));
    this.commit(userMsg, stoppedReply);
  }

  handleFailed(bubble, question, quote, err) {
    bubble.classList.remove('is-streaming');
    bubble.classList.add('pf-msg--error');
    bubble.replaceChildren(
      el('div', { class: 'pf-msg__body' }, errorMessage(err, '답변을 받지 못했습니다.')),
      el('div', { class: 'pf-msg__tools' }, el('button', {
        type: 'button', class: 'pf-link-btn',
        onclick: () => {
          bubble.previousElementSibling?.remove();
          bubble.remove();
          if (quote) this.setQuote(quote);
          this.send(question);
        },
      }, '다시 시도')));
  }

  /** Append the finished exchange to the stored history (only complete pairs are stored). */
  async commit(userMsg, reply) {
    this.history = [...this.history, userMsg, reply].slice(-MAX_HISTORY);
    this.clearBtn.disabled = Boolean(this.#stream);
    try {
      await this.ctx.saveAi({ chat: this.history });
    } catch (err) {
      console.warn('[features] chat save failed', err);
      toast('채팅 기록을 저장하지 못했습니다.', { kind: 'error' });
    }
  }

  stop() {
    this.#stream?.abort();
  }

  async clear() {
    if (!this.history.length || this.#stream) return;
    const ok = await confirmDialog('이 논문의 채팅 기록을 모두 지울까요? 되돌릴 수 없습니다.', { okLabel: '지우기', danger: true });
    if (!ok) return;
    this.history = [];
    await this.renderAll();
    try {
      // chat merges by message id across tabs and devices, so a clear is recorded as a cut-off time.
      await this.ctx.saveAi({ chat: [], chatClearedAt: Date.now() });
    } catch (err) {
      console.warn('[features] chat clear failed', err);
      toast('채팅 기록을 지우지 못했습니다.', { kind: 'error' });
    }
  }

  setStreaming(on) {
    this.sendBtn.hidden = on;
    this.stopBtn.hidden = !on;
    this.clearBtn.disabled = on || !this.history.length;
  }

  autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 160)}px`;
  }

  /** Follow the stream only if the user hasn't scrolled up to read. */
  scrollToBottom(force = false) {
    const s = this.scroller;
    const near = s.scrollHeight - s.scrollTop - s.clientHeight < 80;
    if (force || near) s.scrollTop = s.scrollHeight;
  }

  destroy() {
    this.#ctl.abort();
    this.#stream?.abort();
    this.root.remove();
  }
}

/** Stored chat messages (after the last clear), oldest first. */
function chatFrom(ai) {
  const cleared = Number(ai?.chatClearedAt) || 0;
  return Array.isArray(ai?.chat)
    ? ai.chat.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && !(cleared && (Number(m.ts) || 0) <= cleared))
    : [];
}

function sameIds(a, b) {
  return a.length === b.length && a.every((m, i) => m.id === b[i]?.id);
}

export const chatPanel = {
  id: 'chat',
  title: '채팅',
  icon: 'message',
  mount(container, ctx) {
    const panel = new ChatPanel(container, ctx);
    return { onShow: () => panel.onShow(), destroy: () => panel.destroy() };
  },
};
