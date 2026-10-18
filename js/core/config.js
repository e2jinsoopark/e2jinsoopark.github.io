// Static configuration: versions, model defaults, prices.
export const APP_VERSION = '0.1.0';

export const VENDOR = {
  pdfjs: new URL('../../vendor/pdfjs/pdf.min.mjs', import.meta.url).href,
  pdfjsWorker: new URL('../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href,
  // Pass these to pdfjsLib.getDocument({ cMapUrl, cMapPacked: true, standardFontDataUrl, wasmUrl, iccUrl }).
  // cMaps are required for CJK (Korean) PDFs; wasm decodes JPX/JBIG2 images.
  pdfjsCMapUrl: new URL('../../vendor/pdfjs/cmaps/', import.meta.url).href,
  pdfjsStandardFontUrl: new URL('../../vendor/pdfjs/standard_fonts/', import.meta.url).href,
  pdfjsWasmUrl: new URL('../../vendor/pdfjs/wasm/', import.meta.url).href,
  pdfjsIccUrl: new URL('../../vendor/pdfjs/iccs/', import.meta.url).href,
  marked: new URL('../../vendor/marked/marked.esm.js', import.meta.url).href,
  dompurify: new URL('../../vendor/dompurify/purify.es.mjs', import.meta.url).href,
  // Loaded lazily, only when the Claude provider is used.
  anthropicSdk: 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm',
};

/**
 * Invite-code relay (docs/RELAY.md): base URL of the owner's Cloudflare Worker, e.g.
 * 'https://paper-relay.<account>.workers.dev' (no trailing slash). Empty until the worker is deployed.
 * Deploying: set it here AND add the same origin to connect-src in index.html (the page CSP is static);
 * tests/relay-client/run.mjs fails while the two disagree. See docs/notes/relay-client.md.
 */
export const RELAY_DEFAULT_URL = 'https://paper-relay.e2jinsoopark.workers.dev';

/** Public address of the app; invite links are `${APP_PUBLIC_URL}#/join/<CODE>`. */
export const APP_PUBLIC_URL = 'https://e2jinsoopark.github.io/';

export const CLAUDE_MODELS = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (빠름·저렴)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (고품질)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (최고 품질·비쌈)' },
];

export const DEFAULT_MODELS = {
  claude: { translate: 'claude-haiku-5-5', assist: 'claude-sonnet-5-5' },
  // Invite-code relay: the assist default applies only when the code allows Sonnet (else Haiku, see settings.model()).
  relay: { translate: 'claude-haiku-5-5', assist: 'claude-sonnet-5-5' },
  // Gemini model ids change often; the settings screen lists live models from the API.
  gemini: { translate: '', assist: '' },
  mock: { translate: 'mock', assist: 'mock' },
};

/**
 * USD per 1M tokens. Claude prices from Anthropic's published table (cached 2026-10-06).
 * cacheRead ≈ 0.1× input, cacheWrite ≈ 1.25× input (5-minute TTL).
 * Haiku 5.5: prompts over 100K tokens are billed at the "long" rates.
 */
export const PRICES = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50, long: { threshold: 100_000, input: 0.50, output: 2.50 } },
  'claude-sonnet-5-5': { input: 2.00, output: 10.00, cacheRead: 0.20 },
  'claude-opus-5-5': { input: 4.00, output: 20.00, cacheRead: 0.20 },
  // Models the server-side refusal fallback may serve a Sonnet 5.5 / Opus 5.5 request with.
  'claude-sonnet-5': { input: 2.00, output: 10.00 },
  'claude-opus-5': { input: 5.00, output: 25.00 },
  'claude-opus-4-8': { input: 5.00, output: 25.00 },
  mock: { input: 0, output: 0 },
};
export const CACHE_READ_FACTOR = 0.1;
export const CACHE_WRITE_FACTOR = 1.25;

export const LIMITS = {
  translateBatchMaxSentences: 40,
  translateBatchMaxChars: 3500,
  translateConcurrency: 3,
  // GitHub's blob API takes the file base64-encoded in a JSON body (≈ 1.34 × the file); 70 MB keeps that body
  // under the 100 MB GitHub accepts. Larger uploads are refused by GitHub (the sync engine then skips them).
  maxPdfBytes: 70 * 1024 * 1024,
};

export const STORAGE_KEYS = {
  settings: 'pr.settings.v1',
  usage: 'pr.usage.v1',
  ui: 'pr.ui.v1',
};
