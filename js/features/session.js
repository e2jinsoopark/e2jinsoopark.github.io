// Per-open-paper state shared between installReaderFeatures() and the panels, which the shell
// mounts separately (in any order) with the same FeatureContext.
import { emit } from '../core/bus.js';
import { AnnotationStore } from './annotations.js';

/** Keyed by ctx.signal (one per opened paper) so copies of ctx still share a session. */
const sessions = new WeakMap();

/**
 * Events: 'chatquote' {} — a quote is waiting for the chat panel (take it with takeChatQuote()).
 */
export class FeatureSession extends EventTarget {
  #pendingQuote = null;
  #disposed = false;

  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.annotations = new AnnotationStore({ library: ctx.library, paperId: ctx.paper.id });
    void this.annotations.ready; // start loading right away
    /** Semantic Scholar lookups for reference cards, by reference index → Promise<paper|null>. */
    this.refLookups = new Map();
    /** The explanation card currently on screen (only one at a time). */
    this.explainCard = null;
  }

  /** Hand a quoted passage to the chat panel and switch to it. */
  askInChat(quote) {
    this.#pendingQuote = quote;
    this.ctx.openPanel?.('chat');
    emit(this, 'chatquote', {});
  }

  /** The chat panel calls this on mount and on 'chatquote'; each quote is delivered once. */
  takeChatQuote() {
    const q = this.#pendingQuote;
    this.#pendingQuote = null;
    return q;
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.explainCard?.close();
    try { await this.annotations.flush(); } finally { this.annotations.dispose(); }
  }
}

export function getSession(ctx) {
  const key = ctx.signal ?? ctx;
  let s = sessions.get(key);
  if (!s) {
    s = new FeatureSession(ctx);
    sessions.set(key, s);
    ctx.signal?.addEventListener('abort', () => { s.dispose().catch(() => {}); }, { once: true });
  }
  return s;
}
