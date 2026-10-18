// Test stub for js/pdf/extract.js — builds a synthetic PaperDoc (no PDF parsing).
// The text below is invented for testing; it is not taken from any real paper.

export const SEG_VERSION = 1;

const PAGES = [
  [
    { kind: 'heading', s: ['Effects of a Nurse-Led Delirium Prevention Bundle in Intensive Care Units'] },
    { kind: 'body', s: ['Jane Doe, Min-ji Kim, and Alex Smith'] },
    { kind: 'heading', s: ['Abstract'] },
    { kind: 'body', s: [
      'Delirium is a common and serious complication among critically ill adults.',
      'We evaluated whether a nurse-led prevention bundle reduces the incidence of delirium in intensive care units.',
      'In this cluster randomized trial, 412 patients from eight units were assigned to the bundle or usual care.',
      'The bundle combined early mobilization, sleep hygiene, family engagement, and structured reorientation.',
      'Delirium incidence was lower in the bundle group than in the usual-care group (18.4% vs. 29.7%).',
      'Nurse-led bundles are a feasible strategy for preventing delirium in critical care.',
    ] },
    { kind: 'heading', s: ['1. Introduction'] },
    { kind: 'body', s: [
      'Delirium affects up to 80% of mechanically ventilated patients.',
      'It is associated with longer stays, higher costs, and long-term cognitive impairment.',
      'Pharmacological prevention has shown limited and inconsistent benefit.',
      'Non-pharmacological interventions delivered by nurses may therefore be especially valuable.',
    ] },
    { kind: 'body', s: [
      'However, previous studies were small and often lacked a control group.',
      'Few trials have examined bundles that nurses can deliver within routine workflows.',
      'The aim of this study was to test the effectiveness of a nurse-led bundle in a multicenter setting.',
    ] },
    { kind: 'furniture', s: ['1'] },
  ],
  [
    { kind: 'heading', s: ['2. Methods'] },
    { kind: 'heading', s: ['2.1 Design and setting'] },
    { kind: 'body', s: [
      'We conducted a cluster randomized controlled trial in eight adult intensive care units.',
      'Units were randomized in a 1:1 ratio using a computer-generated sequence.',
      'The study was approved by the institutional review board of each site.',
    ] },
    { kind: 'heading', s: ['2.2 Participants'] },
    { kind: 'body', s: [
      'Adults aged 18 years or older with an expected stay of at least 48 hours were eligible.',
      'Patients with pre-existing dementia, severe hearing loss, or a Richmond Agitation-Sedation Scale score of −4 or lower were excluded.',
      'Written informed consent was obtained from patients or their legal representatives.',
    ] },
    { kind: 'heading', s: ['2.3 Intervention'] },
    { kind: 'body', s: [
      'Nurses in the intervention units received four hours of training before the study began.',
      'The bundle was delivered every shift and documented on a standardized checklist.',
      'Adherence was monitored weekly by a research nurse at each site.',
      'Usual care followed each unit’s existing delirium management practices.',
    ] },
    { kind: 'caption', s: ['Table 1. Baseline characteristics of the participants by group.'] },
    { kind: 'heading', s: ['2.4 Outcomes'] },
    { kind: 'body', s: [
      'The primary outcome was the incidence of delirium assessed twice daily with the CAM-ICU.',
      'Secondary outcomes included delirium duration, length of stay, and ventilator-free days.',
    ] },
    { kind: 'heading', s: ['2.5 Statistical analysis'] },
    { kind: 'body', s: [
      'We estimated that 400 patients would provide 80% power to detect a 10-percentage-point reduction.',
      'Analyses followed the intention-to-treat principle.',
      'Mixed-effects logistic regression accounted for clustering within units.',
      'A two-sided P value of less than 0.05 was considered statistically significant.',
    ] },
    { kind: 'furniture', s: ['2'] },
  ],
  [
    { kind: 'heading', s: ['3. Results'] },
    { kind: 'body', s: [
      'A total of 412 patients were enrolled, with 206 in each group.',
      'Baseline characteristics were similar between the groups.',
      'Delirium occurred in 38 patients (18.4%) in the bundle group and 61 patients (29.7%) in the usual-care group.',
      'The adjusted odds ratio for delirium was 0.53 (95% CI, 0.33 to 0.85).',
      'The median duration of delirium was shorter in the bundle group (2 vs. 3 days).',
      'Length of stay in the intensive care unit did not differ significantly.',
    ] },
    { kind: 'caption', s: ['Figure 1. Cumulative incidence of delirium by study group.'] },
    { kind: 'body', s: [
      'Adherence to the bundle exceeded 85% across all intervention units.',
      'No adverse events related to the intervention were reported.',
      'Subgroup analyses showed consistent effects across age groups and admission types.',
      'Ventilator-free days were slightly higher in the bundle group.',
      'Sensitivity analyses excluding early deaths yielded similar results.',
    ] },
    { kind: 'heading', s: ['4. Discussion'] },
    { kind: 'body', s: [
      'In this trial, a nurse-led bundle reduced the incidence of delirium by about one third.',
      'This effect is clinically meaningful given the burden of delirium in critical care.',
      'Our findings extend earlier single-center studies to a multicenter population.',
      'The high adherence suggests that the bundle fits within routine nursing workflows.',
    ] },
    { kind: 'furniture', s: ['3'] },
  ],
  [
    { kind: 'body', s: [
      'Mechanisms underlying the benefit are likely multifactorial.',
      'Early mobilization may reduce sedative exposure and improve sleep quality.',
      'Family engagement can provide familiar cues that support orientation.',
      'Structured reorientation may help patients interpret an unfamiliar environment.',
      'Together these components address several known precipitating factors.',
    ] },
    { kind: 'body', s: [
      'Several limitations should be noted.',
      'Outcome assessors were not blinded to group allocation, which may have introduced detection bias.',
      'The trial was not powered to detect differences in mortality.',
      'Future studies should examine long-term cognitive outcomes after discharge.',
    ] },
    { kind: 'heading', s: ['5. Conclusion'] },
    { kind: 'body', s: [
      'A nurse-led delirium prevention bundle was effective and feasible in intensive care units.',
      'Implementation of such bundles should be considered as part of standard critical care nursing.',
    ] },
    { kind: 'heading', s: ['References'] },
    { kind: 'reference', s: [
      '1. Ely EW, Inouye SK, Bernard GR, et al. Delirium in mechanically ventilated patients. JAMA. 2001;286:2703-2710.',
      '2. Inouye SK, Westendorp RG, Saczynski JS. Delirium in elderly people. Lancet. 2014;383:911-922.',
      '3. Devlin JW, Skrobik Y, Gélinas C, et al. Clinical practice guidelines for the prevention and management of pain, agitation, and delirium. Crit Care Med. 2018;46:e825-e873.',
      '4. Pun BT, Balas MC, Barnes-Daly MA, et al. Caring for critically ill patients with the ABCDEF bundle. Crit Care Med. 2019;47:3-14.',
    ] },
    { kind: 'furniture', s: ['4'] },
  ],
];

