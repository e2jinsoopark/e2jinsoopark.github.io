// Pure-module tests for invite codes (src/codes.js: custom codes, person salts), personIds and code deletion
// (src/shared-paths.js) and the failed-attempt limiter (src/limiter.js).
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  codeKey, generateCode, isGeneratedCode, newPersonSalt, RESERVED_CODES, validateCodeInput, validateCustomCode,
} from '../src/codes.js';
import {
  activeFailures, clientKey, FAIL_WINDOW_MS, guessFingerprint, ipv6Prefix, retryAfterSeconds, tooManyAttempts, windowOpen,
} from '../src/limiter.js';
import {
  CODE_DELETE_MESSAGE, CODE_DELETE_SUMMARY, parseCommitLine, personFiles, personIdFor, personIdForRow,
  personIdsOfDeletedCode, QUIET_SUMMARIES,
} from '../src/shared-paths.js';

const defaults = { allowedModels: ['claude-haiku-5-5'], dailyLimitUsd: 0.5 };
/** The code rules as vectors, shared with the app's tests (tests/onboarding/run.mjs checks js/ai/relay.js on the same table). */
const VECTORS = JSON.parse(readFileSync(new URL('./code-vectors.json', import.meta.url), 'utf8'));
const withIp = (ip) => new Request('http://x/', ip === undefined ? {} : { headers: { 'cf-connecting-ip': ip } });

