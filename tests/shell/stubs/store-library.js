// Test stub for js/store/library.js — in-memory Library persisted to sessionStorage so reloads keep state.
// URL params: ?lib=empty (no seed) · ?sync=off|error|offline · ?reset=1 (drop saved state)
import { emit } from '/js/core/bus.js';
import { LIMITS } from '/js/core/config.js';
import { hash, uid } from '/js/core/util.js';
import { buildSyntheticDoc } from './pdf-extract.js';
import { koFor } from './ko.js';

const params = new URLSearchParams(location.search);
const MODE = params.get('lib') === 'empty' ? 'empty' : 'seed';
const KEY = `shell-stub-lib-${MODE}`;
if (params.get('reset') === '1') sessionStorage.removeItem(KEY);

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-18T09:00:00+09:00');

function seed() {
  if (MODE === 'empty') return { folders: [], papers: [], data: {} };
  const f = (id, name, parentId = null) => ({ id, name, parentId, createdAt: NOW - 30 * DAY, updatedAt: NOW - 30 * DAY });
  const folders = [
    f('f_delirium', '섬망 연구'),
    f('f_prevent', '예방 중재', 'f_delirium'),
    f('f_assess', '평가 도구', 'f_delirium'),
    f('f_vent', '기계환기·이탈'),
    f('f_stats', '통계 방법론'),
  ];
  const p = (id, title, authors, year, folderId, extra = {}) => ({
    id, title, authors, year, folderId, fileName: `${id}.pdf`, size: 1_200_000 + id.length * 97_000, pages: 12,
    starred: false, addedAt: NOW - 10 * DAY, updatedAt: NOW - 2 * DAY, lastOpenedAt: null, translatedCount: 0, sentenceCount: 0, ...extra,
  });
  const papers = [
    p('pap_bundle', 'Effects of a Nurse-Led Delirium Prevention Bundle in Intensive Care Units', 'Jane Doe, Min-ji Kim, Alex Smith', 2025, 'f_prevent',
      { addedAt: NOW - 1 * DAY, lastOpenedAt: NOW - 3_600_000, starred: true, translatedCount: 30, sentenceCount: 73, pages: 4 }),
    p('pap_camicu', 'Validity and Reliability of the CAM-ICU in Korean Intensive Care Units', 'S. Park, H. Lee', 2023, 'f_assess',
      { addedAt: NOW - 3 * DAY, translatedCount: 412, sentenceCount: 412, lastOpenedAt: NOW - 2 * DAY }),
    p('pap_sat', 'Paired Spontaneous Awakening and Breathing Trials: A Pragmatic Multicenter Study', 'R. Johnson, M. Chen, et al.', 2024, 'f_vent',
      { addedAt: NOW - 5 * DAY, translatedCount: 120, sentenceCount: 388 }),
    p('pap_kappa', 'A Coefficient of Agreement for Nominal Scales', 'J. Cohen', 1960, 'f_stats', { addedAt: NOW - 8 * DAY, pages: 10 }),
    p('pap_mobil', 'Early Mobilization of Mechanically Ventilated Patients: A Systematic Review', 'L. Garcia, P. Novak', 2022, null,
      { addedAt: NOW - 12 * DAY, starred: true, translatedCount: 5, sentenceCount: 260 }),
    p('pap_sleep', 'Sleep Promotion Bundles in Critical Care: Implementation Outcomes', 'K. Tanaka', 2021, 'f_prevent', { addedAt: NOW - 20 * DAY }),
  ];
  // Cached translation for the first ~30 translatable sentences of the synthetic doc.
  const doc = buildSyntheticDoc();
  const items = {};
  let n = 0;
  for (const s of doc.sentences) {
    if (!['body', 'heading', 'caption'].includes(s.kind)) continue;
    if (n++ >= 30) break;
    items[s.sid] = { h: hash(s.text), t: koFor(s, n), m: 'mock' };
  }
  const data = {
    'pap_bundle/translation': { version: 1, targetLang: 'ko', segVersion: 1, updatedAt: NOW, items },
  };
  return { folders, papers, data };
}

function load() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (saved?.folders) return saved;
  } catch { /* ignore */ }
  return seed();
}

class StubSync extends EventTarget {
  constructor(lib) {
    super();
    this.lib = lib;
    const mode = params.get('sync');
    this._status = {
      state: mode === 'off' ? 'disabled' : mode === 'error' ? 'error' : mode === 'offline' ? 'offline' : 'idle',
      message: mode === 'error' ? 'GitHub 토큰이 만료되었습니다. 설정에서 새 토큰을 입력하세요.' : '',
      pending: mode === 'offline' ? 3 : 0,
      lastSyncAt: mode === 'off' ? null : NOW - 120_000,
    };
  }
  get status() { return { ...this._status }; }
  _set(patch) {
    Object.assign(this._status, patch);
    emit(this, 'status', this.status);
    emit(this.lib, 'syncstatus', this.status);
  }
  async start() {}
  stop() {}
  async syncNow() {
    if (this._status.state === 'disabled') return;
    this._set({ state: 'syncing' });
    await new Promise((r) => setTimeout(r, 700));
    this._set({ state: 'idle', pending: 0, lastSyncAt: Date.now(), message: '' });
  }
}

