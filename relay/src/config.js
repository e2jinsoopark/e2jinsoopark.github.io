// Worker configuration from wrangler vars and secrets, with safe defaults for missing or malformed values.

/** Models an invite code may be granted, in display order. */
export const KNOWN_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];

export const MODEL_NAMES = {
  'claude-haiku-5-5': 'Claude Haiku 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-opus-5-5': 'Claude Opus 5.5',
};

export const MAX_BODY_BYTES = 6 * 1024 * 1024;
export const MAX_ADMIN_BODY_BYTES = 64 * 1024;
export const MAX_CODE_DAILY_LIMIT_USD = 20;
export const MIN_ADMIN_TOKEN_LENGTH = 16;

/** Default size cap of a shared library (sum of the blob sizes in its head tree). */
export const DEFAULT_SHARED_MAX_BYTES = 4_000_000_000;
/** Default cap on the number of files in a shared library (stops filling the repo cheaply with tiny files). */
export const DEFAULT_SHARED_MAX_FILES = 50_000;
const LIBRARY_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * @typedef {{ id: string, name: string, repo: string, branch: string, maxBytes: number, maxFiles: number }} SharedLibrary
 * @typedef {{ allowedOrigins: string[], upstreamUrl: string, defaultModels: string[], defaultDailyLimitUsd: number,
 *             globalDailyLimitUsd: number, maxTokensCap: number, apiKey: string, adminToken: string,
 *             testMode: boolean, githubApiBase: string, teamToken: string,
 *             sharedLibraries: SharedLibrary[] }} RelayConfig
 */

/** @returns {RelayConfig} */
export function readConfig(env) {
  const defaultModels = list(env.DEFAULT_MODELS).filter((m) => KNOWN_MODELS.includes(m));
  return {
    allowedOrigins: list(env.ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, '')),
    upstreamUrl: String(env.UPSTREAM_URL || 'https://api.anthropic.com').trim().replace(/\/+$/, ''),
    defaultModels: defaultModels.length ? defaultModels : [KNOWN_MODELS[0]],
    defaultDailyLimitUsd: number(env.DEFAULT_DAILY_LIMIT_USD, 0.5, 0, MAX_CODE_DAILY_LIMIT_USD),
    globalDailyLimitUsd: number(env.GLOBAL_DAILY_LIMIT_USD, 5, 0, Number.MAX_SAFE_INTEGER),
    maxTokensCap: Math.floor(number(env.MAX_TOKENS_CAP, 32000, 1, Number.MAX_SAFE_INTEGER)),
    apiKey: String(env.ANTHROPIC_API_KEY || '').trim(),
    adminToken: String(env.ADMIN_TOKEN || '').trim(),
    testMode: env.TEST_MODE === '1',
    githubApiBase: String(env.GITHUB_API_BASE || 'https://api.github.com').trim().replace(/\/+$/, ''),
    teamToken: String(env.TEAM_GITHUB_TOKEN || '').trim(),
    sharedLibraries: parseSharedLibraries(env.SHARED_LIBRARIES),
  };
}

/**
 * SHARED_LIBRARIES: a JSON array (a string from `--var` / the dashboard, or an array from wrangler.jsonc) of
 * { id, name, repo: "owner/name", branch?, maxBytes? }. Malformed entries are skipped (and logged), ids are unique.
 * @returns {SharedLibrary[]}
 */
export function parseSharedLibraries(value) {
  let items = value;
  if (typeof value === 'string') {
    if (!value.trim()) return [];
    try {
      items = JSON.parse(value);
    } catch {
      console.error('[relay] SHARED_LIBRARIES is not valid JSON');
      return [];
    }
  }
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const item of items) {
    const id = String(item?.id ?? '');
    const repo = String(item?.repo ?? '');
    const branch = String(item?.branch ?? 'main') || 'main';
    const name = typeof item?.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 40) : '공용 서재';
    const maxBytes = number(item?.maxBytes, DEFAULT_SHARED_MAX_BYTES, 1, Number.MAX_SAFE_INTEGER);
    const maxFiles = Math.floor(number(item?.maxFiles, DEFAULT_SHARED_MAX_FILES, 1, Number.MAX_SAFE_INTEGER));
    if (!LIBRARY_ID_RE.test(id) || !REPO_RE.test(repo) || !BRANCH_RE.test(branch) || branch.includes('..')
      || out.some((l) => l.id === id)) {
      console.error('[relay] skipping a malformed SHARED_LIBRARIES entry', JSON.stringify(item));
      continue;
    }
    out.push({ id, name, repo, branch, maxBytes, maxFiles });
  }
  return out;
}

function list(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function number(value, fallback, min, max) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