export const tests = [
  {
    name: 'shared code vectors (code-vectors.json, also checked against the app): presented codes, chosen codes, blank = random',
    fn: () => {
      const wrong = [];
      for (const v of VECTORS.presented.cases) {
        const got = codeKey(v.in);
        const want = v.kind === null ? null
          : { key: v.key, ...(v.kind === 'generated' ? { code: v.code } : {}), generated: v.kind === 'generated' };
        try { assert.deepEqual(got, want); } catch { wrong.push(`presented ${JSON.stringify(v.in)}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`); }
      }
      const patterns = VECTORS.chosen.refusalPatterns;
      for (const v of VECTORS.chosen.cases) {
        if (v.blank) {
          const r = validateCodeInput({ name: '팀', code: v.in }, { partial: false, defaults });
          if (!r.value || r.value.code !== undefined) wrong.push(`blank ${JSON.stringify(v.in)}: ${JSON.stringify(r)}`);
          continue;
        }
        const r = validateCustomCode(v.in);
        if (v.code !== undefined ? r.code !== v.code : !(r.error && r.error.includes(patterns[v.refused]))) {
          wrong.push(`chosen ${JSON.stringify(v.in)}: ${JSON.stringify(r)} (want ${v.code ?? v.refused})`);
        }
      }
      assert.deepEqual(wrong, []);
      return `${VECTORS.presented.cases.length} presented + ${VECTORS.chosen.cases.length} chosen vectors agree with relay/src/codes.js`;
    },
  },
  {
    name: 'custom code validation: 6–24 of A–Z/0–9/hyphen, upper case, spaces and dashes folded, full-width accepted',
    fn: () => {
      const ok = {
        'eicu-2026': 'EICU-2026',
        '  Ward 7B  ': 'WARD-7B',
        'icu--2--team': 'ICU-2-TEAM',
        '-snubh-eicu-': 'SNUBH-EICU',
        'ｅｉｃｕ　２ｔｅａｍ': 'EICU-2TEAM', // full-width letters, digits and space (Korean IME)
        'ICU–2TEAM': 'ICU-2TEAM', // en dash from a messenger
        'k-7-m3': 'K-7-M3', // the shortest shape: 6 characters with hyphens, a 4-character key
        'SOLO-ICU-L1': 'SOLO-ICU-L1', // O, I and L stay letters
        [`${'X'.repeat(11)}${'Y'.repeat(13)}`]: `${'X'.repeat(11)}${'Y'.repeat(13)}`, // 24
      };
      for (const [input, want] of Object.entries(ok)) {
        assert.deepEqual(validateCustomCode(input), { code: want }, input);
      }
      const bad = {
        ABCDE: /6~24자/, 'A-B-C': /6~24자/, [`${'X'.repeat(12)}-${'Y'.repeat(12)}`]: /6~24자/, '---': /6~24자/,
        EICU_2026: /영문·숫자·하이픈/, '간호팀2026': /영문·숫자·하이픈/, 'EICU.2026': /영문·숫자·하이픈/, 'EICU2026!': /영문·숫자·하이픈/,
        'PR-7K3M-Q9XD': /PR-XXXX-XXXX/, PRACTICE24: /PR-XXXX-XXXX/, 'pr ab2c d3ef': /PR-XXXX-XXXX/, 'PR-ABCU-0000': /PR-XXXX-XXXX/,
        admins: /이 단어/, 'Pass-Word': /이 단어/, 'T-E-AM': /이 단어/, 'A-B-CD': /너무 쉬운/,
        AAAAAA: /너무 쉬운/, '111-111': /너무 쉬운/, 123456: /너무 쉬운/, 'qwerty': /너무 쉬운/, 'ABCDEFG': /너무 쉬운/, '987654': /너무 쉬운/,
      };
      for (const [input, re] of Object.entries(bad)) {
        const r = validateCustomCode(input);
        assert.ok(r.error, `accepted ${input}`);
        assert.match(r.error, re, `${input}: ${r.error}`);
      }
      assert.match(validateCustomCode(123456).error, /글자로/);
      for (const w of RESERVED_CODES) assert.ok(validateCustomCode(`${w}`).error || w.length < 6, w);
      return `${Object.keys(ok).length} accepted (e.g. "ｅｉｃｕ　２ｔｅａｍ" → EICU-2TEAM), ${Object.keys(bad).length + 1} refused in Korean`;
    },
  },
  {
    name: 'create body: blank/null code → random; a chosen code is validated; PATCH may not change the code',
    fn: () => {
      for (const code of [undefined, null, '', '   ']) {
        const r = validateCodeInput({ name: '팀', code }, { partial: false, defaults });
        assert.ok(r.value, JSON.stringify(code));
        assert.equal(r.value.code, undefined, JSON.stringify(code));
      }
      assert.equal(validateCodeInput({ name: '팀', code: 'eicu-2026' }, { partial: false, defaults }).value.code, 'EICU-2026');
      assert.match(validateCodeInput({ name: '팀', code: 'abc' }, { partial: false, defaults }).error, /6~24자/);
      assert.match(validateCodeInput({ name: '팀', code: 42 }, { partial: false, defaults }).error, /글자로/);
      assert.match(validateCodeInput({ code: 'EICU-2026' }, { partial: true }).error, /바꿀 수 없습니다/);
      assert.match(validateCodeInput({ name: 'x', code: 'EICU-2026' }, { partial: true }).error, /바꿀 수 없습니다/);
      return 'blank → random; "eicu-2026" → EICU-2026; PATCH with code → 400';
    },
  },
  {
    name: 'lookup key: generated codes as before (O/I/L → 0/1/1), custom codes without hyphens and no letter replaced',
    fn: () => {
      const c = generateCode();
      assert.ok(isGeneratedCode(c));
      assert.deepEqual(codeKey(c), { key: c.replace(/-/g, ''), code: c, generated: true });
      assert.deepEqual(codeKey(' pr-ooil-0011 '), { key: 'PR00110011', code: 'PR-0011-0011', generated: true });
      assert.deepEqual(codeKey('코드: PR-AB2C-D3EF'), { key: 'PRAB2CD3EF', code: 'PR-AB2C-D3EF', generated: true }); // as before
      assert.equal(codeKey('PR-ABCU-0000'), null); // generated shape, U is not Crockford
      for (const typed of ['EICU-2026', 'eicu2026', ' Eicu 2026 ', 'E-I-C-U-2-0-2-6', 'ｅｉｃｕ－２０２６', 'eicu—2026']) {
        assert.deepEqual(codeKey(typed), { key: 'EICU2026', generated: false }, typed);
      }
      assert.deepEqual(codeKey('solo-icu-l1'), { key: 'SOLOICUL1', generated: false });
      assert.deepEqual(codeKey('s0l0-1cu-11'), { key: 'S0L01CU11', generated: false }); // a different code
      assert.deepEqual(codeKey('A-B-CD'), { key: 'ABCD', generated: false });
      for (const no of ['', '   ', 'abc', 'X'.repeat(25), 'EICU_2026', '간호팀', 'EICU.2026', 'PR-%E0%A4%A']) {
        assert.equal(codeKey(no), null, no);
      }
      return `generated ${c} → ${c.replace(/-/g, '')}; 6 spellings → EICU2026; s0l0 ≠ solo; 8 non-codes → null`;
    },
  },
  {
    name: 'personId of a custom code is keyed on the stored code; a generated code\'s personId is unchanged',
    fn: async () => {
      const a = await personIdFor('EICU-2026', 'secret');
      const b = await personIdFor('EICU-2026', 'secret');
      assert.equal(a, b);
      assert.match(a, /^[0-9a-f]{16}$/);
      assert.notEqual(a, await personIdFor('EICU2026', 'secret'), 'the stored form (with its hyphens) is what is keyed');
      return `HMAC("EICU-2026") = ${a}`;
    },
  },
  {
    name: 'limiter: client key = CF-Connecting-IP, IPv6 cut to /64, IPv4-mapped as IPv4',
    fn: () => {
      assert.equal(clientKey(withIp('203.0.113.7')), '203.0.113.7');
      assert.equal(clientKey(withIp(undefined)), 'unknown');
      assert.equal(clientKey(withIp('2001:db8:1:2::abcd')), '2001:0db8:0001:0002::/64');
      assert.equal(clientKey(withIp('2001:DB8:1:2:ffff:1:2:3')), '2001:0db8:0001:0002::/64');
      assert.equal(clientKey(withIp('::ffff:198.51.100.7')), '198.51.100.7');
      assert.equal(ipv6Prefix('::1'), '0000:0000:0000:0000::/64');
      assert.equal(ipv6Prefix('1:2:3:4:5:6:7:8:9'), null);
      assert.equal(ipv6Prefix('1::2::3'), null);
      assert.equal(ipv6Prefix('fe80::1%eth0'), 'fe80:0000:0000:0000::/64');
      assert.equal(clientKey(withIp('zz::1')), 'zz::1'); // malformed: kept as given
      return 'IPv4 as is; 2001:db8:1:2::abcd and 2001:db8:1:2:ffff:1:2:3 share 2001:0db8:0001:0002::/64';
    },
  },
  {
    name: 'limiter: window arithmetic, fingerprints, and the 429 shape',
    fn: async () => {
      const t = Date.parse('2031-01-01T00:00:00Z');
      assert.ok(windowOpen(t, t) && windowOpen(t, t + FAIL_WINDOW_MS - 1));
      assert.ok(!windowOpen(t, t + FAIL_WINDOW_MS));
      assert.ok(!windowOpen(t + 2 * 60_000, t), 'a window starting in the future (clock moved back) is over');
      assert.ok(windowOpen(t + 30_000, t), 'small clock skew between machines is tolerated');
      assert.equal(activeFailures(7, t, t + 1000), 7);
      assert.equal(activeFailures(7, t, t + FAIL_WINDOW_MS), 0);
      assert.equal(activeFailures(null, null, t), 0);
      assert.equal(retryAfterSeconds(t, t), 600);
      assert.equal(retryAfterSeconds(t, t + FAIL_WINDOW_MS - 1), 1);
      const f = await guessFingerprint('code', 'EICU2026');
      assert.match(f, /^[0-9a-f]{16}$/);
      assert.equal(f, await guessFingerprint('code', 'EICU2026'));
      assert.notEqual(f, await guessFingerprint('admin', 'EICU2026'));
      const res = tooManyAttempts(42);
      assert.equal(res.status, 429);
      assert.equal(res.headers.get('x-should-retry'), 'false');
      assert.equal(res.headers.get('retry-after'), '42');
      const body = await res.json();
      assert.equal(body.error.type, 'rate_limit_error');
      assert.match(body.error.message, /잠시 후 다시 시도해 주세요/);
      return `window 10 min from the first failure; 429 "${body.error.message}" retry-after 42`;
    },
  },
  {
    name: 'person salt: personId = HMAC(secret, code + LF + salt)[0:16] (SHA-256 without a secret); no salt → the old personId',
    fn: async () => {
      const salt = newPersonSalt();
      assert.match(salt, /^[0-9a-f]{32}$/, '128 random bits as hex');
      assert.notEqual(newPersonSalt(), salt);
      const hmac = (text) => createHmac('sha256', 's3cret').update(text).digest('hex').slice(0, 16);
      const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
      assert.equal(await personIdFor('EICU-2026', 's3cret', salt), hmac(`EICU-2026\n${salt}`));
      assert.equal(await personIdFor('EICU-2026', '', salt), sha(`EICU-2026\n${salt}`));
      // A code from before salts (person_salt NULL, or a database without the column) keeps its personId.
      for (const row of [{ code: 'PR-ABCD-EFGH' }, { code: 'PR-ABCD-EFGH', person_salt: null }, { code: 'PR-ABCD-EFGH', person_salt: '' }]) {
        assert.equal(await personIdForRow(row, 's3cret'), hmac('PR-ABCD-EFGH'));
        assert.equal(await personIdForRow(row, ''), sha('PR-ABCD-EFGH'));
      }
      assert.equal(await personIdForRow({ code: 'EICU-2026', person_salt: salt }, 's3cret'), hmac(`EICU-2026\n${salt}`));
      // The same custom code made again (new salt) is another person.
      assert.notEqual(await personIdForRow({ code: 'EICU-2026', person_salt: newPersonSalt() }, 's3cret'), hmac(`EICU-2026\n${salt}`));
      return `salt ${salt.slice(0, 8)}…: HMAC ${hmac(`EICU-2026\n${salt}`)}; legacy PR-ABCD-EFGH keeps ${hmac('PR-ABCD-EFGH')}`;
    },
  },
  {
    name: 'code deletion: person ids to clean (a legacy code with a secret also its plain SHA-256 folder) and only people/<id>/ files',
    fn: async () => {
      const salt = newPersonSalt();
      const hmac = (text) => createHmac('sha256', 'k').update(text).digest('hex').slice(0, 16);
      const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
      assert.deepEqual(await personIdsOfDeletedCode({ code: 'PR-ABCD-EFGH', person_salt: null }, 'k'), [hmac('PR-ABCD-EFGH'), sha('PR-ABCD-EFGH')]);
      assert.deepEqual(await personIdsOfDeletedCode({ code: 'PR-ABCD-EFGH' }, ''), [sha('PR-ABCD-EFGH')]);
      assert.deepEqual(await personIdsOfDeletedCode({ code: 'EICU-2026', person_salt: salt }, 'k'), [hmac(`EICU-2026\n${salt}`)]);
      const me = 'a1b2c3d4e5f60718';
      const paths = [
        'library.json', 'README.md', 'papers/p1/paper.pdf', 'papers/p1/translation.json',
        `people/${me}/papers/p1/annotations.json`, `people/${me}/papers/p2/ai.json`, `people/${me}/notes.txt`,
        'people/0f1e2d3c4b5a6978/papers/p1/annotations.json', `people/${me}0/papers/p1/ai.json`, `people/${me}`,
        `papers/people/${me}/x.json`,
      ];
      assert.deepEqual(personFiles(paths, [me]), [
        `people/${me}/papers/p1/annotations.json`, `people/${me}/papers/p2/ai.json`, `people/${me}/notes.txt`,
      ]);
      assert.deepEqual(personFiles(paths, ['../..', '']), [], 'only 16-hex person ids are ever matched');
      const line = parseCommitLine(CODE_DELETE_MESSAGE);
      assert.deepEqual(line, { who: '관리자', summary: CODE_DELETE_SUMMARY });
      assert.ok(!QUIET_SUMMARIES.has(line.summary), 'the app shows it in 최근 활동 (not one of the hidden summaries)');
      assert.ok(!/[0-9a-f]{16}/.test(CODE_DELETE_MESSAGE));
      return `legacy+secret → 2 ids; salted → 1; ${personFiles(paths, [me]).length} of ${paths.length} paths; activity "${line.who}: ${line.summary}"`;
    },
  },
];
