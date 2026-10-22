// Browser side of tests/library-select/run.mjs: the real library view on the real store, two libraries
// (내 서재 with 60 papers and nested folders; a 공용 서재 that keeps deleted papers in its 휴지통), each on an in-memory
// sync engine that records every write — so a batch (one library.json write = one sync commit) can be counted.
// Nothing leaves the page: no GitHub, no relay, no AI.
import { Library } from '/js/store/library.js';
import { mountLibraryView } from '/js/ui/library-view.js';
import { closeAllLayers } from '/js/ui/components.js';
import { memoryDb } from '/tests/store/memory-db.mjs';

const params = new URLSearchParams(location.search);
const ONE = params.get('libs') === 'one';
const EXTRA_FOLDERS = Math.max(0, Math.min(200, Number(params.get('folders')) || 0));
const NOW = Date.parse('2026-10-21T09:00:00+09:00');
const HOUR = 3_600_000;
const run = Math.random().toString(36).slice(2, 8);

/** In-memory stand-in for js/store/sync.js SyncEngine: files in a Map, every write recorded. */
class FakeSync extends EventTarget {
  constructor(name) {
    super();
    this.name = name;
    this.files = new Map();
    this.writes = [];
    this._status = { state: 'idle', pending: 0, lastSyncAt: NOW, message: '' };
  }
  get status() { return { ...this._status }; }
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  async start() {}
  stop() {}
  async reconfigure() {}
  async flush() {}
  async targetChange() { return null; }
  async syncNow() {
    this._status = { ...this._status, state: 'syncing' };
    this._emit('status', this.status);
    await new Promise((r) => setTimeout(r, 50));
    this._status = { ...this._status, state: 'idle', pending: 0, lastSyncAt: Date.now() };
    this._emit('status', this.status);
  }
  async readFile(path) {
    const v = this.files.get(path);
    return v === undefined ? null : structuredClone(v);
  }
  async writeFile(path, data) {
    this.writes.push({ path, at: Date.now() });
    this.files.set(path, structuredClone(data));
    return data;
  }
  async exists(path) { return this.files.has(path); }
  async listPaths(prefix = '') { return [...this.files.keys()].filter((k) => k.startsWith(prefix)); }
  async deleteFile(path) { this.files.delete(path); this.writes.push({ path, at: Date.now(), deleted: true }); }
  async blobSha() { return null; }
  /** library.json writes so far (each one is at most one commit). */
  libraryWrites() { return this.writes.filter((w) => w.path === 'library.json' && !w.deleted).length; }
}

