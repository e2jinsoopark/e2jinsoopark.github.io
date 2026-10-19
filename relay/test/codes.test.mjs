// HTTP tests of custom invite codes and the failed-attempt limiter against `wrangler dev` (local D1, TEST_MODE=1).
// Each limiter test uses its own client IPs (CF-Connecting-IP, which wrangler dev passes through as sent) and pins its
// own clock (x-relay-test-now), so tests do not share a window with each other or with the other suites.
import assert from 'node:assert/strict';
import { call, newCode, personIdOf, saltOf, sendMessage, waitForRequests } from './lib.mjs';
import { personIdFor } from '../src/shared-paths.js';

const BAD_CODE = '초대 코드가 올바르지 않거나 사용이 중지되었습니다.';
const PROXY_REF = '/shared/team/gh/repos/team/library/git/ref/heads/main';
const T = (iso) => Date.parse(iso);

/** Anthropic error shape with the given status/type; returns the message. */
function assertError(res, status, type) {
  assert.equal(res.status, status, `status ${res.status}: ${res.text}`);
  assert.equal(res.json?.type, 'error', res.text);
  assert.equal(res.json.error?.type, type, res.text);
  assert.match(res.json.error.message, /[가-힣]/);
  return res.json.error.message;
}

/** The limiter's 429: rate_limit_error, Korean "잠시 후 다시 시도해 주세요", no retries, retry-after in seconds. */
function assertLimited(res) {
  const message = assertError(res, 429, 'rate_limit_error');
  assert.match(message, /잠시 후 다시 시도해 주세요/);
  assert.equal(res.headers.get('x-should-retry'), 'false');
  const after = Number(res.headers.get('retry-after'));
  assert.ok(Number.isInteger(after) && after >= 1 && after <= 600, `retry-after ${res.headers.get('retry-after')}`);
  return { message, after };
}

const me = (code, { ip, now, bearer = false } = {}) => call('/relay/me', bearer
  ? { headers: { authorization: `Bearer ${code}` }, ip, now }
  : { code, ip, now });
const shared = (path, code, { ip, now } = {}) => call(path, { headers: code ? { authorization: `Bearer ${code}` } : {}, ip, now });
const create = (body) => call('/relay/admin/codes', { method: 'POST', admin: true, body: { name: '팀', ...body } });
const listCodes = async () => (await call('/relay/admin/codes', { admin: true })).json.codes;

/** `count` failed lookups from `ip` with distinct wrong codes; each must be 401. `at(i)` → test clock. */
async function failMany(count, { ip, at, tag, via = (code, opts) => me(code, opts) }) {
  for (let i = 0; i < count; i++) {
    const res = await via(`MISS-${tag}-${String(i).padStart(3, '0')}`, { ip, now: at(i) });
    assert.equal(res.status, 401, `failure ${i + 1} from ${ip}: ${res.status} ${res.text}`);
  }
}

