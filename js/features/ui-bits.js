// Floating side card the features need beyond ui/components.js (a popover closes on outside
// clicks; an explanation must stay open while the user keeps reading).
import { clamp, el } from '../core/util.js';

const openCards = [];

// Bubble phase, so modals/popovers that handle Escape themselves (preventDefault) win.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !openCards.length || e.defaultPrevented) return;
  const active = document.activeElement;
  const top = openCards.at(-1);
  if (active?.closest?.('[aria-modal="true"]') && !top.el.contains(active)) return;
  top.close();
});

/**
 * A non-modal card that floats over the reader (fixed position, draggable by its header).
 * Docked bottom-right by default: over the translation pane (not the PDF) and clear of the toolbar/tabs.
 * @param {{ title: string, badge?: string, className?: string, width?: number, onClose?: () => void }} opts
 */
export function floatingCard({ title, badge = '', className = '', width = 420, onClose } = {}) {
  let closed = false;
  const closeBtn = el('button', { type: 'button', class: 'pf-icon-btn', 'aria-label': '닫기', title: '닫기 (Esc)' }, '×');
  const badgeEl = el('span', { class: 'pf-badge' }, badge);
  const head = el('header', { class: 'pf-card__head' },
    el('strong', { class: 'pf-card__title' }, title), badge ? badgeEl : null, el('span', { class: 'pf-spacer' }), closeBtn);
  const body = el('div', { class: 'pf-card__body' });
  const foot = el('footer', { class: 'pf-card__foot' });
  const root = el('section', { class: `pf-card ${className}`.trim(), role: 'dialog', 'aria-label': title }, head, body, foot);

  const w = Math.min(width, window.innerWidth - 24);
  Object.assign(root.style, { width: `${w}px`, right: '16px', bottom: '16px' });
  document.body.append(root);

  const card = {
    el: root, head, body, foot,
    get closed() { return closed; },
    setBadge(text) { badgeEl.textContent = text; },
    close() {
      if (closed) return;
      closed = true;
      const i = openCards.indexOf(card);
      if (i >= 0) openCards.splice(i, 1);
      root.remove();
      onClose?.();
    },
  };
  closeBtn.addEventListener('click', () => card.close());
  makeDraggable(root, head);
  openCards.push(card);
  return card;
}

function makeDraggable(root, handle) {
  let start = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = root.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    handle.setPointerCapture(e.pointerId);
    root.classList.add('is-dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!start) return;
    const r = root.getBoundingClientRect();
    const left = clamp(start.left + e.clientX - start.x, 8 - r.width + 80, window.innerWidth - 80);
    const top = clamp(start.top + e.clientY - start.y, 8, window.innerHeight - 48);
    Object.assign(root.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
  });
  const end = () => { start = null; root.classList.remove('is-dragging'); };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
