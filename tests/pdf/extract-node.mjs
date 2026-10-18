// Node runner for js/pdf/extract.js (no browser): extraction stats, sample sentences and full dumps.
//   node tests/pdf/extract-node.mjs [fixture ...] [--dump] [--samples=15] [--seed=1]
// Uses the pdfjs-dist legacy build that lives in the test tools folder (never vendored into the repo).
// Fixture PDFs are copyrighted: output stays local (stdout + C:/Users/dindoo/Projects/pr-tools/out/pdf/).
import fs from 'node:fs';
import path from 'node:path';

const TOOLS = 'C:/Users/dindoo/Projects/pr-tools';
const FIXTURES = 'C:/Users/dindoo/Projects/pr-fixtures';
const OUT = `${TOOLS}/out/pdf`;

// The legacy build only needs these to exist for text extraction (no rendering in Node).
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
const { extractDocument, quickMeta, SEG_VERSION } = await import(new URL('../../js/pdf/extract.js', import.meta.url).href);

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.slice(2).split('=');
  return [k, v ?? true];
}));
const names = args.filter((a) => !a.startsWith('--'));
const fixtures = names.length ? names : ['lu2025', 'kiekkas2012', 'simwright2005', 'cohen1960'];
const sampleCount = Number(flags.samples || 15);

/** Small deterministic PRNG so sample picks are reproducible. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
for (const name of fixtures) {
  const data = new Uint8Array(fs.readFileSync(path.join(FIXTURES, `${name}.pdf`)));
  const pdf = await pdfjs.getDocument({ data, verbosity: 0, standardFontDataUrl: `${TOOLS}/pdfjs-pkg/package/standard_fonts/` }).promise;
  const t0 = performance.now();
  const doc = await extractDocument(pdf);
  const ms = performance.now() - t0;
  const t1 = performance.now();
  const qm = await quickMeta(pdf);
  const qms = performance.now() - t1;

  const kinds = {};
  for (const s of doc.sentences) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
  console.log(`\n=== ${name}  (SEG_VERSION ${SEG_VERSION})`);
  console.log(`pages=${doc.numPages} sentences=${doc.sentences.length} paragraphs=${doc.paragraphs.length} chars=${doc.text.length} refs=${doc.references.length} hasTextLayer=${doc.hasTextLayer} time=${ms.toFixed(0)}ms quickMeta=${qms.toFixed(0)}ms`);
  console.log('kinds', JSON.stringify(kinds));
  console.log('meta.title   ', JSON.stringify(doc.meta.title));
  console.log('meta.authors ', JSON.stringify(doc.meta.authors));
  console.log('meta.year    ', doc.meta.year, '| quickMeta:', JSON.stringify({ title: qm.title.slice(0, 60), authors: qm.authors.slice(0, 60), year: qm.year, pages: qm.pages }));
  console.log('meta.abstract', doc.meta.abstract.length, 'chars:', JSON.stringify(doc.meta.abstract.slice(0, 160)));

  // Invariants of the contract.
  const problems = checkInvariants(doc);
  if (problems.length) {
    failures++;
    console.log('INVARIANT PROBLEMS:', problems.slice(0, 10));
  } else {
    console.log('invariants: ok');
  }

  const rand = rng(Number(flags.seed || 1) + name.length);
  const body = doc.sentences.filter((s) => s.kind === 'body');
  console.log(`-- ${Math.min(sampleCount, body.length)} random body sentences:`);
  for (let k = 0; k < Math.min(sampleCount, body.length); k++) {
    const s = body[Math.floor(rand() * body.length)];
    console.log(`  [${s.sid}] ${s.text.length > 260 ? `${s.text.slice(0, 260)}…` : s.text}`);
  }
  if (doc.references.length) {
    console.log('-- references (first 3, last 1):');
    for (const r of [...doc.references.slice(0, 3), doc.references[doc.references.length - 1]]) {
      console.log(`  #${r.index} n=${r.n} p${r.page} bbox=${[r.bbox.x, r.bbox.y, r.bbox.w, r.bbox.h].map((v) => v.toFixed(0)).join(',')} ${r.text.slice(0, 120)}`);
    }
  }
  if (flags.dump) {
    const lines = [];
    for (const para of doc.paragraphs) {
      lines.push(`\n## ${para.pid} [${para.kind}]`);
      for (const sid of para.sids) lines.push(`  ${sid}: ${doc.sentenceById.get(sid).text}`);
    }
    fs.writeFileSync(`${OUT}/sentences-${name}.txt`, lines.join('\n'));
    console.log(`dump → ${OUT}/sentences-${name}.txt`);
  }
  await pdf.destroy();
}
process.exitCode = failures ? 1 : 0;

function checkInvariants(doc) {
  const out = [];
  const { text, _map: map } = doc;
  if (map.charPage.length !== text.length) out.push('map length mismatch');
  let prev = -1;
  for (const s of doc.sentences) {
    if (s.start < prev) out.push(`out of order ${s.sid}`);
    prev = s.end;
    if (text.slice(s.start, s.end).trim() !== s.text) out.push(`text mismatch ${s.sid}`);
    if (!/^p\d+-\d+$/.test(s.sid)) out.push(`bad sid ${s.sid}`);
    if (!s.pages.includes(s.page) && s.pages.length) out.push(`page not in pages ${s.sid}`);
  }
  if (new Set(doc.sentences.map((s) => s.sid)).size !== doc.sentences.length) out.push('duplicate sids');
  // Reverse map round trip: every mapped char points back to itself.
  for (let p = 1; p <= doc.numPages; p++) {
    const arrs = doc._itemToDoc[p];
    arrs.forEach((arr, i) => {
      for (let k = 0; k < arr.length; k++) {
        const d = arr[k];
        if (d < 0) continue;
        if (map.charPage[d] !== p || map.charItem[d] !== i || map.charOff[d] !== k) out.push(`map mismatch p${p} i${i} k${k}`);
      }
    });
  }
  for (let d = 0; d < text.length; d++) {
    if (map.charItem[d] < 0) {
      if (!/[\s\n]/.test(text[d])) out.push(`synthetic non-space at ${d}: ${JSON.stringify(text[d])}`);
      continue;
    }
    if (doc._itemToDoc[map.charPage[d]][map.charItem[d]][map.charOff[d]] !== d) out.push(`reverse mismatch at ${d}`);
  }
  for (let k = 1; k < doc.pages.length; k++) {
    if (doc.pages[k].textStart < doc.pages[k - 1].textStart) out.push(`page ranges not monotonic at ${k + 1}`);
  }
  // Every mapped char must lie inside its page's range.
  for (let d = 0; d < text.length; d++) {
    const p = map.charPage[d];
    if (p < 1) continue;
    const info = doc.pages[p - 1];
    if (d < info.textStart || d >= info.textEnd) { out.push(`char ${d} of page ${p} outside its page range`); break; }
  }
  return out;
}