export const tests = [
  {
    name: 'custom code create: stored upper case with its hyphens; blank / null / spaces → a random PR-XXXX-XXXX',
    fn: async () => {
      const now = '2031-01-02T09:00:00+09:00';
      const res = await call('/relay/admin/codes', { method: 'POST', admin: true, now, body: { name: 'EICU2 팀', code: ' eicu2-team ' } });
      assert.equal(res.status, 201, res.text);
      assert.deepEqual(res.json, {
        code: 'EICU2-TEAM', name: 'EICU2 팀', active: true, allowedModels: ['claude-haiku-5-5'], dailyLimitUsd: 0.5,
        createdAt: new Date(T(now)).toISOString(), lastUsedAt: null, todayUsd: 0, monthUsd: 0, totalUsd: 0, totalRequests: 0,
      });
      const full = await create({ code: 'ｎｉｇｈｔ　ｓｈｉｆｔ' }); // full-width letters and space from a Korean keyboard
      assert.equal(full.json?.code, 'NIGHT-SHIFT', full.text);
      const random = [];
      for (const code of ['', '   ', null]) {
        const r = await create({ code });
        assert.equal(r.status, 201, r.text);
        assert.match(r.json.code, /^PR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
        random.push(r.json.code);
      }
      const codes = (await listCodes()).map((c) => c.code);
      assert.ok(codes.includes('EICU2-TEAM') && codes.includes('NIGHT-SHIFT'));
      return `" eicu2-team " → EICU2-TEAM, full-width → NIGHT-SHIFT; blank/spaces/null → ${random.join(', ')}`;
    },
  },
  {
    name: 'custom code create: too short / too long / bad characters / PR shape / reserved / too easy → 400 in Korean; nothing created',
    fn: async () => {
      const before = (await listCodes()).length;
      const bad = ['ABCDE', 'A-B-C', `${'K'.repeat(12)}-${'M'.repeat(12)}`, 'EICU_2026', '간호팀2026', 'EICU.2026', 'PR-7K3M-Q9XD',
        'practice24', 'pr ab2c d3ef', 'password', 'ad-mins', 'Ward/7B', '123456', 'aaaaaa', 'qwerty', 123456, ['EICU-2026']];
      const seen = [];
      for (const code of bad) {
        const message = assertError(await create({ code }), 400, 'invalid_request_error');
        seen.push(`${JSON.stringify(code)} → ${message}`);
      }
      assert.equal((await listCodes()).length, before, 'no code was created');
      return `${bad.length} refused, e.g. ${seen[0]}; ${seen[6]}; ${seen[9]}; ${seen[12]}`;
    },
  },
  {
    name: 'custom code create: the same code in any case or hyphenation → 409; PATCH cannot change a code',
    fn: async () => {
      const first = await create({ code: 'WARD-7B-TEAM', name: '7B 병동' });
      assert.equal(first.status, 201, first.text);
      const variants = ['ward-7b-team', 'WARD7BTEAM', 'ward 7b team', 'W-A-R-D-7B-TEAM', 'Ward7b-Team'];
      let message = '';
      for (const code of variants) {
        message = assertError(await create({ code }), 409, 'invalid_request_error');
        assert.match(message, /이미 있는 코드/);
      }
      const same = (await listCodes()).filter((c) => c.code.replace(/-/g, '') === 'WARD7BTEAM');
      assert.deepEqual(same.map((c) => [c.code, c.name]), [['WARD-7B-TEAM', '7B 병동']]);
      const patch = await call('/relay/admin/codes/WARD-7B-TEAM', { method: 'PATCH', admin: true, body: { code: 'WARD-7C-TEAM' } });
      assert.match(assertError(patch, 400, 'invalid_request_error'), /바꿀 수 없습니다/);
      return `${variants.length} spellings of WARD-7B-TEAM → 409 "${message}"; PATCH {code} → 400`;
    },
  },
  {
    name: 'custom code lookups: any case, spaces or hyphens on /relay/me, /v1/models, /v1/messages; usage booked on the stored code; O stays O',
    fn: async () => {
      const now = '2031-01-03T10:00:00+09:00';
      const { code } = await newCode({ name: '솔로 ICU', code: 'Solo-ICU-L1', allowedModels: ['claude-haiku-5-5'] });
      assert.equal(code, 'SOLO-ICU-L1');
      // Headers carry Latin-1 only (fetch refuses full-width text there); full-width spellings are tested on the URL below.
      const spellings = ['solo-icu-l1', 'SOLOICUL1', ' solo icu l1 ', 'S-O-L-O-I-C-U-L-1', 'Solo-Icu-L1'];
      for (const typed of spellings) {
        const res = await me(typed, { now });
        assert.equal(res.status, 200, `${typed}: ${res.text}`);
        assert.equal(res.json.name, '솔로 ICU');
      }
      assert.equal((await me('solo-icu-l1', { bearer: true, now })).status, 200, 'Bearer');
      const models = await call('/v1/models', { code: 'soloicul1', now });
      assert.deepEqual(models.json?.data?.map((m) => m.id), ['claude-haiku-5-5'], models.text);
      const sent = await sendMessage({ code: 'solo icu l1', now });
      assert.equal(sent.status, 200, sent.text);
      const day = await waitForRequests(code, 1, { now });
      assert.equal(day.requests, 1);
      for (const typed of ['solo icu l1', 'ＳＯＬＯ－ＩＣＵ－Ｌ１', 'solo–icu–l1']) {
        const byOther = await call(`/relay/admin/usage?days=1&code=${encodeURIComponent(typed)}`, { admin: true, now });
        assert.equal(byOther.json?.days?.[0]?.requests, 1, `${typed}: ${byOther.text}`);
      }
      const patched = await call(`/relay/admin/codes/${encodeURIComponent('ｓｏｌｏｉｃｕｌ１')}`, { method: 'PATCH', admin: true, now, body: { dailyLimitUsd: 1 } });
      assert.deepEqual([patched.status, patched.json?.code, patched.json?.dailyLimitUsd], [200, 'SOLO-ICU-L1', 1], patched.text);
      // No O/I/L reading for custom codes: zeros and ones are a different code.
      const digits = await me('s0l0-1cu-11', { ip: '203.0.113.90', now });
      assert.equal(assertError(digits, 401, 'authentication_error'), BAD_CODE);
      return `${spellings.length} spellings + Bearer → 200; usage on ${code} (filter by "solo icu l1", full-width, en dash); PATCH by full-width ｓｏｌｏｉｃｕｌ１; s0l0-1cu-11 → 401`;
    },
  },
  {
    name: 'personId of a custom code: every spelling gives SHA-256(stored code, its person salt)[0:16] on GET /shared; a generated code likewise',
    fn: async () => {
      const { code } = await newCode({ name: '야간 근무조', code: 'night-shift-5' });
      const salt = await saltOf('NIGHT-SHIFT-5');
      assert.match(salt, /^[0-9a-f]{32}$/, 'a new code has a 128-bit person salt');
      const want = await personIdFor('NIGHT-SHIFT-5', '', salt);
      assert.equal(want, personIdOf('NIGHT-SHIFT-5', salt), 'the Worker\'s derivation = SHA-256("NIGHT-SHIFT-5\\n" + salt)');
      const ids = new Set();
      for (const typed of ['NIGHT-SHIFT-5', 'nightshift5', 'night shift 5']) {
        const res = await shared('/shared', typed);
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json.name, '야간 근무조');
        ids.add(res.json.personId);
      }
      assert.deepEqual([...ids], [want]);
      const gen = await newCode({ name: '개인' });
      const genSalt = await saltOf(gen.code);
      assert.match(genSalt, /^[0-9a-f]{32}$/);
      assert.notEqual(genSalt, salt);
      const genRes = await shared('/shared', gen.code.toLowerCase());
      assert.equal(genRes.json?.personId, personIdOf(gen.code, genSalt), genRes.text);
      return `${code}: personId ${want} for 3 spellings (salt ${salt.slice(0, 6)}…); ${gen.code}: ${genRes.json.personId}`;
    },
  },
  {
    name: 'limiter: 20 failed lookups from one IP → 401 each; the 21st → 429 rate_limit_error, x-should-retry false, retry-after; nothing forwarded',
    fn: async ({ fake }) => {
      const ip = '203.0.113.10';
      const t0 = T('2031-02-01T00:00:00Z');
      const mark = fake.requests.length;
      await failMany(20, { ip, at: (i) => String(t0 + i * 1000), tag: 'A', via: (code, opts) => sendMessage({ code, now: opts.now, headers: { 'cf-connecting-ip': opts.ip } }) });
      const limited = await sendMessage({ code: 'MISS-A-020', now: String(t0 + 21_000), headers: { 'cf-connecting-ip': ip } });
      const { message, after } = assertLimited(limited);
      assert.equal(after, 579, 'retry-after = seconds until 10 min after the first failure');
      assert.equal(fake.requests.length, mark, 'nothing reached the upstream');
      return `20 × 401, then 429 "${message}" retry-after ${after}s; upstream untouched`;
    },
  },
  {
    name: 'limiter: a burst of 60 parallel guesses gets exactly 20 answers (401) and 40 refusals (429); 30 parallel admin guesses → 10 + 20',
    fn: async () => {
      const ip = '203.0.113.15';
      const now = String(T('2031-02-01T12:00:00Z'));
      const custom = (await newCode({ name: '동시 시도', code: 'BURST-TEAM-1' })).code;
      const burst = await Promise.all(Array.from({ length: 60 }, (_, i) => me(`BURST-MISS-${i}`, { ip, now })));
      const codes = burst.map((r) => r.status);
      assert.deepEqual([codes.filter((s) => s === 401).length, codes.filter((s) => s === 429).length], [20, 40], codes.join(','));
      assertLimited(await me(custom, { ip, now }));
      const adminIp = '203.0.113.16';
      const admin = await Promise.all(Array.from({ length: 30 }, (_, i) => call('/relay/admin/codes', {
        admin: `burst-admin-guess-${i}-0123456789`, ip: adminIp, now,
      })));
      const a = admin.map((r) => r.status);
      assert.deepEqual([a.filter((s) => s === 401).length, a.filter((s) => s === 429).length], [10, 20], a.join(','));
      assertLimited(await call('/relay/admin/codes', { admin: true, ip: adminIp, now }));
      return '60 concurrent wrong codes → 20 × 401 + 40 × 429, then the real custom code → 429; 30 concurrent admin guesses → 10 × 401 + 20 × 429';
    },
  },
  {
    name: 'limiter: successes never count or reset it; while blocked a generated code still works, a custom or disabled code gets 429, no code → 401',
    fn: async () => {
      const ip = '198.51.100.20';
      const t0 = T('2031-02-02T00:00:00Z');
      const gen = (await newCode({ name: '개인 코드' })).code;
      const custom = (await newCode({ name: '팀 코드', code: 'LIMIT-TEAM-7' })).code;
      const off = (await newCode({ name: '중지 코드', code: 'GONE-TEAM-7' })).code;
      assert.equal((await call(`/relay/admin/codes/${off}`, { method: 'PATCH', admin: true, body: { active: false } })).status, 200);
      for (let i = 0; i < 20; i++) {
        const now = String(t0 + i * 2000);
        assert.equal((await me(gen, { ip, now })).status, 200);
        assert.equal((await me(custom, { ip, now })).status, 200);
        assert.equal((await me(`MISS-B-${i}`, { ip, now })).status, 401, `failure ${i + 1}`);
      }
      // Every success above sat between failures and changed nothing: the 20 failures are all still counted, so the
      // IP is now at the limit and the next lookup that is not a valid generated code is refused.
      const now = String(t0 + 60_000);
      assertLimited(await me('MISS-B-20', { ip, now }));
      const genMe = await me(gen, { ip, now });
      assert.equal(genMe.status, 200, `generated code from the blocked IP: ${genMe.text}`);
      const genMsg = await sendMessage({ code: gen, now, headers: { 'cf-connecting-ip': ip } });
      assert.equal(genMsg.status, 200, genMsg.text);
      assertLimited(await me(custom, { ip, now }));
      assertLimited(await me(custom, { ip, now, bearer: true }));
      assertLimited(await me(off, { ip, now }));
      assertLimited(await me(gen.replace(/.$/, (c) => (c === '0' ? '1' : '0')), { ip, now })); // a wrong generated code
      const none = await call('/relay/me', { ip, now });
      assert.match(assertError(none, 401, 'authentication_error'), /초대 코드가 없습니다/);
      return `40 successes interleaved with 20 failures → not blocked; 21st → 429; then ${gen} → 200 (/relay/me, /v1/messages), `
        + `${custom} / ${off} / wrong PR → 429; no code → 401`;
    },
  },
  {
    name: 'limiter: other IPs are unaffected; an IPv6 address counts as its /64',
    fn: async () => {
      const t0 = T('2031-02-03T00:00:00Z');
      const at = (i) => String(t0 + i * 1000);
      const custom = (await newCode({ name: '다른 IP', code: 'OTHER-NET-3' })).code;
      await failMany(20, { ip: '203.0.113.30', at, tag: 'C' });
      assertLimited(await me('MISS-C-020', { ip: '203.0.113.30', now: at(21) }));
      assert.equal((await me(custom, { ip: '203.0.113.31', now: at(22) })).status, 200);
      assert.equal((await me('MISS-C-021', { ip: '203.0.113.31', now: at(22) })).status, 401);
      for (let i = 0; i < 20; i++) {
        const res = await me(`MISS-V6-${i}`, { ip: `2001:db8:aa:1::${(i + 1).toString(16)}`, now: at(i) });
        assert.equal(res.status, 401, `v6 failure ${i + 1}`);
      }
      assertLimited(await me(custom, { ip: '2001:db8:aa:1:ffff:ffff:ffff:fffe', now: at(21) }));
      assert.equal((await me(custom, { ip: '2001:db8:aa:2::1', now: at(21) })).status, 200, 'the next /64 is someone else');
      assert.equal((await me('MISS-V6-X', { ip: '2001:db8:aa:2::1', now: at(21) })).status, 401);
      return '203.0.113.30 blocked, .31 fine; 20 failures spread over 2001:db8:aa:1::/64 block the whole /64, 2001:db8:aa:2::/64 fine';
    },
  },
  {
    name: 'limiter: resets when the 10-minute window ends (test clock); retry-after counts down',
    fn: async () => {
      const ip = '203.0.113.40';
      const t0 = T('2031-02-04T00:00:00Z');
      const custom = (await newCode({ name: '창 초기화', code: 'WINDOW-TEAM-4' })).code;
      await failMany(20, { ip, at: (i) => String(t0 + i * 1000), tag: 'D' });
      const a = assertLimited(await me(custom, { ip, now: String(t0 + 20_000) }));
      const b = assertLimited(await me(custom, { ip, now: String(t0 + 599_000) }));
      assert.deepEqual([a.after, b.after], [580, 1]);
      assert.equal((await me(custom, { ip, now: String(t0 + 600_000) })).status, 200, 'window over');
      // A new window starts with the next failure and allows 20 again.
      await failMany(20, { ip, at: (i) => String(t0 + 600_000 + i * 1000), tag: 'D2' });
      const c = assertLimited(await me(custom, { ip, now: String(t0 + 625_000) }));
      assert.equal(c.after, 575);
      return `retry-after ${a.after}s → ${b.after}s; at +10:00 the code works; a new window blocks again after 20 (retry-after ${c.after}s)`;
    },
  },
  {
    name: 'limiter: the same wrong code repeated counts once (a stuck client); a disabled code is refused (401) but never counted',
    fn: async () => {
      const t0 = T('2031-02-05T00:00:00Z');
      const now = (i) => String(t0 + i * 500);
      const off = (await newCode({ name: '꺼진 코드', code: 'STALE-TEAM-5' })).code;
      await call(`/relay/admin/codes/${off}`, { method: 'PATCH', admin: true, body: { active: false } });
      const ip = '203.0.113.50';
      let n = 0;
      for (let i = 0; i < 30; i++) assert.equal((await me('SAME-WRONG-1', { ip, now: now(n++) })).status, 401);
      for (let i = 0; i < 30; i++) {
        const res = await me(off, { ip, now: now(n++) });
        assert.equal(assertError(res, 401, 'authentication_error'), BAD_CODE);
      }
      await failMany(19, { ip, at: () => now(n++), tag: 'E' });
      assertLimited(await me('MISS-E-019', { ip, now: now(n++) }));
      // Alternating two wrong codes is not "the same again": every one counts.
      const ip2 = '203.0.113.51';
      for (let i = 0; i < 20; i++) assert.equal((await me(i % 2 ? 'ALT-WRONG-B' : 'ALT-WRONG-A', { ip: ip2, now: now(i) })).status, 401);
      assertLimited(await me('ALT-WRONG-A', { ip: ip2, now: now(21) }));
      return '30 × the same wrong code + 30 × a disabled code + 19 others = 20 counted → 21st 429; A/B alternating: 20 counted';
    },
  },
  {
    name: 'limiter protects /shared, /shared/<lib>/activity and the GitHub proxy (GitHub-shaped 429) with the same counter; nothing reaches GitHub',
    fn: async ({ gh, fake }) => {
      const ip = '203.0.113.60';
      const t0 = T('2031-02-06T00:00:00Z');
      const at = (i) => String(t0 + i * 1000);
      const gen = (await newCode({ name: '서재 개인' })).code;
      const custom = (await newCode({ name: '서재 팀', code: 'SHELF-TEAM-6' })).code;
      const mark = gh.log.length;
      const upstreamMark = fake.requests.length;
      await failMany(7, { ip, at, tag: 'S1', via: (code, o) => shared('/shared', code, o) });
      await failMany(7, { ip, at: (i) => at(7 + i), tag: 'S2', via: (code, o) => shared('/shared/team/activity', code, o) });
      for (let i = 0; i < 6; i++) {
        const res = await shared(PROXY_REF, `MISS-S3-${i}`, { ip, now: at(14 + i) });
        assert.equal(res.status, 401, res.text);
        assert.equal(typeof res.json?.documentation_url, 'string', 'GitHub error shape');
      }
      assertLimited(await sendMessage({ code: 'MISS-S4-0', now: at(21), headers: { 'cf-connecting-ip': ip } }));
      assertLimited(await shared('/shared', custom, { ip, now: at(22) }));
      assertLimited(await shared('/shared/team/activity', 'MISS-S4-1', { ip, now: at(22) }));
      const proxied = await shared(PROXY_REF, custom, { ip, now: at(22) });
      assert.equal(proxied.status, 429, proxied.text);
      assert.match(proxied.json?.message || '', /잠시 후 다시 시도해 주세요/);
      assert.equal(typeof proxied.json?.documentation_url, 'string');
      assert.equal(proxied.headers.get('x-should-retry'), 'false');
      assert.equal(proxied.headers.get('retry-after'), String(600 - 22));
      const genInfo = await shared('/shared', gen, { ip, now: at(22) });
      assert.equal(genInfo.status, 200, genInfo.text);
      assert.equal(gh.log.length, mark, 'nothing reached GitHub');
      assert.equal(fake.requests.length, upstreamMark, 'nothing reached Anthropic');
      return '7 /shared + 7 activity + 6 proxy failures = 20 → /v1/messages, /shared, activity and the proxy all 429 '
        + `(proxy: GitHub shape, retry-after ${proxied.headers.get('retry-after')}); generated code on /shared still 200`;
    },
  },
  {
    name: 'admin limiter: 10 wrong tokens → 401, then 429 even for the right token; own bucket; missing token not counted; window reset',
    fn: async () => {
      const ip = '203.0.113.70';
      const t0 = T('2031-02-07T00:00:00Z');
      const at = (i) => String(t0 + i * 1000);
      const custom = (await newCode({ name: '관리 IP 팀', code: 'ADMIN-NET-TEAM' })).code;
      for (let i = 0; i < 15; i++) assertError(await call('/relay/admin/codes', { ip, now: at(i) }), 401, 'authentication_error');
      for (let i = 0; i < 10; i++) {
        const res = await call('/relay/admin/codes', { admin: `wrong-admin-token-${i}-0123456789`, ip, now: at(15 + i) });
        assert.match(assertError(res, 401, 'authentication_error'), /관리자 토큰이 올바르지 않습니다/);
      }
      assertLimited(await call('/relay/admin/codes', { admin: 'wrong-admin-token-10-0123456789', ip, now: at(26) }));
      const right = await call('/relay/admin/codes', { admin: true, ip, now: at(27) });
      const { after } = assertLimited(right);
      assertLimited(await call('/relay/admin/codes', { method: 'POST', admin: true, ip, now: at(27), body: { name: 'x' } }));
      assert.equal((await me(custom, { ip, now: at(28) })).status, 200, 'invite codes have their own bucket');
      assert.equal((await me('MISS-ADM-0', { ip, now: at(28) })).status, 401);
      assert.equal((await call('/relay/admin/codes', { admin: true, ip: '203.0.113.71', now: at(28) })).status, 200, 'other IP');
      const later = await call('/relay/admin/codes', { admin: true, ip, now: String(t0 + 15_000 + 600_000) });
      assert.equal(later.status, 200, `after the window: ${later.text}`);
      // 21 invite-code failures do not touch the admin bucket.
      const ip2 = '203.0.113.72';
      await failMany(20, { ip: ip2, at, tag: 'ADM2' });
      assertLimited(await me('MISS-ADM2-020', { ip: ip2, now: at(21) }));
      assert.equal((await call('/relay/admin/codes', { admin: true, ip: ip2, now: at(22) })).status, 200);
      return `15 tokenless calls not counted; 10 wrong → 401; then wrong and right → 429 (retry-after ${after}s); `
        + 'invite codes and other IPs unaffected; right token works after the window; code failures leave admin alone';
    },
  },
];
