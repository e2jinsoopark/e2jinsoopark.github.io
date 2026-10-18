// Stub TranslationPane (SPEC 3.5): Korean sentence list with whole-sentence marks; records calls.

const KO = {
  'p1-0': '인공호흡기 적용 성인의 조기 운동과 섬망: 간호사 주도 프로토콜',
  'p1-1': '초록',
  'p1-2': '섬망은 인공호흡기를 적용받는 중증 성인 환자에게 흔하고 비용이 큰 합병증이다 [1].',
  'p1-3': '우리는 간호사 주도 조기 운동 프로토콜이 일반 치료에 비해 섬망 발생을 줄이는지 평가했다.',
  'p1-4': '6개 중환자실에서 시행한 군집 시험에 412명의 환자가 등록되었다.',
  'p1-5': '섬망은 프로토콜군의 28%, 일반 치료군의 41%에서 발생했다(위험비 0.68).',
  'p1-6': '프로토콜 준수율은 병상 간호사가 매일 운동 허들을 열 때 가장 높았다.',
};

const FILL = { yellow: 'rgba(255, 212, 59, .45)', green: 'rgba(105, 219, 124, .40)', blue: 'rgba(116, 192, 252, .40)', pink: 'rgba(250, 162, 193, .50)' };

export class StubPane extends EventTarget {
  constructor(container, { doc }) {
    super();
    this.container = container;
    this.doc = doc;
    this.calls = [];
    this.marks = {};
    const list = document.createElement('div');
    list.className = 'sp-list';
    for (const s of doc.sentences) {
      const span = document.createElement('p');
      span.className = 'sp-s';
      span.dataset.sid = s.sid;
      span.textContent = KO[s.sid] ?? `〔번역〕 ${s.text.slice(0, 60)}`;
      span.addEventListener('pointerenter', () => this.dispatchEvent(new CustomEvent('sentencehover', { detail: { sid: s.sid } })));
      span.addEventListener('pointerleave', () => this.dispatchEvent(new CustomEvent('sentencehover', { detail: { sid: null } })));
      list.append(span);
    }
    container.append(list);
  }

  record(fn, ...args) { this.calls.push({ fn, args: JSON.parse(JSON.stringify(args ?? null)) }); }

  setTranslations(map) { this.record('setTranslations', map?.size ?? 0); }
  update(sids) { this.record('update', sids); }
  setStatus(sid, status) { this.record('setStatus', sid, status); }
  setHoverSentence(sid) {
    this.record('setHoverSentence', sid);
    this.container.querySelectorAll('.sp-s.is-hover').forEach((e) => e.classList.remove('is-hover'));
    if (sid) this.container.querySelector(`.sp-s[data-sid="${sid}"]`)?.classList.add('is-hover');
  }
  setActiveSentence(sid) { this.record('setActiveSentence', sid); }
  scrollToSentence(sid, opts) { this.record('scrollToSentence', sid, opts); }

  setMarks(layer, marks) {
    this.record('setMarks', layer, marks);
    this.marks[layer] = marks;
    for (const el of this.container.querySelectorAll('.sp-s')) {
      el.style.background = '';
      el.style.textDecoration = '';
    }
    for (const [, list] of Object.entries(this.marks)) {
      for (const m of list) {
        for (const s of this.doc.sentences) {
          if (s.end <= m.start || s.start >= m.end) continue;
          const el = this.container.querySelector(`.sp-s[data-sid="${s.sid}"]`);
          if (!el) continue;
          if (m.style === 'underline') el.style.textDecoration = `underline 2px ${m.color}`;
          else el.style.background = FILL[m.color] ?? m.color;
        }
      }
    }
  }
}
