// Invite codes: generation, normalisation of what people type, and validation of admin input.
//
// Two kinds of code (docs/RELAY.md §4):
// - generated  "PR-XXXX-XXXX", Crockford base32, 40 random bits. Typed I/L/O are read as 1/1/0.
// - custom     chosen by the owner: 6–24 of A–Z, 0–9 and single hyphens ("EICU-2026"), stored in upper case with the
//              owner's hyphens. No letter is ever replaced (an O stays an O). The generated shape ("PR" + 8 letters or
//              digits once hyphens are dropped) is reserved for generated codes, so the O/I/L reading never touches a
//              custom code.
// Both are matched by their KEY: upper-case letters and digits only, hyphens and spaces ignored ("eicu 2026",
// "EICU2026" and "Eicu-2026" all open "EICU-2026"). No two codes may share a key (unique index in schema.sql).
import { KNOWN_MODELS, MAX_CODE_DAILY_LIMIT_USD } from './config.js';

// Crockford base32: no I, L, O or U. Typed I/L/O are read as 1/1/0 (normalizeCode).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_RE = /^PR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
export const CUSTOM_CODE_MIN = 6;
export const CUSTOM_CODE_MAX = 24;
const CUSTOM_RE = /^[0-9A-Z]+(?:-[0-9A-Z]+)*$/;
// Every dash look-alike a phone keyboard or a messenger may produce (same set as the app's js/ai/relay.js).
const DASHES = /[‐-―−﹘﹣－]/g;
/**
 * Words a custom code may not be (compared without hyphens): words of the app and the server, and the first words
 * a guesser tries. The app checks a shorter list before sending; the Worker has the final say.
 */
export const RESERVED_CODES = new Set([
  'ADMIN', 'ADMINS', 'ADMINISTRATOR', 'ROOT', 'SYSTEM', 'MASTER', 'RELAY', 'PAPERRELAY', 'SHARED', 'SHARE', 'JOIN',
  'INVITE', 'INVITES', 'INVITECODE', 'CODE', 'CODES', 'SETTINGS', 'LIBRARY', 'TEAM', 'GALPI', 'PAPER', 'PAPERS',
  'TEST', 'TESTS', 'TESTING', 'TESTER', 'DEMO', 'SAMPLE', 'EXAMPLE', 'GUEST', 'ANONYMOUS', 'USER', 'USERS', 'LOGIN',
  'SIGNIN', 'PUBLIC', 'PRIVATE', 'PASSWORD', 'PASSWD', 'SECRET', 'TOKEN', 'APIKEY', 'DEFAULT', 'NULL', 'UNDEFINED',
  'NONE', 'TRUE', 'FALSE', 'ANTHROPIC', 'CLAUDE', 'OPENAI', 'GEMINI', 'GITHUB', 'WELCOME', 'LETMEIN', 'HELLO',
]);
// Keyboard rows and counting runs: a code that is a piece of one of these is the second thing a guesser tries.
const RUNS = ['01234567890', '09876543210', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'ZYXWVUTSRQPONMLKJIHGFEDCBA', 'QWERTYUIOP',
  'ASDFGHJKL', 'ZXCVBNM'];
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
 * A fresh person salt for a new code (128 random bits, 32 hex characters; codes.person_salt). Mixed into the code's
 * personId (shared-paths.js personIdFor), so a custom code that is deleted and made again is a new person.
 */
export function newPersonSalt() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Canonical form of a typed or pasted GENERATED code ("pr abcd efgh", "PRABCDEFGH", "pr-abcd-efgh" → "PR-ABCD-EFGH"),
 * or '' when it cannot be one. For any code (custom ones too) use codeKey.
 */
export function normalizeCode(raw) {
  const compact = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (compact.length !== 10 || !compact.startsWith('PR')) return '';
  const body = compact.slice(2).replace(/O/g, '0').replace(/[IL]/g, '1');
  const code = `PR-${body.slice(0, 4)}-${body.slice(4)}`;
  return CODE_RE.test(code) ? code : '';
}

/** True for a generated code in its canonical form ("PR-XXXX-XXXX"). */
export function isGeneratedCode(code) {
  return CODE_RE.test(String(code || ''));
}

/** Upper case, ASCII (full-width letters and spaces from a Korean keyboard folded by NFKC), dash look-alikes as '-'. */
function fold(raw) {
  let s = String(raw ?? '');
  try { s = s.normalize('NFKC'); } catch { /* keep */ }
  return s.toUpperCase().replace(DASHES, '-').trim();
}

