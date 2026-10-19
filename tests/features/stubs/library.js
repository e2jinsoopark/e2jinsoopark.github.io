// Stub Library (SPEC 3.3 subset used by features). Data persists in sessionStorage so a page
// reload in the harness behaves like reopening the paper. `others` / `folders` let a test put the
// open paper in a folder with other papers (관련 논문 "이 폴더 기준 추천").

const KEY = 'pf-test-library';

export class StubLibrary extends EventTarget {
  constructor({ paper, others = [], folders = [] }) {
    super();
    const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    this.paper = saved?.paper ?? paper;
    this.others = saved?.others ?? others;
    this.folderList = saved?.folders ?? folders;
    this.data = saved?.data ?? {};
    this.saves = [];          // every savePaperData call: { kind, obj }
    this.updates = [];        // every updatePaper call
    this.failGets = 0;        // test hook: make the next N getPaperData calls throw
    this.sync = new EventTarget();
  }

  persist() {
    sessionStorage.setItem(KEY, JSON.stringify({ paper: this.paper, others: this.others, folders: this.folderList, data: this.data }));
  }

  static reset() { sessionStorage.removeItem(KEY); }

  get papers() { return [this.paper, ...this.others]; }

  get folders() { return this.folderList; }

  getFolder(id) { return this.folderList.find((f) => f.id === id) ?? null; }

  getPaper(id) { return this.papers.find((p) => p.id === id) ?? null; }

  updatePaper(id, patch) {
    this.updates.push({ id, patch });
    if (id === this.paper.id) this.paper = { ...this.paper, ...patch, updatedAt: Date.now() };
    else this.others = this.others.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p));
    this.persist();
    this.dispatchEvent(new CustomEvent('change', { detail: { reason: 'paper' } }));
    return this.getPaper(id);
  }

  async getPaperData(id, kind) {
    await new Promise((r) => setTimeout(r, 15));
    if (this.failGets > 0) { this.failGets -= 1; throw new Error('읽기 실패 (테스트)'); }
    const v = this.data[`${id}/${kind}`];
    return v ? structuredClone(v) : null;
  }

  async savePaperData(id, kind, obj) {
    await new Promise((r) => setTimeout(r, 5));
    obj.updatedAt = Date.now();
    const copy = structuredClone(obj);
    this.data[`${id}/${kind}`] = copy;
    this.saves.push({ kind, obj: copy });
    this.persist();
  }
}