/** Build the synthetic PaperDoc (deterministic). */
export function buildSyntheticDoc() {
  let text = '';
  const pages = [];
  const sentences = [];
  const sentenceById = new Map();
  const paragraphs = [];
  PAGES.forEach((paras, pi) => {
    const pageNumber = pi + 1;
    if (pi) text += '\n\n';
    const textStart = text.length;
    let n = 0;
    paras.forEach((para, gi) => {
      if (gi) text += '\n\n';
      const sids = [];
      para.s.forEach((str, si) => {
        if (si) text += ' ';
        const start = text.length;
        text += str;
        const sid = `p${pageNumber}-${n++}`;
        const sentence = { sid, start, end: text.length, text: str, page: pageNumber, pages: [pageNumber], pid: `p${pageNumber}-g${gi}`, kind: para.kind };
        sentences.push(sentence);
        sentenceById.set(sid, sentence);
        sids.push(sid);
      });
      paragraphs.push({ pid: `p${pageNumber}-g${gi}`, page: pageNumber, sids, kind: para.kind });
    });
    pages.push({ pageNumber, width: 612, height: 792, textStart, textEnd: text.length });
  });
  return {
    segVersion: SEG_VERSION,
    numPages: PAGES.length,
    text,
    pages,
    sentences,
    sentenceById,
    paragraphs,
    references: [],
    meta: { title: PAGES[0][0].s[0], authors: 'Jane Doe, Min-ji Kim, Alex Smith', year: 2025, abstract: PAGES[0][3].s.join(' ') },
    hasTextLayer: true,
  };
}

export async function extractDocument(pdf, { onProgress } = {}) {
  if (pdf?._scanned) {
    return { ...buildSyntheticDoc(), sentences: [], sentenceById: new Map(), paragraphs: [], text: '', hasTextLayer: false };
  }
  const doc = buildSyntheticDoc();
  for (let p = 1; p <= doc.numPages; p++) {
    await new Promise((r) => setTimeout(r, 40));
    onProgress?.({ page: p, numPages: doc.numPages });
  }
  return doc;
}

/** Reads "/Title (…)" from the fake PDF bytes when present. */
export async function quickMeta(pdf) {
  const bytes = pdf?._bytes;
  let title = '';
  if (bytes) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 400));
    title = /\/Title \(([^)]*)\)/.exec(head)?.[1] || '';
  }
  return { title, authors: title ? 'Test Author' : '', year: title ? 2024 : null, pages: pdf?.numPages || 4 };
}

export function docOffsetToPage(doc, offset) {
  return doc.pages.find((p) => offset >= p.textStart && offset < p.textEnd)?.pageNumber || 1;
}