/** "PR" + 8 letters or digits once spaces and hyphens are dropped: the shape reserved for generated codes. */
function hasGeneratedShape(folded) {
  return /^PR[0-9A-Z]{8}$/.test(folded.replace(/[\s-]+/g, ''));
}

/**
 * The lookup key of a presented code (header, path segment or query value), or null when it cannot be a code.
 * - Generated shape → `{ key: 'PRXXXXXXXX', code: 'PR-XXXX-XXXX', generated: true }`: O/I/L read as 0/1/1 and anything
 *   that is not a letter or digit dropped, exactly as normalizeCode (and as before custom codes existed).
 * - Otherwise a custom code: only letters, digits, spaces and hyphens (or dash look-alikes) are allowed, and the key
 *   (its letters and digits) must be 4–24 long → `{ key, generated: false }`. No letter is replaced.
 * @returns {{ key: string, code?: string, generated: boolean } | null}
 */
export function codeKey(raw) {
  const folded = fold(raw);
  if (!folded) return null;
  const generated = normalizeCode(folded);
  if (generated) return { key: generated.replace(/-/g, ''), code: generated, generated: true };
  if (/^PR[0-9A-Z]{8}$/.test(folded.replace(/[^0-9A-Z]/g, ''))) return null; // generated shape, but not Crockford
  if (/[^0-9A-Z\s-]/.test(folded)) return null;
  const key = folded.replace(/[\s-]+/g, '');
  // The shortest custom code ("A-B-CD", 6 characters with its hyphens) has a 4-character key.
  return key.length >= 4 && key.length <= CUSTOM_CODE_MAX ? { key, generated: false } : null;
}

/**
 * Validate a code the owner chose (POST /relay/admin/codes `code`). NFKC first (full-width input from a Korean
 * keyboard works), upper case, spaces and runs of hyphens become one hyphen, leading and trailing hyphens dropped.
 * @returns {{ code: string } | { error: string }}
 */
export function validateCustomCode(raw) {
  if (typeof raw !== 'string') return { error: '코드(code)는 글자로 보내 주세요.' };
  const folded = fold(raw);
  if (/[^0-9A-Z\s-]/.test(folded)) return { error: '코드는 영문·숫자·하이픈(-)만 쓸 수 있습니다.' };
  if (hasGeneratedShape(folded)) {
    return { error: 'PR-XXXX-XXXX 모양은 자동으로 만드는 코드용입니다. 다른 모양으로 정해 주세요.' };
  }
  const code = folded.replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
  if (code.length < CUSTOM_CODE_MIN || code.length > CUSTOM_CODE_MAX || !CUSTOM_RE.test(code)) {
    return { error: `코드는 하이픈을 포함해 ${CUSTOM_CODE_MIN}~${CUSTOM_CODE_MAX}자로 정해 주세요(영문·숫자·하이픈).` };
  }
  const key = code.replace(/-/g, '');
  if (RESERVED_CODES.has(key)) return { error: '이 단어는 코드로 쓸 수 없습니다. 다른 코드를 정해 주세요.' };
  if (/^(.)\1+$/.test(key) || RUNS.some((run) => run.includes(key))) {
    return { error: '너무 쉬운 코드라 쓸 수 없습니다(같은 글자 반복이나 123456·ABCDEF·QWERTY 같은 순서). 다른 코드를 정해 주세요.' };
  }
  return { code };
}

/**
 * Validate a create (`partial` false) or update (`partial` true) body.
 * @param {any} body
 * @param {{ partial: boolean, defaults?: { allowedModels: string[], dailyLimitUsd: number } }} opts
 * @returns {{ value: { code?: string, name?: string, active?: boolean, allowedModels?: string[], dailyLimitUsd?: number } }
 *          | { error: string }}
 */
export function validateCodeInput(body, { partial, defaults }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '요청 본문은 JSON 객체여야 합니다.' };
  const value = {};
  if (body.code !== undefined) {
    if (partial) return { error: '초대 코드 자체는 바꿀 수 없습니다. 새 코드를 만들어 주세요.' };
    // Blank (or null) = a random PR-XXXX-XXXX, as before custom codes existed.
    if (body.code !== null && !(typeof body.code === 'string' && !body.code.trim())) {
      const chosen = validateCustomCode(body.code);
      if (chosen.error) return chosen;
      value.code = chosen.code;
    }
  }
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
