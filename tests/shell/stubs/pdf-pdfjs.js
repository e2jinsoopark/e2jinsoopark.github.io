// Test stub for js/pdf/pdfjs.js — accepts any bytes that start with "%PDF".

export async function getPdfjs() {
  return {};
}

export async function loadPdf(bytes) {
  const copy = new Uint8Array(bytes); // like the real one: never hand the caller's buffer away
  const head = new TextDecoder('latin1').decode(copy.subarray(0, 5));
  if (head !== '%PDF-' && !(copy[0] === 37 && copy[1] === 80)) throw new Error('PDF 형식이 아닙니다.');
  await new Promise((r) => setTimeout(r, 30));
  return { numPages: 4, _bytes: copy, _scanned: /SCANNED/.test(new TextDecoder('latin1').decode(copy.subarray(0, 200))), destroy: async () => {} };
}
