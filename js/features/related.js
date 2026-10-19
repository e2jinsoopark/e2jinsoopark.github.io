// 관련 논문 panel, keyless and PubMed first: the open paper is found in PubMed (DOI, else title), its PubMed
// similar articles (ELink neighbours) are listed with Europe PMC citation counts and free full-text links,
// and "이 폴더 기준 추천" sums neighbour scores over the folder's papers. Semantic Scholar is used only when
// PubMed / Europe PMC do not know the paper. pmid/doi are stored on the paper; results are cached in ai.related.
// Nothing is sent before the once-per-browser consent (scholarly.js).
import { el, safeStorage } from '../core/util.js';
import { renderMarkdown, spinner } from '../ui/components.js';
import { quickTranslate } from '../ai/tasks.js';
import { abstractNodes, linkBadges } from './paper-bits.js';
import { ensureRelatedStyles } from './related-styles.js';
import { formatAuthors } from './s2.js';
import {
  CONSENT_SERVICES, fetchAbstract, grantConsent, hasConsent, identifyPaper, paperDoi, primaryUrl,
  relatedForPmid, relatedForPmids, s2Related,
} from './scholarly.js';
import { anySignal, button, emptyState, errorMessage, externalLink, formatDateTime, isAbortError, notifyAiNotReady } from './shared.js';
import { ensureStyles } from './styles.js';

const SORT_KEY = 'pr.features.relatedSort.v1';
const SORTS = [['relevance', '관련도'], ['recent', '최신순'], ['cited', '인용순']];
/** Folder recommendations use at most this many of the folder's papers. */
export const FOLDER_MAX = 10;

const toTime = (v) => (typeof v === 'number' ? v : Date.parse(v) || 0);

/** Items in the chosen order (stable: ties keep PubMed's relevance order). */
export function sortItems(items, sort) {
  const list = (items || []).map((p, i) => ({ p, i }));
  const dateKey = (p) => String(p.date || p.year || '');
  if (sort === 'recent') list.sort((a, b) => dateKey(b.p).localeCompare(dateKey(a.p)) || a.i - b.i);
  else if (sort === 'cited') list.sort((a, b) => (b.p.citationCount ?? -1) - (a.p.citationCount ?? -1) || a.i - b.i);
  return list.map((x) => x.p);
}

class RelatedPanel {
  #ctl = new AbortController();
  #run = null;
  #started = false;
  #saveTimer = null;
  #savePending = false;