async function sha256(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

function pdfBytes(tag) {
  return new TextEncoder().encode(`%PDF-1.4\n% library-select test file ${tag}\n${'x'.repeat(64)}\n%%EOF\n`);
}

const TITLES = [
  'G09_McGrath2020_ICS_NTSP_TrachCareGuidance',
  'E41_KimEunji2021_SNU_석사_EICU_VAP',
  'Delirium Prevention Bundles in Intensive Care Units: A Systematic Review',
  'Validity of the CAM-ICU in Korean Intensive Care Units',
  'Paired Spontaneous Awakening and Breathing Trials',
  'A Coefficient of Agreement for Nominal Scales',
  'Early Mobilization of Mechanically Ventilated Patients',
  'Sleep Promotion in Critical Care: Implementation Outcomes',
  '중환자실 간호사의 섬망 사정 수행도와 관련 요인',
  'Unplanned Extubation in Adult ICUs: Incidence and Risk Factors',
  'Central Line-Associated Bloodstream Infection Bundle Compliance',
  'Pressure Injury Prevention with Prophylactic Dressings',
];

function seedMine() {
  const f = (id, name, parentId = null) => ({ id, name, parentId, createdAt: NOW - 90 * 24 * HOUR, updatedAt: NOW - 90 * 24 * HOUR });
  const folders = [
    f('f_icu', '중환자 간호'),
    f('f_delir', '섬망', 'f_icu'),
    f('f_assess', '평가 도구', 'f_delir'),
    f('f_vent', '기계환기', 'f_icu'),
    f('f_stats', '통계'),
    f('f_misc', '기타'),
  ];
  for (let i = 1; i <= EXTRA_FOLDERS; i++) folders.push(f(`f_x${i}`, `자료 ${String(i).padStart(2, '0')}`));
  const papers = [];
  for (let i = 1; i <= 60; i++) {
    const n = String(i).padStart(2, '0');
    const base = TITLES[(i - 1) % TITLES.length];
    const title = i <= TITLES.length ? base : `${base} (${n})`;
    let folderId = null;
    if (i > 40 && i <= 45) folderId = 'f_delir';
    else if (i > 45 && i <= 50) folderId = 'f_vent';
    else if (i > 50 && i <= 55) folderId = 'f_stats';
    else if (i > 55) folderId = 'f_assess';
    papers.push({
      id: `p_${n}`, title, authors: i % 3 ? 'J. Doe, M. Kim' : '김간호, 이간호', year: 2000 + (i % 25), fileName: `p_${n}.pdf`,
      folderId, pages: 8 + (i % 7), starred: false, addedAt: NOW - i * HOUR, updatedAt: NOW - i * HOUR, lastOpenedAt: null,
      translatedCount: 0, sentenceCount: 0,
    });
  }
  return { folders, papers };
}

function seedTeam() {
  const f = (id, name, parentId = null) => ({ id, name, parentId, createdAt: NOW - 30 * 24 * HOUR, updatedAt: NOW - 30 * 24 * HOUR });
  const folders = [f('t_common', '공동 자료'), f('t_sub', '프로토콜', 't_common')];
  const papers = [
    // the same PDF as 내 서재 p_03 (copying p_03 must reuse it, not upload a second one)
    { id: 't_p03', title: 'Delirium Prevention Bundles (team copy)', fileName: 'p_03.pdf', folderId: 't_common', pdfOf: 'p_03' },
    { id: 't_a', title: 'Team Paper A: Ventilator Weaning Protocol', fileName: 't_a.pdf', folderId: null },
    { id: 't_b', title: 'Team Paper B: Oral Care and VAP', fileName: 't_b.pdf', folderId: 't_sub' },
    { id: 't_c', title: 'Team Paper C: Restraint Minimisation', fileName: 't_c.pdf', folderId: null },
  ].map((p, i) => ({
    authors: 'Team', year: 2024, pages: 6, starred: false, addedAt: NOW - (i + 1) * HOUR, updatedAt: NOW - (i + 1) * HOUR,
    addedBy: '박진수', translatedCount: 0, sentenceCount: 0, ...p,
  }));
  return { folders, papers };
}

async function fill(sync, { folders, papers }) {
  for (const p of papers) {
    const bytes = pdfBytes(p.pdfOf || p.id);
    p.size = bytes.byteLength;
    p.sha256 = await sha256(bytes);
    delete p.pdfOf;
    sync.files.set(`papers/${p.id}/paper.pdf`, bytes);
  }
  sync.files.set('library.json', { version: 1, updatedAt: NOW, folders, papers });
}

const syncs = { mine: new FakeSync('mine'), team: new FakeSync('team') };
await fill(syncs.mine, seedMine());
await fill(syncs.team, seedTeam());
const mine = await Library.open({ id: 'mine', sync: syncs.mine, db: memoryDb(`lsel-mine-${run}`) });
const team = ONE ? null : await Library.open({
  id: 'shared:team', label: '전체 공용 서재', shared: true, retainPdfOnDelete: true, personName: '김동료',
  sync: syncs.team, db: memoryDb(`lsel-team-${run}`),
});

/** deps.shared as js/app.js SharedLibraries offers it: one team library, ready. */
class FakeShared extends EventTarget {
  enabled = true;
  state = 'ready';
  personName = '김동료';
  libraries = [{ id: 'team', kind: 'team', name: '전체 공용 서재', library: team, status: 'ready', error: '' }];
  isInvitee() { return false; }
  homeHash() { return null; }
  retry() {}
}

const deps = {
  library: mine,
  shared: team ? new FakeShared() : null,
  relay: null,
  // Upload: a PDF "opens" with 3 pages and no metadata (the file name becomes the title).
  loadPdf: async () => ({ numPages: 3, destroy: async () => {} }),
  quickMeta: async () => ({ title: '', authors: '', year: null, pages: 3 }),
};

function parse(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  if (parts[0] === 's' && parts[1]) {
    if (parts[2] === 'paper') return { name: 'paper', lib: parts[1], id: parts[3] };
    if (parts[2] === 'trash' || parts[2] === 'activity') return { name: 'library', lib: parts[1], page: parts[2] };
    return { name: 'library', lib: parts[1] };
  }
  if (parts[0] === 'paper') return { name: 'paper', id: parts[1] };
  if (parts[0] === 'trash') return { name: 'library', page: 'trash' };
  return { name: 'library' };
}

const container = document.getElementById('view');
const opened = [];
let view = null;
const navigate = (hash, { replace = false } = {}) => {
  if (replace) { history.replaceState(null, '', hash); route(); } else if (location.hash === hash) route(); else location.hash = hash;
};
function route() {
  const r = parse(location.hash);
  closeAllLayers();
  if (r.name === 'paper') {
    opened.push(location.hash);
    view?.destroy();
    view = null;
    const back = document.createElement('a');
    back.href = '#/';
    back.className = 'harness-reader';
    back.textContent = `(reader) ${r.id}`;
    container.replaceChildren(back);
    return;
  }
  if (view) view.update(r);
  else view = mountLibraryView(container, { deps, navigate, route: r });
}
window.addEventListener('hashchange', route);
route();

window.__lsel = {
  mine, team, syncs, opened,
  /** Live state for assertions. */
  state(which = 'mine') {
    const lib = which === 'team' ? team : mine;
    return { folders: lib.folders.map((f) => ({ ...f })), papers: lib.papers.map((p) => ({ ...p })) };
  },
  trash(which = 'team') { return (which === 'team' ? team : mine).trash().map((x) => ({ id: x.id, kind: x.kind, deletedBy: x.deletedBy })); },
  writes(which = 'mine') { return syncs[which].libraryWrites(); },
  ready: true,
};
