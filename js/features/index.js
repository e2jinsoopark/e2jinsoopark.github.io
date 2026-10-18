// Reader features: right-pane panels (요약 / 채팅 / 메모 / 관련 논문) and the in-reader
// behaviours installed per open paper (selection menu, link previews, figure explain,
// key-sentence underlines, highlight rendering).
import { installAnnotationMarks } from './annotations.js';
import { installAutoHighlight } from './autohighlight.js';
import { chatPanel } from './chat.js';
import { installCitations } from './citations.js';
import { installRegionExplain } from './explain.js';
import { notesPanel } from './notes.js';
import { relatedPanel } from './related.js';
import { installSelectionMenu } from './selection-menu.js';
import { getSession } from './session.js';
import { ensureStyles } from './styles.js';
import { summaryPanel } from './summary.js';

/** @type {{ id: 'summary'|'chat'|'notes'|'related', title: string, icon: string,
 *           mount(container: HTMLElement, ctx: object): { onShow?(): void, destroy?(): void } }[]} */
export const panels = [summaryPanel, chatPanel, notesPanel, relatedPanel];

const INSTALLERS = [
  ['annotations', installAnnotationMarks],
  ['selection-menu', installSelectionMenu],
  ['citations', installCitations],
  ['explain', installRegionExplain],
  ['autohighlight', installAutoHighlight],
];

/**
 * Install the per-paper reader behaviours. Call once per opened paper with the same ctx the
 * panels get; everything is torn down by dispose() or when ctx.signal aborts.
 * @returns {{ dispose(): void }}
 */
export function installReaderFeatures(ctx) {
  ensureStyles();
  const session = getSession(ctx);
  const life = new AbortController();
  for (const [name, install] of INSTALLERS) {
    try {
      install(ctx, session, { signal: life.signal });
    } catch (err) {
      // One broken feature must not take the reader down with it.
      console.warn(`[features] ${name} install failed`, err);
    }
  }
  const dispose = () => {
    if (life.signal.aborted) return;
    life.abort();
    session.annotations.flush().catch((err) => console.warn('[features] final annotations save failed', err));
  };
  ctx.signal?.addEventListener('abort', dispose, { once: true });
  return { dispose };
}

export { getSession } from './session.js';