  constructor(container, ctx) {
    ensureStyles();
    ensureRelatedStyles();
    this.ctx = ctx;
    /** ai.related: { source: 'pubmed'|'s2', pmid?, doi?, s2PaperId?, paper, items, citations?, fetchedAt, folder? } */
    this.related = null;
    this.view = 'paper';
    this.sort = SORTS.some(([id]) => id === safeStorage.get(SORT_KEY, '')) ? safeStorage.get(SORT_KEY, '') : 'relevance';
    this.meta = el('span', { class: 'pf-muted pf-small' });
    this.refreshBtn = button('새로 고침', { small: true, onClick: () => this.refresh(), attrs: { 'data-action': 'refresh' } });
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

  record() {
    const { library, paper } = this.ctx;
    return library?.getPaper?.(paper.id) ?? paper ?? {};
  }

  paperTitle() {
    const { doc } = this.ctx;
    const rec = this.record();
    return (doc?.meta?.title || rec.title || String(rec.fileName || '').replace(/\.pdf$/i, '') || '').trim();
  }

  /** Live papers in this paper's folder (this one first, then the most recently opened), or [] at top level. */
  folderPapers() {
    const rec = this.record();
    const folderId = rec.folderId ?? null;
    if (!folderId) return [];
    let list = [];
    try { list = [...(this.ctx.library?.papers || [])]; } catch { list = []; }
    list = list.filter((p) => p && !p.deleted && (p.folderId ?? null) === folderId);
    if (!list.some((p) => p.id === rec.id)) list.push(rec);
    const others = list.filter((p) => p.id !== rec.id)
      .sort((a, b) => toTime(b.lastOpenedAt) - toTime(a.lastOpenedAt) || toTime(b.addedAt) - toTime(a.addedAt));
    return [rec, ...others];
  }

  folderName() {
    const id = this.record().folderId;
    try { return this.ctx.library?.getFolder?.(id)?.name || ''; } catch { return ''; }
  }

  /** Data is fetched lazily the first time the tab is shown (it costs network round trips). */
  onShow() {
    if (this.#started) return;
    this.#started = true;
    this.loadCached();
  }

  async loadCached() {
    try {
      const ai = (await this.ctx.getAi()) || {};
      if (ai.related && typeof ai.related === 'object') this.related = ai.related;
    } catch (err) {
      console.warn('[features] related cache read failed', err);
    }
    if (this.signal.aborted) return;
    if (Array.isArray(this.related?.items)) { this.render(); return; }
    if (hasConsent()) this.fetch();
    else this.renderConsent(() => this.fetch());
  }

  /** The first lookup sends this paper's title / DOI to third parties: say so and let the user start it. */
  renderConsent(onAgree) {
    const title = this.paperTitle();
    const short = title.length > 80 ? `${title.slice(0, 79)}…` : title;
    this.meta.textContent = '';
    this.body.replaceChildren(el('div', { class: 'pf-empty pf-related__consent' },
      el('p', { class: 'pf-empty__title' }, '관련 논문을 PubMed에서 찾습니다.'),
      el('p', { class: 'pf-muted' }, `논문 제목·DOI나 참고문헌 문구를 아래 공개 학술 데이터베이스로 보내 관련 논문과 참고문헌 정보를 찾습니다. API 키는 필요 없습니다.`),
      el('ul', {},
        el('li', {}, 'PubMed(미국 국립의학도서관) — 논문 찾기·유사 논문'),
        el('li', {}, 'Europe PMC — 인용 수·무료 전문·초록'),
        el('li', {}, 'Crossref — 참고문헌 DOI 찾기'),
        el('li', {}, 'Semantic Scholar — 위에서 찾지 못했을 때만')),
      el('p', { class: 'pf-muted pf-small' },
        `보내는 내용: 이 논문의 제목${short ? `(“${short}”)` : ''}과 DOI, 같은 폴더 논문의 제목. 한 번 동의하면 이 브라우저에서는 다시 묻지 않습니다. 미출판 원고라면 찾지 않는 편이 안전합니다.`),
      el('div', { class: 'pf-row' }, button('동의하고 찾기', {
        kind: 'primary', attrs: { 'data-action': 'scholar-consent', title: CONSENT_SERVICES },
        onClick: () => { grantConsent(); onAgree(); },
      }))));
  }

  #begin() {
    this.#run?.abort();
    const run = new AbortController();
    this.#run = run;
    this.refreshBtn.disabled = true;
    return { run, signal: anySignal(run.signal, this.signal, this.ctx.signal) };
  }

  #end(run) {
    if (this.#run !== run) return;
    this.#run = null;
    if (!this.signal.aborted) this.refreshBtn.disabled = false;
  }

  loading(text) {
    this.body.replaceChildren(el('div', { class: 'pf-loading' }, spinner(18), el('span', {}, text)));
  }

  /** Save pmid / doi (or the Semantic Scholar id) on the paper so it is looked up once. */
  remember(patch) {
    const rec = this.record();
    const changes = Object.fromEntries(Object.entries(patch).filter(([k, v]) => v && rec[k] !== v));
    if (!Object.keys(changes).length) return;
    try { this.ctx.library?.updatePaper?.(this.ctx.paper.id, changes); } catch (err) { console.warn('[features] could not store paper ids', err); }
  }

  refresh() {
    if (this.view === 'folder') this.fetchFolder({ force: true });
    else this.fetch();
  }

  /**
   * Related papers for the open paper.
   * @param {{ query?: string }} opts query: a title / DOI / PMID typed by the user (replaces the stored match)
   */
  async fetch({ query } = {}) {
    if (!hasConsent()) { this.renderConsent(() => this.fetch({ query })); return; }
    this.view = 'paper';
    const { run, signal } = this.#begin();
    const rec = this.record();
    const title = query ?? this.paperTitle();
    const keepFolder = this.related?.folder ? { folder: this.related.folder } : {};
    try {
      let pmid = query == null ? rec.pmid || null : null;
      let matched = null;
      if (pmid) {
        matched = this.related?.source === 'pubmed' && this.related?.pmid === pmid && this.related.paper
          ? this.related.paper
          : await identifyPaper({ pmid }, { signal });
        if (!matched) pmid = null; // a stored PMID PubMed no longer knows: look the paper up again
      }
      if (!pmid) {
        this.loading('PubMed에서 이 논문을 찾는 중…');
        const { doi, fromText } = query == null ? paperDoi(this.ctx.doc, rec) : { doi: null, fromText: false };
        matched = await identifyPaper({ title, year: this.ctx.doc?.meta?.year || rec.year || null, doi, doiFromText: fromText, query }, { signal });
        pmid = matched?.pmid ?? null;
        if (pmid) this.remember({ pmid, doi: matched.doi });
      }
      if (pmid) {
        this.loading('PubMed 유사 논문을 모으는 중…');
        const { items, self, citations } = await relatedForPmid(pmid, { signal, self: matched });
        let next = { source: 'pubmed', pmid, doi: matched?.doi ?? null, paper: self ?? matched, items, citations, fetchedAt: Date.now() };
        if (!items.length) {
          const s2 = await this.#s2Fallback({ pmid }, signal);
          if (s2?.items.length) next = { ...next, source: 's2', fallback: 'no-neighbors', items: s2.items, citations: true };
        }
        this.related = { ...keepFolder, ...next };
      } else {
        this.loading('PubMed에서 찾지 못해 Semantic Scholar에서 찾는 중…');
        const s2 = title ? await this.#s2Fallback({ title }, signal) : null;
        if (!s2) { this.renderNotFound(title); return; }
        if (s2.s2PaperId) this.remember({ s2PaperId: s2.s2PaperId });
        this.related = { ...keepFolder, source: 's2', fallback: 'not-in-pubmed', s2PaperId: s2.s2PaperId, paper: s2.paper, items: s2.items, fetchedAt: Date.now() };
      }
      this.render();
      await this.#persist();
    } catch (err) {
      if (isAbortError(err, signal) || this.#run !== run) return;
      console.warn('[features] related fetch failed', err);
      this.renderError(err, () => this.fetch({ query }));
    } finally {
      this.#end(run);
    }
  }

  /** Semantic Scholar only as a last resort; its failures mean "not found", never an error screen. */
  async #s2Fallback(opts, signal) {
    try {
      const apiKey = this.ctx.settings?.get?.()?.semanticScholar?.apiKey || '';
      return await s2Related({ ...opts, apiKey, signal });
    } catch (err) {
      if (signal.aborted) throw err;
      console.warn('[features] Semantic Scholar fallback failed', err);
      return null;
    }
  }

  folderKey(papers) {
    return `${this.record().folderId}:${papers.map((p) => p.id).sort().join(',')}`;
  }

  /** "이 폴더 기준 추천": neighbour scores summed over up to 10 of the folder's papers. */
  async fetchFolder({ force = false } = {}) {
    if (!hasConsent()) { this.renderConsent(() => this.fetchFolder({ force })); return; }
    this.view = 'folder';
    const papers = this.folderPapers().slice(0, FOLDER_MAX);
    const key = this.folderKey(papers);
    const cached = this.related?.folder;
    if (!force && cached?.key === key && Array.isArray(cached.items)) { this.render(); return; }
    const { run, signal } = this.#begin();
    try {
      // Papers looked up before (any folder composition) are not looked up again unless 새로 고침.
      const known = new Map(Array.isArray(cached?.sources) ? cached.sources.map((s) => [s.id, s]) : []);
      const sources = [];
      const self = this.record();
      for (const [i, p] of papers.entries()) {
        let pmid = p.pmid || (p.id === self.id ? this.related?.pmid : null) || known.get(p.id)?.pmid || null;
        if (!pmid && (force || !known.get(p.id)?.tried)) {
          this.loading(`폴더 논문을 PubMed에서 확인하는 중… (${i + 1}/${papers.length})`);
          const isSelf = p.id === self.id;
          const { doi, fromText } = isSelf ? paperDoi(this.ctx.doc, self) : { doi: p.doi || null, fromText: false };
          const hit = await identifyPaper({ title: (isSelf ? this.paperTitle() : p.title) || '', year: p.year || null, doi, doiFromText: fromText }, { signal });
          pmid = hit?.pmid ?? null;
          if (pmid) {
            try { this.ctx.library?.updatePaper?.(p.id, Object.fromEntries(Object.entries({ pmid, doi: hit.doi }).filter(([k, v]) => v && p[k] !== v))); } catch (err) { console.warn('[features] could not store paper ids', err); }
          }
        }
        sources.push({ id: p.id, pmid, tried: true });
      }
      const pmids = sources.map((s) => s.pmid).filter(Boolean);
      let items = [];
      let citations = true;
      if (pmids.length) {
        this.loading(`폴더 논문 ${pmids.length}편의 유사 논문을 모으는 중…`);
        ({ items, citations } = await relatedForPmids(pmids, { signal }));
      }
      const folder = { key, folderId: this.record().folderId, sources, items, citations, fetchedAt: Date.now() };
      this.related = { ...(this.related || {}), folder };
      this.render();
      await this.#persist();
    } catch (err) {
      if (isAbortError(err, signal) || this.#run !== run) return;
      console.warn('[features] folder related fetch failed', err);
      this.renderError(err, () => this.fetchFolder({ force }));
    } finally {
      this.#end(run);
    }
  }

  setView(view) {
    if (view === this.view && this.#run) return;
    this.#run?.abort();
    if (view === 'folder') { this.fetchFolder(); return; }
    this.view = 'paper';
    if (Array.isArray(this.related?.items)) this.render();
    else this.fetch();
  }

  setSort(sort) {
    this.sort = sort;
    safeStorage.set(SORT_KEY, sort);
    this.render();
  }

  // --- rendering -------------------------------------------------------------------------------

  tools() {
    const sortGroup = el('div', { class: 'pf-related__sort', role: 'group', 'aria-label': '정렬' },
      SORTS.map(([id, label]) => el('button', {
        type: 'button', class: `pf-chip${this.sort === id ? ' is-active' : ''}`, 'aria-pressed': String(this.sort === id),
        dataset: { action: 'sort', sort: id }, onclick: () => this.setSort(id),
      }, label)));
    const folder = this.folderPapers();
    const folderBtn = folder.length >= 2 || this.view === 'folder'
      ? el('button', {
        type: 'button', class: `pf-chip${this.view === 'folder' ? ' is-active' : ''}`, 'aria-pressed': String(this.view === 'folder'),
        dataset: { action: 'folder' }, title: `이 폴더의 논문 ${Math.min(folder.length, FOLDER_MAX)}편을 함께 기준으로 추천합니다.`,
        onclick: () => this.setView(this.view === 'folder' ? 'paper' : 'folder'),
      }, '이 폴더 기준 추천')
      : null;
    return el('div', { class: 'pf-related__tools' }, sortGroup, el('span', { class: 'pf-spacer' }), folderBtn);
  }

  render() {
    if (this.view === 'folder') { this.renderFolder(); return; }
    const r = this.related;
    if (!Array.isArray(r?.items)) { this.fetch(); return; }
    const isS2 = r.source !== 'pubmed';
    this.meta.textContent = r.fetchedAt ? `${isS2 ? 'Semantic Scholar' : 'PubMed'} · ${formatDateTime(r.fetchedAt)}` : '';
    this.refreshBtn.disabled = false;
    const source = r.source === 'pubmed'
      ? `출처: PubMed 유사 논문 · 인용 수 Europe PMC${r.citations === false ? ' (인용 수를 불러오지 못했습니다)' : ''}`
      : r.fallback === 'no-neighbors'
        ? '출처: Semantic Scholar 추천 (PubMed에 아직 유사 논문 정보가 없습니다)'
        : r.fallback === 'not-in-pubmed'
          ? '출처: Semantic Scholar 추천 (PubMed에서 이 논문을 찾지 못했습니다)'
          : '출처: Semantic Scholar 추천 (이전에 찾은 결과 · 새로 고침하면 PubMed에서 다시 찾습니다)';
    const parts = [this.matchedCard(r), this.tools(), el('p', { class: 'pf-related__source', dataset: { source: r.source || 's2' } }, source)];
    if (!r.items.length) {
      parts.push(emptyState('관련 논문이 없습니다.', 'PubMed가 이 논문의 유사 논문을 아직 계산하지 않았을 수 있습니다.'));
    } else {
      parts.push(el('ol', { class: 'pf-related__list' }, sortItems(r.items, this.sort).map((p) => this.itemView(p, r.items))));
    }
    this.body.replaceChildren(...parts);
  }

  renderFolder() {
    const f = this.related?.folder;
    if (!f || !Array.isArray(f.items)) { this.fetchFolder(); return; }
    this.meta.textContent = f.fetchedAt ? `PubMed · ${formatDateTime(f.fetchedAt)}` : '';
    this.refreshBtn.disabled = false;
    const srcs = Array.isArray(f.sources) ? f.sources : [];
    const found = srcs.filter((s) => s.pmid).length;
    const name = this.folderName();
    const head = el('div', { class: 'pf-related__match pf-related__folder' },
      el('div', { class: 'pf-muted pf-small' }, '기준'),
      el('div', { class: 'pf-related__match-title' }, `${name ? `‘${name}’ 폴더` : '이 폴더'}의 논문 ${srcs.length}편`),
      el('div', { class: 'pf-related__folder-note' },
        found === srcs.length ? `모두 PubMed에서 찾았습니다.` : `PubMed에서 찾은 ${found}편을 기준으로 추천합니다.`,
        this.folderPapers().length > FOLDER_MAX ? ` (폴더 논문이 많아 최근에 연 ${FOLDER_MAX}편만 썼습니다.)` : ''));
    const parts = [head, this.tools(), el('p', { class: 'pf-related__source', dataset: { source: 'pubmed-folder' } },
      `출처: PubMed 유사 논문(폴더 논문 ${found}편 기준) · 인용 수 Europe PMC${f.citations === false ? ' (인용 수를 불러오지 못했습니다)' : ''}`)];
    if (!found) parts.push(emptyState('이 폴더의 논문을 PubMed에서 찾지 못했습니다.', '논문을 하나씩 열어 관련 논문 탭에서 제목을 고쳐 찾으면 다음부터 함께 쓸 수 있습니다.'));
    else if (!f.items.length) parts.push(emptyState('관련 논문이 없습니다.'));
    else parts.push(el('ol', { class: 'pf-related__list' }, sortItems(f.items, this.sort).map((p) => this.itemView(p, f.items))));
    this.body.replaceChildren(...parts);
  }

  matchedCard(r) {
    const fix = el('button', { type: 'button', class: 'pf-link-btn', dataset: { action: 'rematch' }, onclick: () => this.renderNotFound(this.paperTitle(), { wrongMatch: true }) },
      '다른 논문으로 다시 찾기');
    const p = r.paper;
    if (!p?.title) {
      const href = r.pmid ? primaryUrl({ pmid: r.pmid }) : r.s2PaperId ? `https://www.semanticscholar.org/paper/${encodeURIComponent(r.s2PaperId)}` : null;
      return el('div', { class: 'pf-related__match' },
        el('span', { class: 'pf-muted pf-small' }, '기준 논문: '),
        href ? externalLink(href, r.pmid ? 'PubMed에서 보기' : 'Semantic Scholar에서 보기') : null, ' ', fix);
    }
    const label = r.source === 'pubmed' || (r.pmid && r.fallback === 'no-neighbors') ? '기준 논문 (PubMed)' : '기준 논문 (Semantic Scholar 매칭)';
    const facts = [p.journal || p.venue, p.year, p.citationCount != null ? `인용 ${p.citationCount}회` : ''].filter(Boolean).join(' · ');
    return el('div', { class: 'pf-related__match' },
      el('div', { class: 'pf-muted pf-small' }, label),
      el('div', { class: 'pf-related__match-title' }, externalLink(primaryUrl(p), p.title)),
      el('div', { class: 'pf-muted pf-small' }, facts ? `${facts} · ` : '', fix));
  }

  itemView(p, owner) {
    const absBox = el('div', { class: 'pf-related__absbox', hidden: true });
    const ko = el('div', { class: 'pf-related__ko pf-md', hidden: true });
    const translateBtn = el('button', { type: 'button', class: 'pf-link-btn', dataset: { action: 'translate' }, hidden: true, onclick: (e) => this.translate(p, ko, e.currentTarget) }, '초록 번역');
    const actions = el('div', { class: 'pf-related__actions' });
    if (p.abstract || p.hasAbstract !== false) {
      const absBtn = el('button', { type: 'button', class: 'pf-link-btn', dataset: { action: 'abstract' }, onclick: (e) => this.toggleAbstract(p, owner, absBox, e.currentTarget, translateBtn) }, '초록 보기');
      actions.append(absBtn, translateBtn);
    }
    const bits = [p.journal || p.venue, p.year].filter(Boolean).map(String);
    if (p.citationCount != null) bits.push(el('span', { class: 'pf-related__cites' }, `인용 ${p.citationCount}회`));
    if (this.view === 'folder' && p.folderHits > 1) bits.push(`폴더 논문 ${p.folderHits}편과 관련`);
    const metaLine = el('div', { class: 'pf-related__meta' }, bits.flatMap((b, i) => (i ? [' · ', b] : [b])));
    return el('li', { class: 'pf-related__item', dataset: { pmid: p.pmid || '', doi: p.doi || '' } },
      el('div', { class: 'pf-related__title' }, externalLink(primaryUrl(p), p.title || '(제목 없음)')),
      p.authors?.length ? el('div', { class: 'pf-related__meta pf-related__authors' }, formatAuthors(p.authors)) : null,
      metaLine,
      linkBadges(p),
      actions.childNodes.length ? actions : null, absBox, ko);
  }

  /** 초록 보기: fetched lazily (Europe PMC, else PubMed EFetch) and cached in ai.related. */
  async toggleAbstract(p, owner, box, btn, translateBtn) {
    if (box.dataset.loaded) {
      box.hidden = !box.hidden;
      btn.textContent = box.hidden ? '초록 보기' : '초록 접기';
      return;
    }
    btn.disabled = true;
    box.hidden = false;
    box.replaceChildren(el('div', { class: 'pf-loading' }, spinner(14), el('span', {}, '초록을 불러오는 중…')));
    try {
      const text = p.abstract || await fetchAbstract(p, { signal: anySignal(this.signal, this.ctx.signal) });
      if (!p.abstract && text) {
        p.abstract = text;
        if (owner.includes(p)) this.#saveSoon();
      }
      box.replaceChildren(...(text ? abstractNodes(text) : [el('p', { class: 'pf-muted pf-small' }, '초록이 없습니다.')]));
      box.dataset.loaded = '1';
      btn.textContent = '초록 접기';
      translateBtn.hidden = !text;
    } catch (err) {
      if (isAbortError(err)) return;
      box.replaceChildren(el('p', { class: 'pf-error' }, errorMessage(err, '초록을 불러오지 못했습니다.')));
      btn.textContent = '초록 다시 불러오기';
    } finally {
      btn.disabled = false;
    }
  }

  #saveSoon() {
    clearTimeout(this.#saveTimer);
    this.#savePending = true;
    this.#saveTimer = setTimeout(() => this.#saveNow(), 400);
  }

  #saveNow() {
    clearTimeout(this.#saveTimer);
    if (!this.#savePending || !this.related) return;
    this.#savePending = false;
    void this.#persist();
  }

  /** Save ai.related; a failed save (storage full, offline sync) never replaces results already on screen. */
  async #persist() {
    try {
      await this.ctx.saveAi({ related: this.related });
    } catch (err) {
      console.warn('[features] related save failed', err);
    }
  }

  /** First click translates; afterwards the button just shows/hides the translation. */
  async translate(p, target, btn) {
    if (btn.dataset.done) {
      target.hidden = !target.hidden;
      btn.textContent = target.hidden ? '번역 보기' : '번역 숨기기';
      return;
    }
    if (!this.ctx.settings.isAiReady()) { notifyAiNotReady(); return; }
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

  /** No (or a wrong) match: let the user type the title, DOI or PMID. */
  renderNotFound(title, { wrongMatch = false } = {}) {
    this.view = 'paper';
    this.meta.textContent = '';
    this.refreshBtn.disabled = !this.related?.items;
    const input = el('input', { class: 'pf-input', type: 'search', 'aria-label': '논문 제목, DOI 또는 PMID', placeholder: '논문 제목, DOI 또는 PMID' });
    input.value = title || '';
    const go = () => { const q = input.value.trim(); if (q) this.fetch({ query: q }); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) go(); });
    const folder = this.folderPapers().length >= 2;
    this.body.replaceChildren(el('div', { class: 'pf-empty pf-related__search' },
      el('p', { class: 'pf-empty__title' }, wrongMatch ? '찾을 논문의 제목·DOI·PMID를 입력하세요.' : 'PubMed에서 이 논문을 찾지 못했습니다.'),
      el('p', { class: 'pf-muted pf-small' }, '정확한 영문 제목이나 DOI·PMID를 넣으면 잘 찾습니다.'),
      el('div', { class: 'pf-row' }, input, button('다시 찾기', { kind: 'primary', onClick: go, attrs: { 'data-action': 'search' } })),
      wrongMatch && Array.isArray(this.related?.items) ? button('취소', { small: true, onClick: () => this.render() }) : null,
      !wrongMatch && folder ? el('p', { class: 'pf-small' }, button('이 폴더 기준 추천 보기', { small: true, onClick: () => this.setView('folder'), attrs: { 'data-action': 'folder' } })) : null));
    input.focus();
  }

  renderError(err, retry) {
    this.body.replaceChildren(el('div', { class: 'pf-error-box' },
      el('p', {}, errorMessage(err, '관련 논문을 불러오지 못했습니다.')),
      el('div', { class: 'pf-row' },
        button('다시 시도', { small: true, onClick: retry, attrs: { 'data-action': 'retry' } }),
        this.view === 'folder' ? button('이 논문 기준으로 보기', { small: true, onClick: () => this.setView('paper'), attrs: { 'data-action': 'paper-view' } }) : null)));
  }

  destroy() {
    this.#saveNow();
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
