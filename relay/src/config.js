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

/**
 * @typedef {{ allowedOrigins: string[], upstreamUrl: string, defaultModels: string[], defaultDailyLimitUsd: number,
 *             globalDailyLimitUsd: number, maxTokensCap: number, apiKey: string, adminToken: string,
 *             testMode: boolean }} RelayConfig
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
  };
}

function list(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function number(value, fallback, min, max) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
