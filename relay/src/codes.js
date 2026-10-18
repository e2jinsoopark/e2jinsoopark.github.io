// Invite codes: generation, normalisation of what people type, and validation of admin input.
import { KNOWN_MODELS, MAX_CODE_DAILY_LIMIT_USD } from './config.js';

// Crockford base32: no I, L, O or U. Typed I/L/O are read as 1/1/0 (normalizeCode).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_RE = /^PR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const NAME_MAX = 40;
// U+FFFD (what a non-UTF-8 body decodes to) and lone surrogates (from "\ud800" escapes): text that cannot be shown.
const BROKEN_TEXT = /\uFFFD|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

/** A fresh code "PR-XXXX-XXXX" (40 random bits; 256 is a multiple of 32, so `byte & 31` is unbiased). */
export function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
  return `PR-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/**
 * Canonical form of a typed or pasted code ("pr abcd efgh", "PRABCDEFGH", "pr-abcd-efgh" → "PR-ABCD-EFGH"),
 * or '' when it cannot be a code.
 */
export function normalizeCode(raw) {
  const compact = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (compact.length !== 10 || !compact.startsWith('PR')) return '';
  const body = compact.slice(2).replace(/O/g, '0').replace(/[IL]/g, '1');
  const code = `PR-${body.slice(0, 4)}-${body.slice(4)}`;
  return CODE_RE.test(code) ? code : '';
}

/**
 * Validate a create (`partial` false) or update (`partial` true) body.
 * @param {any} body
 * @param {{ partial: boolean, defaults?: { allowedModels: string[], dailyLimitUsd: number } }} opts
 * @returns {{ value: { name?: string, active?: boolean, allowedModels?: string[], dailyLimitUsd?: number } }
 *          | { error: string }}
 */
export function validateCodeInput(body, { partial, defaults }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '요청 본문은 JSON 객체여야 합니다.' };
  const value = {};
  if (body.name !== undefined || !partial) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const length = [...name].length;
    if (length < 1 || length > NAME_MAX) return { error: `이름(name)은 1~${NAME_MAX}자로 입력해 주세요.` };
    if (BROKEN_TEXT.test(name)) {
      return { error: '이름(name)에 깨진 글자(�)가 있습니다. 보내는 쪽의 인코딩이 UTF-8이 아니었을 수 있습니다. UTF-8로 다시 입력해 주세요.' };
    }
    if (CONTROL_CHARS.test(name)) return { error: '이름(name)에 줄바꿈이나 제어 문자를 넣을 수 없습니다.' };
    value.name = name;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') return { error: '사용 여부(active)는 true 또는 false여야 합니다.' };
    value.active = body.active;
  }
  if (body.allowedModels !== undefined) {
    const models = body.allowedModels;
    if (!Array.isArray(models) || !models.length || !models.every((m) => KNOWN_MODELS.includes(m))) {
      return { error: `허용 모델(allowedModels)은 ${KNOWN_MODELS.join(', ')} 중에서 하나 이상 골라야 합니다.` };
    }
    value.allowedModels = KNOWN_MODELS.filter((m) => models.includes(m));
  } else if (!partial) {
    value.allowedModels = [...defaults.allowedModels];
  }
  if (body.dailyLimitUsd !== undefined) {
    const limit = body.dailyLimitUsd;
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0 || limit > MAX_CODE_DAILY_LIMIT_USD) {
      return { error: `하루 한도(dailyLimitUsd)는 0~${MAX_CODE_DAILY_LIMIT_USD} 사이의 숫자(달러)여야 합니다.` };
    }
    value.dailyLimitUsd = limit;
  } else if (!partial) {
    value.dailyLimitUsd = defaults.dailyLimitUsd;
  }
  if (partial && !Object.keys(value).length) {
    return { error: '바꿀 항목(name, active, allowedModels, dailyLimitUsd)이 없습니다.' };
  }
  return { value };
}
