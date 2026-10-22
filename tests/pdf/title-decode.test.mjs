// Title repair (docs/notes/pdf.md §10): PDF Info titles that arrive as hex strings or mis-decoded bytes,
// file-name titles, quickMeta on generated PDFs, and the library's one-time repair of stored hex titles.
//   node tests/pdf/title-decode.test.mjs
// Uses the pdfjs-dist legacy build in the test tools folder (never vendored into the repo). The PDFs are built
// here from invented text; nothing leaves the machine (the fake GitHub listens on loopback).
// Results: C:/Users/dindoo/Projects/pr-tools/out/pdf/title-decode.results.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { memoryDb } from '../store/memory-db.mjs';
import { startFakeGitHub } from '../store/fake-github.mjs';
import {
  HEX_TITLE_RE, decodePdfString, decodePdfTitle, decodeTextBytes, hexToBytes, looksLikeFileName, readPdfTitle,
} from '../../js/pdf/pdf-text.js';

const TOOLS = 'C:/Users/dindoo/Projects/pr-tools';
const OUT = `${TOOLS}/out/pdf`;
mkdirSync(OUT, { recursive: true });

const external = [];
const loopbackFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const href = String(url?.url ?? url);
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(href)) {
    external.push(href);
    return Promise.reject(new TypeError(`blocked non-loopback request in tests: ${href}`));
  }
  return loopbackFetch(url, init);
};

