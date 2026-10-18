// Token → USD accounting and this browser's monthly usage totals.
import { bus } from '../core/bus.js';
import { CACHE_READ_FACTOR, CACHE_WRITE_FACTOR, PRICES, STORAGE_KEYS } from '../core/config.js';
import { safeStorage } from '../core/util.js';

/**
 * @typedef {{ model: string, inputTokens: number, outputTokens: number,
 *             cacheReadTokens: number, cacheWriteTokens: number }} Usage
 */

/**
 * Absolute cache-read prices (USD / 1M tokens) for models whose cache discount differs from the generic
 * CACHE_READ_FACTOR. Claude Opus 5.5 bills cache reads at $0.20 (0.05× input), per Anthropic's price table.
 * A `cacheRead` field on the PRICES entry itself takes precedence over this table.
 */
const CACHE_READ_OVERRIDES = { 'claude-opus-5-5': 0.20 };

const MONTHS_KEPT = 12;

/** A zeroed usage record for `model`. */
export function emptyUsage(model = '') {
  return { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** Sum two usage records (model of `a` wins unless empty). Does not mutate. */
export function addUsage(a, b) {
  const x = a || emptyUsage();
  const y = b || emptyUsage();
  return {
    model: x.model || y.model || '',
    inputTokens: num(x.inputTokens) + num(y.inputTokens),
    outputTokens: num(x.outputTokens) + num(y.outputTokens),
    cacheReadTokens: num(x.cacheReadTokens) + num(y.cacheReadTokens),
    cacheWriteTokens: num(x.cacheWriteTokens) + num(y.cacheWriteTokens),
  };
}

/** Price entry for a model id; tolerates dated/suffixed ids like "claude-haiku-5-5-20261001". */
export function priceFor(model) {
  const key = priceKey(model);
  return key ? PRICES[key] : null;
}

/**
 * Cost of one request in USD. GPT, Gemini and other non-Claude models are not priced (0; the UI says so, see isPriced).
 * The long-context rate card (Claude Haiku 5.5 above 100K prompt tokens) is chosen by the TOTAL prompt size:
 * uncached input + cache reads + cache writes, and applies to every token of that request, output included.
 * A usage with `parts` (one entry per attempt, e.g. after a server-side refusal fallback) is the sum of its parts,
 * each priced at its own model's rates.
 * @param {Usage & { parts?: Usage[] }} usage
 */
export function costUsd(usage) {
  if (!usage) return 0;
  if (Array.isArray(usage.parts) && usage.parts.length) {
    return usage.parts.reduce((sum, p) => sum + costUsd({ requestedModel: usage.requestedModel, ...p }), 0);
  }
  const price = priceFor(usage.model) ?? claudeFallbackPrice(usage);
  if (!price) return 0;
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const cacheRead = num(usage.cacheReadTokens);
  const cacheWrite = num(usage.cacheWriteTokens);
  const promptTokens = input + cacheRead + cacheWrite;
  const isLong = Boolean(price.long) && promptTokens > price.long.threshold;
  const rates = isLong ? price.long : price;
  const cacheReadRate = isLong
    ? rates.input * CACHE_READ_FACTOR
    : price.cacheRead ?? CACHE_READ_OVERRIDES[priceKey(usage.model)] ?? rates.input * CACHE_READ_FACTOR;
  const cacheWriteRate = price.cacheWrite ?? rates.input * CACHE_WRITE_FACTOR;
  const usd = input * rates.input + output * rates.output + cacheRead * cacheReadRate + cacheWrite * cacheWriteRate;
  return usd / 1_000_000;
}

/** True when cost can be estimated for this model (Claude only: GPT, Gemini and unknown models are not priced). */
export function isPriced(model) {
  return Boolean(priceFor(model)) || /^claude-/.test(String(model || ''));
}

const warnedUnpriced = new Set();
// Known rates per Claude family, for newer models of that family (e.g. a new Haiku picked from the live model list).
const FAMILY_PRICE_KEYS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
/**
 * A Claude model missing from PRICES (e.g. a new fallback target) is priced at the requested model's rates, else at
 * its family's known rates, rather than booked as free.
 */
function claudeFallbackPrice(usage) {
  if (!/^claude-/.test(String(usage.model || ''))) return null;
  const familyKey = FAMILY_PRICE_KEYS[/^claude-(haiku|sonnet|opus)-/.exec(usage.model)?.[1]];
  const basis = priceFor(usage.requestedModel) ? usage.requestedModel : familyKey;
  const price = priceFor(basis);
  if (price && !warnedUnpriced.has(usage.model)) {
    warnedUnpriced.add(usage.model);
    console.warn('[ai] no price for', usage.model, '— estimating at', basis, 'rates');
  }
  return price;
}

/** "YYYY-MM" for a timestamp in local time. */
export function monthKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Add one request to this month's totals in localStorage and broadcast 'usage:change' on the bus.
 * @param {Usage} usage
 * @param {{ paperId?: string, task?: string }} [meta]
 */
export function recordUsage(usage, { paperId, task } = {}) {
  if (!usage) return;
  const usd = costUsd(usage);
  const store = loadStore();
  const key = monthKey();
  const month = (store.months[key] ||= emptyMonth());
  month.usd += usd;
  month.calls += 1;
  const parts = Array.isArray(usage.parts) && usage.parts.length ? usage.parts : [usage];
  for (const part of parts) {
    const model = part.model || 'unknown';
    const m = (month.byModel[model] ||= { usd: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    m.usd += costUsd({ requestedModel: usage.requestedModel, ...part });
    m.calls += 1;
    m.inputTokens += num(part.inputTokens);
    m.outputTokens += num(part.outputTokens);
    m.cacheReadTokens += num(part.cacheReadTokens);
    m.cacheWriteTokens += num(part.cacheWriteTokens);
  }
  const t = (month.byTask[task || 'other'] ||= { usd: 0, calls: 0 });
  t.usd += usd;
  t.calls += 1;
  if (paperId) {
    const p = (month.byPaper[paperId] ||= { usd: 0, calls: 0 });
    p.usd += usd;
    p.calls += 1;
  }
  pruneMonths(store);
  safeStorage.set(STORAGE_KEYS.usage, store);
  bus.emit('usage:change', { usage, usd, summary: usageSummary(key) });
}

/**
 * Totals for a month (default: the current one).
 * @returns {{ month: string, usd: number, calls: number, byModel: object, byTask: object, byPaper: object }}
 */
export function usageSummary(month = monthKey()) {
  const m = loadStore().months[month] || emptyMonth();
  return { month, usd: m.usd, calls: m.calls, byModel: m.byModel, byTask: m.byTask, byPaper: m.byPaper };
}

/** Forget all recorded usage on this device. */
export function clearUsage() {
  safeStorage.remove(STORAGE_KEYS.usage);
  bus.emit('usage:change', { usage: null, usd: 0, summary: usageSummary() });
}

function loadStore() {
  const raw = safeStorage.get(STORAGE_KEYS.usage, null);
  if (!raw || typeof raw !== 'object' || typeof raw.months !== 'object' || raw.months === null) {
    return { version: 1, months: {} };
  }
  for (const [k, m] of Object.entries(raw.months)) raw.months[k] = { ...emptyMonth(), ...m };
  return raw;
}

function emptyMonth() {
  return { usd: 0, calls: 0, byModel: {}, byTask: {}, byPaper: {} };
}

function pruneMonths(store) {
  const keys = Object.keys(store.months).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - MONTHS_KEPT))) delete store.months[k];
}

function priceKey(model) {
  if (!model) return null;
  if (PRICES[model]) return model;
  return Object.keys(PRICES).find((k) => model.startsWith(`${k}-`) || model.startsWith(`${k}@`)) || null;
}

function num(v) {
  return Number.isFinite(v) && v > 0 ? v : 0;
}
