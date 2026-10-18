// Token → USD. The table and the rules are the app's (js/core/config.js PRICES, js/ai/usage.js costUsd), so the
// relay's budgets and the app's estimates agree. Keep both in sync when Anthropic's prices change.

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

/** Absolute cache-read prices that differ from CACHE_READ_FACTOR (a `cacheRead` on the PRICES entry wins). */
const CACHE_READ_OVERRIDES = { 'claude-opus-5-5': 0.20 };

/** A model missing from PRICES (e.g. a new fallback target) is priced like this one rather than booked as free. */
export const UNKNOWN_MODEL_PRICED_AS = 'claude-sonnet-5-5';

/**
 * @typedef {{ model: string, inputTokens: number, outputTokens: number,
 *             cacheReadTokens: number, cacheWriteTokens: number }} UsagePart
 */

/** PRICES key for a model id; tolerates dated/suffixed ids like "claude-haiku-5-5-20261001". */
export function priceKey(model) {
  if (!model) return null;
  if (PRICES[model]) return model;
  return Object.keys(PRICES).find((k) => model.startsWith(`${k}-`) || model.startsWith(`${k}@`)) || null;
}

/**
 * Cost of one attempt in USD. The long-context rate card (Claude Haiku 5.5 above 100K prompt tokens) is chosen by
 * the TOTAL prompt size (uncached input + cache reads + cache writes) and applies to every token of the attempt.
 * @param {UsagePart} usage
 */
export function costUsd(usage) {
  if (!usage) return 0;
  const key = priceKey(usage.model) || UNKNOWN_MODEL_PRICED_AS;
  const price = PRICES[key];
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const cacheRead = num(usage.cacheReadTokens);
  const cacheWrite = num(usage.cacheWriteTokens);
  const promptTokens = input + cacheRead + cacheWrite;
  const isLong = Boolean(price.long) && promptTokens > price.long.threshold;
  const rates = isLong ? price.long : price;
  const cacheReadRate = isLong
    ? rates.input * CACHE_READ_FACTOR
    : price.cacheRead ?? CACHE_READ_OVERRIDES[key] ?? rates.input * CACHE_READ_FACTOR;
  const cacheWriteRate = price.cacheWrite ?? rates.input * CACHE_WRITE_FACTOR;
  const usd = input * rates.input + output * rates.output + cacheRead * cacheReadRate + cacheWrite * cacheWriteRate;
  return usd / 1_000_000;
}

function num(v) {
  return Number.isFinite(v) && v > 0 ? v : 0;
}
