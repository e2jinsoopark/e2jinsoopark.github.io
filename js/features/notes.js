// 메모 panel: every highlight/note grouped by page, colour filter, click → jump,
// inline note editing, delete with undo, Markdown export.
import { el } from '../core/util.js';
import { spinner, toast } from '../ui/components.js';
import { removeWithUndo } from './annotations.js';
import { COLOR_LABELS, HIGHLIGHT_COLORS, button, copyText, emptyState, formatDateTime, jumpToOffset, pageAt } from './shared.js';
import { getSession } from './session.js';
import { ensureStyles } from './styles.js';

class NotesPanel {
  #ctl = new AbortController();
  #editing = null;       // id of the annotation whose note is being edited
  #renderQueued = false; // a store change arrived while editing

  constructor(container, ctx) {
    ensureStyles();
    this.ctx = ctx;
    this.store = getSession(ctx).annotations;
    this.filter = { color: 'all', notesOnly: false };
    this.count = el('span', { class: 'pf-muted pf-small' });
    this.filters = el('div', { class: 'pf-filter', role: 'toolbar', 'aria-label': '색상 필터' });
    this.listEl = el('div', { class: 'pf-notes__list' });
    this.root = el('section', { class: 'pf-panel pf-notes' },
      el('header', { class: 'pf-panel__head' },
        el('div', { class: 'pf-panel__titles' }, el('h2', { class: 'pf-panel__title' }, '하이라이트·메모'), this.count),
        el('div', { class: 'pf-panel__actions' },
          button('Markdown 복사', { small: true, onClick: () => this.exportMarkdown(), attrs: { 'data-action': 'export' } }))),
      this.filters,
      el('div', { class: 'pf-panel__scroll' }, this.listEl));
    container.append(this.root);

    this.store.addEventListener('change', (e) => this.onStoreChange(e.detail), { signal: this.#ctl.signal });
    if (this.store.loaded) this.render();
    else {
      this.listEl.replaceChildren(el('div', { class: 'pf-loading' }, spinner(16), el('span', {}, '불러오는 중…')));
      this.store.ready.then(() => { if (!this.#ctl.signal.aborted) this.render(); });
    }
  }

  onShow() {
    if (!this.#editing) this.render();
  }

  onStoreChange({ reason, item } = {}) {
    if (this.#editing) {
      // Don't wipe a half-written note; re-render once editing ends (unless the item itself vanished).
      if (reason === 'remove' && item?.id === this.#editing) this.#editing = null;
      else { this.#renderQueued = true; return; }
    }
    this.render();
  }

  visibleItems() {
    return this.store.items.filter((a) => (this.filter.color === 'all' || a.color === this.filter.color)
      && (!this.filter.notesOnly || a.note.trim()));
  }

  render() {
    const all = this.store.items;
    this.count.textContent = all.length ? `${all.length}개` : '';
    this.renderFilters(all);
    const items = this.visibleItems();
    if (!all.length) {
      this.listEl.replaceChildren(emptyState('아직 하이라이트가 없습니다.',
        'PDF에서 문장을 드래그해 선택하면 색을 칠하거나 메모를 남길 수 있습니다.'));
      return;
    }
    if (!items.length) {
      this.listEl.replaceChildren(emptyState('조건에 맞는 항목이 없습니다.', '필터를 바꿔 보세요.'));
      return;
    }
    const groups = new Map();
    for (const a of items) {
      const page = pageAt(this.ctx.doc, a.anchor.start);
      if (!groups.has(page)) groups.set(page, []);
      groups.get(page).push(a);
    }
    const sections = [...groups.entries()].sort((x, y) => x[0] - y[0]).map(([page, list]) =>
      el('section', { class: 'pf-notes__group', dataset: { page: String(page) } },
        el('h3', { class: 'pf-notes__page' }, `${page}쪽`, el('span', { class: 'pf-muted' }, ` · ${list.length}`)),
        list.map((a) => this.itemView(a))));
    const top = this.listEl.parentElement?.scrollTop ?? 0;
    this.listEl.replaceChildren(...sections);
    if (this.listEl.parentElement) this.listEl.parentElement.scrollTop = top;
  }

  renderFilters(all) {
    const counts = Object.fromEntries(HIGHLIGHT_COLORS.map((c) => [c.id, 0]));
    for (const a of all) counts[a.color] += 1;
    const chip = (id, label, n, swatch) => el('button', {
      type: 'button', class: `pf-chip${this.filter.color === id ? ' is-active' : ''}`,
      'aria-pressed': String(this.filter.color === id), dataset: { color: id },
      onclick: () => { this.filter.color = id; this.render(); },
    }, swatch ? el('span', { class: `pf-swatch pf-swatch--${id}`, 'aria-hidden': 'true' }) : null, `${label} ${n}`);
    this.filters.replaceChildren(
      chip('all', '전체', all.length, false),
      ...HIGHLIGHT_COLORS.filter((c) => counts[c.id]).map((c) => chip(c.id, c.label, counts[c.id], true)),
      el('label', { class: 'pf-check' },
        el('input', {
          type: 'checkbox', checked: this.filter.notesOnly,
          onchange: (e) => { this.filter.notesOnly = e.target.checked; this.render(); },
        }), '메모만'));
    this.filters.hidden = !all.length;
  }

  itemView(a) {
    const noteBox = el('div', { class: 'pf-note__note' });
    this.fillNote(noteBox, a);
    const node = el('article', {
      class: `pf-note pf-note--${a.color}`, tabindex: '0', dataset: { id: a.id },
      title: '클릭하면 원문 위치로 이동합니다',
    },
      el('blockquote', { class: 'pf-note__quote' }, a.quote || '(빈 인용)'),
      noteBox,
      el('footer', { class: 'pf-note__foot' },
        el('span', { class: 'pf-muted pf-small' }, `${COLOR_LABELS[a.color]} · ${formatDateTime(a.updatedAt)}`),
        el('span', { class: 'pf-spacer' }),
        el('button', { type: 'button', class: 'pf-link-btn', dataset: { action: 'edit' }, onclick: () => this.edit(a.id, node) },
          a.note ? '메모 편집' : '메모 추가'),
        el('button', { type: 'button', class: 'pf-link-btn pf-link-btn--danger', dataset: { action: 'delete' }, onclick: () => removeWithUndo(this.store, a.id) },
          '삭제')));
    node.addEventListener('click', (e) => {
      if (e.target.closest('button, textarea, input, a') || node.classList.contains('is-editing')) return;
      jumpToOffset(this.ctx, a.anchor.start);
    });
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === node) jumpToOffset(this.ctx, a.anchor.start);
    });
    return node;
  }

  fillNote(box, a) {
    box.replaceChildren(a.note ? el('p', {}, a.note) : '');
    box.hidden = !a.note;
  }

  edit(id, node) {
    const a = this.store.get(id);
    if (!a) return;
    if (this.#editing && this.#editing !== id) {
      // One editor at a time: drop the other (unsaved) one and re-find this item's fresh node.
      this.#editing = null;
      this.#renderQueued = false;
      this.render();
      node = this.listEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (!node) return;
    }
    this.#editing = id;
    node.classList.add('is-editing');
    const box = node.querySelector('.pf-note__note');
    const area = el('textarea', { class: 'pf-textarea', rows: '3', placeholder: '메모를 입력하세요', 'aria-label': '메모' });
    area.value = a.note;
    const colors = el('div', { class: 'pf-swatches', role: 'radiogroup', 'aria-label': '색' },
      HIGHLIGHT_COLORS.map((c) => el('button', {
        type: 'button', class: `pf-swatch-btn pf-swatch--${c.id}${c.id === a.color ? ' is-active' : ''}`,
        role: 'radio', 'aria-checked': String(c.id === a.color), 'aria-label': c.label, dataset: { color: c.id },
        onclick: (e) => {
          colors.querySelectorAll('.pf-swatch-btn').forEach((b) => { b.classList.remove('is-active'); b.setAttribute('aria-checked', 'false'); });
          e.currentTarget.classList.add('is-active');
          e.currentTarget.setAttribute('aria-checked', 'true');
          colors.dataset.value = c.id;
        },
      })));
    colors.dataset.value = a.color;
    const finish = (save) => {
      if (save) this.store.update(id, { note: area.value.trim(), color: colors.dataset.value });
      this.#editing = null;
      if (save || this.#renderQueued) { this.#renderQueued = false; this.render(); return; }
      node.classList.remove('is-editing');
      this.fillNote(box, a);
    };
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    box.hidden = false;
    box.replaceChildren(area, el('div', { class: 'pf-note__edit-row' }, colors, el('span', { class: 'pf-spacer' }),
      button('취소', { small: true, onClick: () => finish(false) }),
      button('저장', { small: true, kind: 'primary', onClick: () => finish(true), attrs: { 'data-action': 'save' } })));
    area.focus();
  }

  async exportMarkdown() {
    const items = this.visibleItems();
    if (!items.length) { toast('복사할 항목이 없습니다.'); return; }
    const title = this.ctx.doc?.meta?.title || this.ctx.paper?.title || '논문';
    const lines = [`# ${title} — 하이라이트·메모`, ''];
    let lastPage = null;
    for (const a of items) {
      const page = pageAt(this.ctx.doc, a.anchor.start);
      if (page !== lastPage) { lines.push(`## ${page}쪽`, ''); lastPage = page; }
      lines.push(`- (${COLOR_LABELS[a.color]}) “${a.quote}”`);
      if (a.note) lines.push(`  - 메모: ${a.note.replace(/\n+/g, ' ')}`);
    }
    const ok = await copyText(lines.join('\n'));
    toast(ok ? 'Markdown으로 복사했습니다.' : '복사하지 못했습니다.', { kind: ok ? 'success' : 'error' });
  }

  destroy() {
    this.#ctl.abort();
    this.root.remove();
  }
}

export const notesPanel = {
  id: 'notes',
  title: '메모',
  icon: 'note',
  mount(container, ctx) {
    const panel = new NotesPanel(container, ctx);
    return { onShow: () => panel.onShow(), destroy: () => panel.destroy() };
  },
};
