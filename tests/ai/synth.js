// Synthetic PaperDoc for translator/task tests: 12 pages, ~360 sentences, all sentence kinds.
// Pages 1–6 use short sentences (the 40-sentence batch limit binds), pages 7–10 long ones (the char limit binds),
// pages 11–12 hold the reference list. Every page has a running head + page number (furniture).

const WORDS = ('patients nurses delirium sedation ventilation intensive care unit outcomes intervention protocol '
  + 'assessment staff training safety catheter infection mobility pressure injury restraint family caregivers '
  + 'education workload shift monitoring scale scores analysis regression cohort hospital adult critical illness '
  + 'quality improvement adherence compliance incidence prevalence risk factors length stay mortality survey').split(' ');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sentence(rand, minWords, maxWords, i) {
  const n = minWords + Math.floor(rand() * (maxWords - minWords + 1));
  const words = Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]);
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  const extras = ['', ' (p < .05)', ' [12]', ' (Smith et al., 2020)', ' (95% CI 1.2-3.4)'];
  return `${words.join(' ')}${extras[i % extras.length]}.`;
}

/**
 * @param {{ pages?: number, seed?: number }} [opts]
 * @returns {object} PaperDoc (SPEC 2.1 shape; `_map`/`_itemToDoc` omitted — viewer-only)
 */
export function buildSyntheticDoc({ pages = 12, seed = 7 } = {}) {
  const rand = rng(seed);
  const sentences = [];
  const paragraphs = [];
  const pageInfos = [];
  const references = [];
  let text = '';

  const add = (page, kind, str, perPage, pid) => {
    if (text) text += kind === 'heading' || kind === 'furniture' ? '\n\n' : ' ';
    const start = text.length;
    text += str;
    const sid = `p${page}-${perPage.n++}`;
    const s = { sid, start, end: text.length, text: str, page, pages: [page], pid, kind };
    sentences.push(s);
    return s;
  };

  for (let p = 1; p <= pages; p++) {
    const perPage = { n: 0 };
    let g = 0;
    const textStart = text.length;
    const para = (kind) => {
      const pg = { pid: `p${p}-g${g++}`, page: p, sids: [], kind };
      paragraphs.push(pg);
      return pg;
    };
    const head = para('furniture');
    head.sids.push(add(p, 'furniture', 'Journal of Synthetic Nursing Research 2026', perPage, head.pid).sid);

    if (p >= pages - 1) {
      const h = para('heading');
      if (p === pages - 1) h.sids.push(add(p, 'heading', 'References', perPage, h.pid).sid);
      for (let r = 0; r < 15; r++) {
        const n = references.length + 1;
        const refText = `${n}. Author${n} A, Writer B. ${sentence(rand, 6, 12, r).replace(/\.$/, '')}. J Nurs Stud. 20${10 + (n % 15)};${n}:${n * 3}-${n * 3 + 9}.`;
        const s = add(p, 'reference', refText, perPage, h.pid);
        h.sids.push(s.sid);
        references.push({ index: n - 1, n, text: refText, start: s.start, end: s.end, page: p, bbox: { x: 50, y: 100 + r * 40, w: 500, h: 30 } });
      }
    } else {
      const h = para('heading');
      h.sids.push(add(p, 'heading', `${p}. Section ${p} heading on care outcomes`, perPage, h.pid).sid);
      const long = p >= 7;
      const body = para('body');
      for (let i = 0; i < 24; i++) {
        const str = long ? sentence(rand, 26, 34, i) : sentence(rand, 6, 12, i);
        body.sids.push(add(p, 'body', str, perPage, body.pid).sid);
      }
      if (p % 2 === 0) {
        const cap = para('caption');
        cap.sids.push(add(p, 'caption', `Figure ${p / 2}. Distribution of ${WORDS[p]} scores by group.`, perPage, cap.pid).sid);
      }
      if (p % 3 === 0) {
        const w = para('body');
        w.sids.push(add(p, 'body', `${p}.5 ± ${p}.1`, perPage, w.pid).sid); // no words → copied, no API call
      }
    }
    const foot = para('furniture');
    foot.sids.push(add(p, 'furniture', String(p), perPage, foot.pid).sid);
    pageInfos.push({ pageNumber: p, width: 612, height: 792, textStart, textEnd: text.length });
  }

  return {
    segVersion: 1,
    numPages: pages,
    text,
    pages: pageInfos,
    sentences,
    sentenceById: new Map(sentences.map((s) => [s.sid, s])),
    paragraphs,
    references,
    meta: {
      title: 'Effects of a Synthetic Nurse-Led Delirium Prevention Protocol in Adult Intensive Care Units',
      authors: 'Kim A, Lee B',
      year: 2026,
      abstract: 'Background: Delirium is common in critically ill adults. Objective: To evaluate a nurse-led protocol. '
        + 'Methods: A cohort of 240 patients was analysed with regression. Results: Incidence decreased (p < .05). '
        + 'Conclusion: The protocol was associated with lower delirium incidence.',
    },
    hasTextLayer: true,
  };
}
