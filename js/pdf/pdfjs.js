// pdf.js loader: imports the vendored build once and opens documents with the right resource URLs.
import { VENDOR } from '../core/config.js';

/** @type {Promise<any> | null} */
let libPromise = null;

/**
 * The pdf.js module (vendored 5.4.624), with the worker configured. Imported once and cached;
 * a failed import is not cached so a later call can retry (e.g. after a flaky network).
 * @returns {Promise<any>} pdfjsLib
 */
export async function getPdfjs() {
  if (!libPromise) {
    libPromise = import(VENDOR.pdfjs)
      .then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = VENDOR.pdfjsWorker;
        return lib;
      })
      .catch((err) => {
        libPromise = null;
        console.warn('[pdf] pdf.js import failed', err);
        throw new Error('PDF 엔진을 불러오지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.');
      });
  }
  return libPromise;
}

/**
 * Open a PDF from bytes. pdf.js transfers (detaches) the buffer it is given, so it always
 * receives a copy and the caller's array stays usable (e.g. for saving to the library).
 * @param {Uint8Array} bytes
 * @returns {Promise<any>} PDFDocumentProxy
 */
export async function loadPdf(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error('PDF 데이터가 비어 있습니다.');
  }
  const lib = await getPdfjs();
  const task = lib.getDocument({
    data: bytes.slice(),
    cMapUrl: VENDOR.pdfjsCMapUrl,
    cMapPacked: true,
    standardFontDataUrl: VENDOR.pdfjsStandardFontUrl,
    wasmUrl: VENDOR.pdfjsWasmUrl,
    iccUrl: VENDOR.pdfjsIccUrl,
    isEvalSupported: false,
    enableXfa: false,
  });
  // Without a password callback pdf.js would wait forever on encrypted files; abort instead.
  let needsPassword = false;
  task.onPassword = () => {
    needsPassword = true;
    task.destroy();
  };
  try {
    return await task.promise;
  } catch (err) {
    console.warn('[pdf] getDocument failed', err);
    throw new Error(needsPassword ? PASSWORD_MESSAGE : describeLoadError(err));
  }
}

const PASSWORD_MESSAGE = '암호로 보호된 PDF는 열 수 없습니다. 암호를 해제한 파일을 올려 주세요.';

/** Korean, user-presentable message for a pdf.js loading error. */
function describeLoadError(err) {
  const name = err?.name || '';
  if (name === 'PasswordException') return PASSWORD_MESSAGE;
  if (name === 'InvalidPDFException') return '올바른 PDF 파일이 아닙니다.';
  if (name === 'MissingPDFException') return 'PDF 파일을 찾을 수 없습니다.';
  return 'PDF를 여는 중 오류가 발생했습니다. 파일이 손상되었을 수 있습니다.';
}