// The legacy build only needs these to exist for text extraction (as tests/pdf/extract-node.mjs).
globalThis.DOMMatrix ??= class DOMMatrix {
  constructor() { Object.assign(this, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }); }
  multiplySelf() { return this; }
  preMultiplySelf() { return this; }
  translate() { return this; }
  scale() { return this; }
  invertSelf() { return this; }
};
globalThis.ImageData ??= class ImageData {};
globalThis.Path2D ??= class Path2D {};
const pdfjs = await import(`file:///${TOOLS}/pdfjs-pkg/package/legacy/build/pdf.mjs`);
const { quickMeta } = await import('../../js/pdf/extract.js');
const { Library } = await import('../../js/store/library.js');

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, what) {
  assert(actual === expected, `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function test(name, fn) {
  const t0 = Date.now();
  try {
    const evidence = await fn();
    results.push({ name, result: 'pass', evidence: String(evidence ?? 'ok') });
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)\n      ${evidence ?? ''}`);
  } catch (err) {
    results.push({ name, result: 'fail', evidence: err?.stack || String(err) });
    console.log(`FAIL  ${name}\n      ${err?.stack || err}`);
  }
}
async function waitFor(fn, timeout = 8000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
/** UTF-16BE with a BOM, as a PDF hex string body. */
const utf16Hex = (s) => `FEFF${Array.from(s, (c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('')}`;
/** What pdf.js returns for a PDF string without a BOM: each byte read as PDFDocEncoding. */
const PDFDOC = new Map([[0x80, 0x2022], [0x84, 0x2014], [0x85, 0x2013], [0x8d, 0x201c], [0x8e, 0x201d], [0x90, 0x2019], [0x9c, 0x153]]);
const asPdfDoc = (bytes) => Array.from(bytes, (b) => String.fromCharCode(PDFDOC.get(b) ?? b)).join('');
const eucKrHex = 'C3D6C1BEB3EDB9AE2E687770'; // EUC-KR bytes of '최종논문.hwp'

// ------------------------------------------------------------------------------------------ PDF builder

/**
 * A one-page PDF (Helvetica / Helvetica-Bold, standard fonts) with the given lines and an optional Info Title
 * written verbatim (`(…)` literal or `<…>` hex PDF syntax).
 * @param {{ title?: string, lines: { text: string, size: number, y: number, bold?: boolean, x?: number }[] }} spec
 */
function makePdf({ title, lines }) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = lines.map((l) => `BT /${l.bold ? 'F2' : 'F1'} ${l.size} Tf ${l.x ?? 72} ${l.y} Td (${esc(l.text)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< ${title != null ? `/Title ${title} ` : ''}/Producer (title-decode test) >>`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

// Invented body text (not from any paper).
const BODY = [
  'Delirium is a frequent complication in adult intensive care units and is linked to longer stays.',
  'This invented paragraph exists only to give the test page a body font size and a few dozen lines.',
  'Nurses assessed every patient twice a day with a validated screening tool during the study period.',
  'The intervention combined early mobilisation, sleep protection, family visits and reorientation.',
  'Outcomes were compared between the two periods with adjustment for age and illness severity.',
];
/** `count` body lines at 10 pt from y downwards (a dense page). */
const bodyLines = (count, y = 600) => Array.from({ length: count }, (_, k) => ({ text: BODY[k % BODY.length], size: 10, y: y - 12 * k }));
const TITLE_LINES = [
  { text: 'Effects of a Nurse-Led Sleep Bundle on Delirium', size: 20, y: 720, bold: true },
  { text: 'in Mechanically Ventilated Adults', size: 20, y: 696, bold: true },
  { text: 'Jane Doe, Min Kim and Alex Smith', size: 11, y: 664 },
];
const TITLE_TEXT = 'Effects of a Nurse-Led Sleep Bundle on Delirium in Mechanically Ventilated Adults';

async function metaOf(spec) {
  const pdf = await pdfjs.getDocument({ data: makePdf(spec), verbosity: 0, standardFontDataUrl: `${TOOLS}/pdfjs-pkg/package/standard_fonts/` }).promise;
  try {
    const info = (await pdf.getMetadata()).info;
    return { meta: await quickMeta(pdf), infoTitle: info?.Title ?? null };
  } finally {
    await pdf.destroy();
  }
}

// ------------------------------------------------------------------------------------------ decoding

await test('hex Info title <C3D6C1BEB3EDB9AE2E687770> (EUC-KR) → 최종논문 (.hwp stripped, marked file-like)', async () => {
  eq(decodePdfString(`<${eucKrHex}>`), '최종논문.hwp', 'decoded bytes');
  const r = readPdfTitle(`<${eucKrHex}>`);
  eq(r.title, '최종논문', 'title');
  eq(r.fileLike, true, 'fileLike');
  eq(decodePdfTitle(`< ${eucKrHex.match(/../g).join(' ')} >`), '최종논문', 'hex with spaces (PDF allows whitespace)');
  assert(HEX_TITLE_RE.test(`<${eucKrHex}>`) && !HEX_TITLE_RE.test('<abc>') && !HEX_TITLE_RE.test('A <C3D6> study'), 'HEX_TITLE_RE');
  return `‘<${eucKrHex}>’ → ‘${r.title}’ (fileLike)`;
});

await test('UTF-16BE (FEFF BOM) hex → text; UTF-16LE BOM; UTF-8 hex; odd digit count; not text → ""', async () => {
  const ko = '섬망 예방 중재의 효과';
  eq(decodePdfTitle(`<${utf16Hex(ko)}>`), ko, 'UTF-16BE');
  const le = Array.from(ko, (c) => { const v = c.charCodeAt(0); return [v & 0xff, v >> 8]; }).flat();
  eq(decodePdfTitle(`<FFFE${hex(le)}>`), ko, 'UTF-16LE');
  eq(decodePdfTitle(`<${hex(new TextEncoder().encode('중환자실 간호'))}>`), '중환자실 간호', 'UTF-8 hex');
  eq(decodePdfTitle(`<${utf16Hex('Sleep and delirium')}>`), 'Sleep and delirium', 'UTF-16BE ASCII');
  eq(hexToBytes('414').join(','), '65,64', 'odd final digit is followed by 0');
  eq(decodePdfTitle('<0001FFFE>'), '', 'binary is not a title');
  eq(decodeTextBytes(new Uint8Array([0xfe, 0xff, 0x00, 0x1b, 0x6b, 0x6f, 0x00, 0x1b, 0xd5, 0x5c])) ?? '', '한', 'UTF-16 language escape dropped');
  eq(decodePdfTitle('<436166E9>'), 'Café', 'Latin-1 bytes fall back to PDFDocEncoding');
  return `UTF-16BE ‘${ko}’, UTF-16LE, UTF-8, Latin-1 fallback, binary → ''`;
});

await test('bytes pdf.js read as PDFDocEncoding (no BOM): EUC-KR and UTF-8 re-decoded; Latin-1 and Unicode titles left alone', async () => {
  const euckr = asPdfDoc(hexToBytes(eucKrHex));
  eq(euckr, 'ÃÖÁ¾³í¹®.hwp', 'what pdf.js shows');
  eq(decodePdfTitle(euckr), '최종논문', 'EUC-KR mojibake');
  const utf8 = asPdfDoc(new TextEncoder().encode('최종논문 연구 계획'));
  eq(decodePdfTitle(utf8), '최종논문 연구 계획', 'UTF-8 mojibake (with PDFDocEncoding specials)');
  for (const t of ['Résumé of naïve façade cases', 'Effects of “early” mobilisation – a review', 'Æsthetic Ölmalerei und Ça va',
    '중환자실 간호사의 섬망 인식', 'Ελληνικά and English', 'Sedation α2-agonists: ≥ 3 days']) {
    eq(decodePdfTitle(t), t, `unchanged ${t}`);
  }
  return `‘${euckr}’ → ‘최종논문’; UTF-8 bytes → Hangul; 6 legitimate titles unchanged`;
});

await test('plain ASCII titles unchanged; “Microsoft Word - …”, paths and extensions stripped; placeholders dropped', async () => {
  for (const t of ['Unplanned extubation in critically ill adults: clinical review', 'A Coefficient of Agreement for Nominal Scales',
    'COVID-19 and ARDS: a narrative review', 'The Kappa Statistic in Reliability Studies']) {
    const r = readPdfTitle(t);
    eq(r.title, t, 'ascii');
    eq(r.fileLike, false, `fileLike ${t}`);
  }
  eq(readPdfTitle('  Sleep   and\tdelirium  ').title, 'Sleep and delirium', 'whitespace collapsed');
  const word = readPdfTitle('Microsoft Word - Effects of early mobilization.docx');
  eq(word.title, 'Effects of early mobilization', 'MS Word prefix + .docx');
  eq(word.fileLike, true, 'a printed file name is file-like');
  eq(decodePdfTitle(`Microsoft Word - <${eucKrHex}>`), '최종논문', 'prefix + hex');
  eq(decodePdfTitle(['C:', 'Users', 'kim', '최종논문.hwp'].join('\\')), '최종논문', 'Windows path');
  eq(decodePdfTitle('/Users/kim/Thesis/final draft.hwpx'), 'final draft', 'POSIX path');
  eq(decodePdfTitle('report.hwp.pdf'), 'report', 'double extension');
  for (const t of ['Untitled', 'Document1', 'Microsoft Word - Document2', '제목 없음']) eq(decodePdfTitle(t), '', `placeholder ${t}`);
  return 'ASCII titles identical; prefix/path/extension stripped; placeholders → ""';
});

await test('file-name / code detection', async () => {
  const fileLike = ['G09_McGrath2020_ICS_NTSP_TrachCareGuidance', 'E41_KimEunji2021_SNU_석사_EICU_VAP', '최종논문', '최종본', '논문_최종',
    '수정본(2)', 'manuscript_v2', 'Final draft', 'main', '2021_03', '___', '12345', 'G09', 'KimEunji2021', 'TrachCareGuidance',
    '1-s2.0-S0964339720300123-main', 'ijerph-17-01234', 'SNU 2021', 'G09 E41', 'paper.pdf', 'doi 10.1111/jocn.12345', 'a_b', ''];
  const titles = ['Delirium in the ICU', '중환자실 간호사의 섬망 인식', 'Unplanned extubation in critically ill adults: clinical review',
    'COVID-19 and ARDS: a review', 'Delirium', '섬망', 'Sleep_quality and delirium in older adults after cardiac surgery',
    'Effects of a nurse-led bundle (2019–2021)', 'ICU Liberation Bundle (A–F) Implementation'];
  const wrongA = fileLike.filter((t) => !looksLikeFileName(t));
  const wrongB = titles.filter((t) => looksLikeFileName(t));
  assert(!wrongA.length, `not detected: ${JSON.stringify(wrongA)}`);
  assert(!wrongB.length, `real titles flagged: ${JSON.stringify(wrongB)}`);
  return `${fileLike.length} file names/codes detected, ${titles.length} real titles kept`;
});

// ------------------------------------------------------------------------------------------ quickMeta

await test('quickMeta: hex Info Title (PDF hex syntax) + printed title → the printed title; pdf.js shows the bytes as Latin-1', async () => {
  const { meta, infoTitle } = await metaOf({ title: `<${eucKrHex}>`, lines: [...TITLE_LINES, ...bodyLines(30)] });
  eq(infoTitle, 'ÃÖÁ¾³í¹®.hwp', 'pdf.js Info Title');
  eq(meta.title, TITLE_TEXT, 'title');
  eq(meta.authors, 'Jane Doe, Min Kim, Alex Smith', 'authors still found after the title block');
  return `Info ‘${infoTitle}’ (= 최종논문.hwp, file-like) → page-1 title ‘${meta.title}’`;
});

await test('quickMeta: literal ‘<C3D6…>’ Info Title on a dense page without a larger block → 최종논문 (decoded metadata kept)', async () => {
  const { meta, infoTitle } = await metaOf({ title: `(<${eucKrHex}>)`, lines: bodyLines(40, 740) });
  eq(infoTitle, `<${eucKrHex}>`, 'pdf.js Info Title');
  eq(meta.title, '최종논문', 'title');
  return `Info ‘${infoTitle}’ → ‘${meta.title}’`;
});

await test('quickMeta: file-name Info Title (G09_McGrath2020_…) → the printed title; without one the decoded name stays', async () => {
  const a = await metaOf({ title: '(G09_McGrath2020_ICS_NTSP_TrachCareGuidance)', lines: [...TITLE_LINES, ...bodyLines(30)] });
  eq(a.meta.title, TITLE_TEXT, 'printed title preferred');
  const b = await metaOf({ title: '(Microsoft Word - E41_KimEunji2021_SNU_EICU_VAP.docx)', lines: bodyLines(40, 740) });
  eq(b.meta.title, 'E41_KimEunji2021_SNU_EICU_VAP', 'no printed title: decoded metadata title, without prefix and extension');
  return `‘${a.infoTitle}’ → ‘${a.meta.title}’; ‘${b.infoTitle}’ → ‘${b.meta.title}’`;
});

await test('quickMeta: thesis cover (title in the page’s most common size, larger “MASTER’S THESIS” label) → the cover title', async () => {
  const cover = [
    { text: "MASTER'S THESIS", size: 16, y: 720, bold: true },
    { text: "Nurses' Perception of Ventilator-Associated Pneumonia", size: 14, y: 600, bold: true },
    { text: 'Prevention in an Emergency Intensive Care Unit', size: 14, y: 582, bold: true },
    { text: 'Graduate School of Nursing', size: 12, y: 400 },
    { text: 'Example University', size: 12, y: 384 },
    { text: 'Hong Gildong', size: 12, y: 300 },
  ];
  const expected = "Nurses' Perception of Ventilator-Associated Pneumonia Prevention in an Emergency Intensive Care Unit";
  const hexInfo = await metaOf({ title: `<${eucKrHex}>`, lines: cover });
  eq(hexInfo.meta.title, expected, 'hex 최종논문.hwp Info + cover');
  const none = await metaOf({ lines: cover });
  eq(none.meta.title, expected, 'no Info Title + cover');
  return `‘${hexInfo.meta.title}’`;
});

await test('quickMeta: sane Info titles unchanged (ASCII, UTF-16BE Korean); no Info + dense page → "" as before', async () => {
  const a = await metaOf({ title: '(A Randomised Trial of Early Mobilisation in Ventilated Adults)', lines: [...TITLE_LINES, ...bodyLines(30)] });
  eq(a.meta.title, 'A Randomised Trial of Early Mobilisation in Ventilated Adults', 'ASCII Info title wins as before');
  const ko = '응급중환자실 간호사의 인공호흡기 관련 폐렴 예방 인식';
  const b = await metaOf({ title: `<${utf16Hex(ko)}>`, lines: [...TITLE_LINES, ...bodyLines(30)] });
  eq(b.infoTitle, ko, 'pdf.js decodes the BOM itself');
  eq(b.meta.title, ko, 'UTF-16BE Info title');
  const c = await metaOf({ lines: bodyLines(40, 740) });
  eq(c.meta.title, '', 'no title found');
  return `‘${a.meta.title}’; ‘${b.meta.title}’; dense page without title → ''`;
});

// ------------------------------------------------------------------------------------------ library repair

function makePdfBytes(seed, size = 4000) {
  const out = new Uint8Array(size);
  out.set(new TextEncoder().encode('%PDF-1.7\n%synthetic test file\n'));
  let x = seed >>> 0 || 1;
  for (let i = 32; i < size; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}
let dbSeq = 0;
const freshDb = (tag) => memoryDb(`title-${tag}-${++dbSeq}`);
const storedLibrary = (db) => JSON.parse(db.stores.files.get('library.json').data);
const opened = [];
async function track(promise) { const lib = await promise; opened.push(lib); return lib; }

try {
  await test('library load: stored ‘<hex>’ titles are decoded and written back once (binary → file name; others untouched; tombstones too)', async () => {
    const db = freshDb('load');
    const L1 = await track(Library.open({ db }));
    const a = await L1.addPaper(makePdfBytes(1), { fileName: 'E41.pdf', meta: { title: `<${eucKrHex}>` } });
    const b = await L1.addPaper(makePdfBytes(2), { fileName: 'Kim2021_thesis.pdf', meta: { title: '<0001FFFE>' } });
    const c = await L1.addPaper(makePdfBytes(3), { fileName: 'c.pdf', meta: { title: 'Delirium prevention bundle' } });
    const d = await L1.addPaper(makePdfBytes(4), { fileName: 'd.pdf', meta: { title: `<${utf16Hex('한글 제목')}>` } });
    const e = await L1.addPaper(makePdfBytes(5), { fileName: 'e.pdf', meta: { title: `<${eucKrHex}>` } });
    eq(L1.getPaper(a.id).title, `<${eucKrHex}>`, 'addPaper stores what it is given (an old client)');
    L1.deletePaper(e.id);
    await L1.close();
    const before = storedLibrary(db);
    const cBefore = before.papers.find((p) => p.id === c.id);

    const L2 = await track(Library.open({ db }));
    eq(L2.getPaper(a.id).title, '최종논문', 'EUC-KR hex');
    eq(L2.getPaper(b.id).title, 'Kim2021_thesis', 'binary hex → file name');
    eq(L2.getPaper(c.id).title, 'Delirium prevention bundle', 'plain title');
    eq(L2.getPaper(d.id).title, '한글 제목', 'UTF-16BE hex');
    await L2.close();
    const after = storedLibrary(db);
    const byId = new Map(after.papers.map((p) => [p.id, p]));
    eq(byId.get(a.id).title, '최종논문', 'written to library.json');
    eq(byId.get(e.id).title, '최종논문', 'tombstone repaired too');
    assert(byId.get(e.id).deleted === true, 'tombstone stays deleted');
    assert(byId.get(a.id).updatedAt > before.papers.find((p) => p.id === a.id).updatedAt, 'repaired record stamped');
    assert(JSON.stringify(byId.get(c.id)) === JSON.stringify(cBefore), 'untouched record unchanged');

    const L3 = await track(Library.open({ db }));
    await L3.close();
    const again = storedLibrary(db);
    eq(JSON.stringify(again), JSON.stringify(after), 'second load writes nothing');
    return `‘<${eucKrHex}>’ → ‘최종논문’, ‘<0001FFFE>’ → ‘Kim2021_thesis’, UTF-16BE → ‘한글 제목’, tombstone repaired; reload: no write`;
  });

  await test('library remote: a fresh device that pulls a ‘<hex>’ title repairs it and pushes it back once (fake GitHub on loopback)', async () => {
    const gh = await startFakeGitHub({ port: 0 });
    try {
      gh.addToken('ghp_title_token', { write: true });
      gh.createRepo('me', 'paper-library', { private: true, files: { 'README.md': 'mine' } });
      const getConfig = () => ({ owner: 'me', repo: 'paper-library', branch: 'main', token: 'ghp_title_token', apiBase: gh.url });
      const syncOptions = { pushDelayMs: 40, pushMaxDelayMs: 200, pullIntervalMs: 600_000, retryDelaysMs: [300, 600, 1200] };
      const remoteLib = () => JSON.parse(gh.readFile('me', 'paper-library', 'library.json').toString('utf8'));
      const idle = (lib) => waitFor(() => lib.sync.status.state === 'idle' && lib.sync.status.pending === 0, 15000, 'sync idle');

      const A = await track(Library.open({ db: freshDb('remote-a'), getConfig, syncOptions }));
      await A.sync.syncNow();
      const p = await A.addPaper(makePdfBytes(9), { fileName: 'x.pdf', meta: { title: `<${eucKrHex}>` } }); // as an old version stored it
      await A.flush();
      await idle(A);
      eq(remoteLib().papers.find((r) => r.id === p.id).title, `<${eucKrHex}>`, 'old title on GitHub');

      const B = await track(Library.open({ db: freshDb('remote-b'), getConfig, syncOptions }));
      await B.sync.syncNow();
      await waitFor(() => B.getPaper(p.id)?.title === '최종논문', 8000, 'B repaired the pulled title');
      await B.flush();
      await idle(B);
      await waitFor(() => remoteLib().papers.find((r) => r.id === p.id).title === '최종논문', 8000, 'repaired title pushed');
      await A.sync.syncNow();
      await waitFor(() => A.getPaper(p.id)?.title === '최종논문', 8000, 'A pulls the repaired title');
      await idle(A);
      const commits = gh.commits ? gh.commits('me', 'paper-library')?.length : null;
      await sleep(400);
      const commitsLater = gh.commits ? gh.commits('me', 'paper-library')?.length : null;
      assert(commits === commitsLater, `no further commits (${commits} → ${commitsLater})`);
      return `B pulled ‘<${eucKrHex}>’, wrote ‘최종논문’, GitHub and A now show it${commits != null ? `; commits stable at ${commits}` : ''}`;
    } finally {
      await gh.close();
    }
  });
} finally {
  for (const lib of opened) await lib.close().catch(() => {});
}

writeFileSync(`${OUT}/title-decode.results.json`, JSON.stringify({ results, external }, null, 2));
const failed = results.filter((r) => r.result !== 'pass').length;
console.log(`\ntitle decode: ${results.length - failed}/${results.length} passed · blocked external requests: ${external.length}`);
process.exitCode = failed || external.length ? 1 : 0;
