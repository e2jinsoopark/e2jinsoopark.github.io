// A small synthetic PaperDoc (invented text) shaped exactly like js/pdf/extract.js output.
// Used only by the features test harness.

const PAGE_W = 612;
const PAGE_H = 792;

/** [kind, sentences[]] per paragraph, per page. */
const PAGES = [
  [
    ['heading', ['Early Mobilization and Delirium in Mechanically Ventilated Adults: A Nurse-Led Protocol']],
    ['heading', ['Abstract']],
    ['body', [
      'Delirium is a frequent and costly complication among critically ill adults receiving mechanical ventilation [1].',
      'We evaluated whether a nurse-led early mobilization protocol reduced delirium incidence compared with usual care.',
      'In a cluster trial across six intensive care units, 412 patients were enrolled.',
      'Delirium occurred in 28% of protocol patients versus 41% under usual care (risk ratio 0.68).',
      'Protocol adherence was highest when bedside nurses held daily mobility huddles.',
    ]],
    ['heading', ['1. Introduction']],
    ['body', [
      'Prior studies linked immobility to muscle weakness, longer ventilation and higher mortality [2].',
      'However, implementation in nursing workflows remains inconsistent, as summarized in Figure 1.',
      'Nurses are well placed to lead mobility because they assess sedation and readiness around the clock.',
      'A practice guideline is available at https://example.org/guideline for reference.',
    ]],
  ],
  [
    ['heading', ['2. Methods']],
    ['body', [
      'We conducted a stepped-wedge cluster randomized trial between 2021 and 2023.',
      'Adults ventilated for more than 48 hours were eligible.',
      'Delirium was assessed twice daily with the CAM-ICU by trained nurses.',
      'The protocol defined four mobility levels, from passive range of motion to walking.',
    ]],
    ['caption', ['Figure 1. Mobility levels and nurse-led decision steps used in the protocol.']],
    ['heading', ['3. Results']],
    ['body', [
      'Protocol patients mobilized earlier, at a median of 2.1 days versus 4.5 days.',
      'Delirium-free days increased by 1.8 days on average.',
      'No serious adverse events, such as accidental extubation, were attributed to mobilization.',
      'Staffing shortages were the most frequently reported barrier.',
    ]],
    ['heading', ['4. Discussion']],
    ['body', [
      'A key limitation is that blinding of outcome assessors was not possible.',
      'Future work should test the protocol in community hospitals with fewer resources.',
    ]],
  ],
  [
    ['heading', ['References']],
    ['reference', ['[1] Ely EW, Shintani A, Truman B, et al. Delirium as a predictor of mortality in mechanically ventilated patients in the intensive care unit. JAMA. 2004;291(14):1753-1762. doi:10.1001/jama.291.14.1753']],
    ['reference', ['[2] Schweickert WD, Pohlman MC, Pohlman AS, et al. Early physical and occupational therapy in mechanically ventilated, critically ill patients: a randomised controlled trial. Lancet. 2009;373(9678):1874-1882.']],
    ['reference', ['[3] Park J, Kim S. Nurse-led mobility huddles in intensive care: a quality improvement study. J Crit Care Nurs. 2022;15(2):101-110.']],
  ],
];

/** Reference bboxes (PDF units, top-left origin) on page 3. */
export const REF_BBOXES = [
  { x: 72, y: 120, w: 468, h: 46 },
  { x: 72, y: 176, w: 468, h: 46 },
  { x: 72, y: 232, w: 468, h: 32 },
];

export function buildDoc() {
  let text = '';
  const pages = [];
  const sentences = [];
  const paragraphs = [];
  const references = [];
  PAGES.forEach((paras, pi) => {
    const pageNumber = pi + 1;
    if (pi > 0) text += '\n\n';
    const textStart = text.length;
    let n = 0;
    paras.forEach(([kind, sents], gi) => {
      if (gi > 0) text += '\n\n';
      const sids = [];
      sents.forEach((s, si) => {
        if (si > 0) text += ' ';
        const start = text.length;
        text += s;
        const sid = `p${pageNumber}-${n++}`;
        sentences.push({ sid, start, end: text.length, text: s, page: pageNumber, pages: [pageNumber], pid: `p${pageNumber}-g${gi}`, kind });
        sids.push(sid);
        if (kind === 'reference') {
          const index = references.length;
          references.push({ index, n: index + 1, text: s, start, end: text.length, page: pageNumber, bbox: REF_BBOXES[index] });
        }
      });
      paragraphs.push({ pid: `p${pageNumber}-g${gi}`, page: pageNumber, sids, kind });
    });
    pages.push({ pageNumber, width: PAGE_W, height: PAGE_H, textStart, textEnd: text.length });
  });
  const sentenceById = new Map(sentences.map((s) => [s.sid, s]));
  const abstract = paragraphs.find((p) => p.page === 1 && p.kind === 'body').sids.map((id) => sentenceById.get(id).text).join(' ');
  return {
    segVersion: 1,
    numPages: pages.length,
    text,
    pages,
    sentences,
    sentenceById,
    paragraphs,
    references,
    meta: { title: PAGES[0][0][1][0], authors: 'Kim H, Lee J, Park S', year: 2024, abstract },
    hasTextLayer: true,
  };
}

/** sid of the first sentence containing `needle`. */
export function sidOf(doc, needle) {
  return doc.sentences.find((s) => s.text.includes(needle))?.sid ?? null;
}

export { PAGE_W, PAGE_H };