export class Library extends EventTarget {
  static async open({ settings } = {}) {
    const lib = new Library();
    lib.settings = settings;
    window.__stubLibrary = lib;
    return lib;
  }

  constructor() {
    super();
    this.state = load();
    this.log = [];
    this._sync = new StubSync(this);
  }

  _save(reason) {
    try { sessionStorage.setItem(KEY, JSON.stringify(this.state)); } catch { /* ignore */ }
    emit(this, 'change', { reason });
  }

  get folders() { return this.state.folders.filter((f) => !f.deleted); }
  get papers() { return this.state.papers.filter((p) => !p.deleted).sort((a, b) => b.addedAt - a.addedAt); }
  getPaper(id) { return this.papers.find((p) => p.id === id) || null; }
  getFolder(id) { return this.folders.find((f) => f.id === id) || null; }

  createFolder(name, parentId = null) {
    const folder = { id: uid('f'), name, parentId, createdAt: Date.now(), updatedAt: Date.now() };
    this.state.folders.push(folder);
    this.log.push(['createFolder', name, parentId]);
    this._save('folder');
    return folder;
  }
  renameFolder(id, name) { this._patchFolder(id, { name }); this.log.push(['renameFolder', id, name]); }
  moveFolder(id, parentId) { this._patchFolder(id, { parentId }); this.log.push(['moveFolder', id, parentId]); }
  deleteFolder(id) {
    const folder = this.getFolder(id);
    if (!folder) return;
    for (const f of this.folders) if (f.parentId === id) f.parentId = folder.parentId;
    for (const p of this.papers) if (p.folderId === id) p.folderId = folder.parentId;
    folder.deleted = true;
    folder.updatedAt = Date.now();
    this.log.push(['deleteFolder', id]);
    this._save('folder');
  }
  _patchFolder(id, patch) {
    const f = this.getFolder(id);
    if (!f) throw new Error('폴더를 찾을 수 없습니다.');
    Object.assign(f, patch, { updatedAt: Date.now() });
    this._save('folder');
  }

  async addPaper(bytes, { fileName, folderId = null, meta = {} } = {}) {
    if (bytes.byteLength > LIMITS.maxPdfBytes) throw new Error('파일이 너무 큽니다.');
    if (/fail/i.test(fileName)) throw new Error('저장 공간이 부족합니다. (테스트용 실패)');
    const paper = {
      id: uid('p'), title: meta.title || fileName, authors: meta.authors || '', year: meta.year ?? null, fileName,
      size: bytes.byteLength, pages: meta.pages || 0, folderId, starred: false, addedAt: Date.now(), updatedAt: Date.now(),
      lastOpenedAt: null, translatedCount: 0, sentenceCount: 0,
    };
    this.state.papers.push(paper);
    this.log.push(['addPaper', fileName, folderId, meta.title]);
    this._save('paper');
    return paper;
  }
  updatePaper(id, patch) {
    const p = this.state.papers.find((x) => x.id === id && !x.deleted);
    if (!p) throw new Error('논문을 찾을 수 없습니다.');
    Object.assign(p, patch, { updatedAt: Date.now() });
    this.log.push(['updatePaper', id, Object.keys(patch).join(',')]);
    this._save('paper');
  }
  movePaper(id, folderId) { this.updatePaper(id, { folderId }); this.log.push(['movePaper', id, folderId]); }
  deletePaper(id) { this.updatePaper(id, { deleted: true }); this.log.push(['deletePaper', id]); }

  async getPdf(id) {
    if (!this.getPaper(id)) throw new Error('논문을 찾을 수 없습니다.');
    // ?fixture=<name>: serve a local fixture PDF (intercepted by the Playwright test; never stored in the repo).
    const fixture = params.get('fixture');
    if (fixture) return new Uint8Array(await (await fetch(`/__fixture__/${encodeURIComponent(fixture)}.pdf`)).arrayBuffer());
    await new Promise((r) => setTimeout(r, 50));
    return new TextEncoder().encode(id === 'pap_kappa' ? '%PDF-1.4 SCANNED' : '%PDF-1.4 stub');
  }
  async getPaperData(id, kind) {
    const v = this.state.data[`${id}/${kind}`];
    return v ? structuredClone(v) : null;
  }
  async savePaperData(id, kind, obj) {
    obj.updatedAt = Date.now();
    this.state.data[`${id}/${kind}`] = structuredClone(obj);
    this.log.push(['savePaperData', id, kind]);
    this._save('data');
  }

  get sync() { return this._sync; }
  async reconfigureSync() {
    this.log.push(['reconfigureSync']);
    const ready = this.settings?.isSyncReady?.();
    this._sync._set(ready ? { state: 'idle', lastSyncAt: Date.now() } : { state: 'disabled', lastSyncAt: null });
  }
}
