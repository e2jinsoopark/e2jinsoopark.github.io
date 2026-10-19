// D1 access. Per proxied request: one batch to look the code up (the failed-attempt count, which writes nothing
// for a code that exists, + the code, today's budgets and the caller's counter; auth.js) and one batched write
// (usage upsert).

/**
 * @typedef {{ code: string, name: string, active: number, allowed_models: string, daily_limit_usd: number,
 *             created_at: number, last_used_at: number | null }} CodeRow
 * @typedef {CodeRow & { today_usd: number, today_requests: number, global_today_usd: number }} CodeBudgetRow
 * @typedef {CodeRow & { today_usd: number, month_usd: number, total_usd: number, total_requests: number }} CodeUsageRow
 */

/** SQL for a code's lookup key (upper-case letters and digits): what the unique index codes_by_key is built on. */
const KEY_OF = (column) => `replace(${column}, '-', '')`;

/**
 * @typedef {{ code: string | null, name: string | null, active: number | null, allowed_models: string | null,
 *             daily_limit_usd: number | null, created_at: number | null, last_used_at: number | null,
 *             fail_count: number | null, fail_window_start: number | null }} CodeLookupRow
 */

/**
 * The statement that reads the code whose key is `key` (codes.js codeKey; '' matches nothing) and the caller's
 * invite-code failure counter; with `day`, also today's spend for the code and for all codes. Always one row of
 * CodeLookupRow (+ today_usd, today_requests, global_today_usd with `day`): `code` is null when no code has this key,
 * `fail_count` null when the caller has no counter. Run in one batch with the failure count (auth.js).
 */
export function lookupCodeStatement(db, { key, ip, day = null }) {
  const budget = day === null ? '' : `,
      COALESCE((SELECT SUM(u.usd) FROM usage u WHERE u.code = c.code AND u.day = ?3), 0) AS today_usd,
      COALESCE((SELECT SUM(u.requests) FROM usage u WHERE u.code = c.code AND u.day = ?3), 0) AS today_requests,
      COALESCE((SELECT SUM(g.usd) FROM usage g WHERE g.day = ?3), 0) AS global_today_usd`;
  const args = day === null ? [key, ip] : [key, ip, day];
  return db.prepare(`
    SELECT c.*, f.failures AS fail_count, f.window_start AS fail_window_start${budget}
    FROM (SELECT 1) AS one
    LEFT JOIN codes c ON ${KEY_OF('c.code')} = ?1
    LEFT JOIN auth_failures f ON f.ip = ?2 AND f.kind = 'code'`).bind(...args);
}

/**
 * A code by its lookup key (admin paths: PATCH, usage filter). Null when unknown.
 * @returns {Promise<CodeRow | null>}
 */
export function findCodeByKey(db, key) {
  return db.prepare(`SELECT * FROM codes WHERE ${KEY_OF('code')} = ?1`).bind(key).first();
}

/**
 * Add one finished request to the usage table. Each billed attempt goes to its model's row; the request itself
 * is counted once (on the first part). Also stamps the code's last use.
 * @param {{ code: string, day: string, now: number,
 *           parts: { model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number,
 *                    cacheWriteTokens: number, usd: number }[] }} entry
 */
export async function recordUsage(db, { code, day, now, parts }) {
  const upsert = db.prepare(`
    INSERT INTO usage (code, day, model, requests, input_tokens, output_tokens, cache_read_tokens,
                       cache_write_tokens, usd)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT (code, day, model) DO UPDATE SET
      requests = requests + excluded.requests,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      usd = usd + excluded.usd`);
  const statements = parts.map((p, i) => upsert.bind(code, day, p.model, i === 0 ? 1 : 0, p.inputTokens,
    p.outputTokens, p.cacheReadTokens, p.cacheWriteTokens, p.usd));
  statements.push(db.prepare('UPDATE codes SET last_used_at = ?2 WHERE code = ?1').bind(code, now));
  await db.batch(statements);
}

/**
 * Codes with their usage today, this month and in total; newest first. With `code`, only that one.
 * @returns {Promise<CodeUsageRow[]>}
 */
export async function codesWithUsage(db, { day, month, code = null }) {
  const { results } = await db.prepare(`
    SELECT c.*,
      COALESCE(SUM(CASE WHEN u.day = ?1 THEN u.usd END), 0) AS today_usd,
      COALESCE(SUM(CASE WHEN substr(u.day, 1, 7) = ?2 THEN u.usd END), 0) AS month_usd,
      COALESCE(SUM(u.usd), 0) AS total_usd,
      COALESCE(SUM(u.requests), 0) AS total_requests
    FROM codes c LEFT JOIN usage u ON u.code = c.code
    WHERE ?3 IS NULL OR c.code = ?3
    GROUP BY c.code
    ORDER BY c.created_at DESC, c.code`).bind(day, month, code).all();
  return results;
}

/**
 * Insert a new code; false when a code with the same key already exists ("EICU2026" is taken by "EICU-2026": the
 * untargeted ON CONFLICT covers the primary key and the unique index codes_by_key).
 */
export async function insertCode(db, { code, name, active, allowedModels, dailyLimitUsd, createdAt }) {
  const res = await db.prepare(`
    INSERT INTO codes (code, name, active, allowed_models, daily_limit_usd, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING`)
    .bind(code, name, active ? 1 : 0, JSON.stringify(allowedModels), dailyLimitUsd, createdAt).run();
  return res.meta.changes === 1;
}

/** Update some fields of a code; false when it does not exist. */
export async function updateCode(db, code, { name, active, allowedModels, dailyLimitUsd }) {
  const sets = [];
  const args = [code];
  const add = (column, value) => {
    args.push(value);
    sets.push(`${column} = ?${args.length}`);
  };
  if (name !== undefined) add('name', name);
  if (active !== undefined) add('active', active ? 1 : 0);
  if (allowedModels !== undefined) add('allowed_models', JSON.stringify(allowedModels));
  if (dailyLimitUsd !== undefined) add('daily_limit_usd', dailyLimitUsd);
  const res = await db.prepare(`UPDATE codes SET ${sets.join(', ')} WHERE code = ?1`).bind(...args).run();
  return res.meta.changes === 1;
}

/**
 * Usage per day and model between two KST days (inclusive), optionally for one code.
 * @returns {Promise<{ day: string, model: string, requests: number, input_tokens: number, output_tokens: number,
 *                     cache_read_tokens: number, cache_write_tokens: number, usd: number }[]>}
 */
export async function usageByDay(db, { fromDay, toDay, code = null }) {
  const { results } = await db.prepare(`
    SELECT day, model, SUM(requests) AS requests, SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens, SUM(usd) AS usd
    FROM usage
    WHERE day >= ?1 AND day <= ?2 AND (?3 IS NULL OR code = ?3)
    GROUP BY day, model`).bind(fromDay, toDay, code).all();
  return results;
}

/** allowed_models column → array (stored as JSON; tolerates a hand-edited comma list). */
export function parseModels(text) {
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) return v.map(String);
  } catch { /* comma list */ }
  return String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** How long a tree created through the shared-library proxy may be committed (and how long rows are kept). */
const SHARED_TREE_KEEP_MS = 60 * 60 * 1000;

/**
 * Remember that `person` created `tree` on top of `base` ('' = no base: the branch did not exist yet) through the
 * proxy, so POST git/commits can check that a commit's tree descends from its parent's tree. Old rows are pruned
 * in the same batch.
 */
export async function insertSharedTree(db, { lib, tree, base, person, now }) {
  await db.batch([
    db.prepare(`
      INSERT INTO shared_trees (lib, tree, base, person, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT (lib, tree, base, person) DO UPDATE SET created_at = excluded.created_at`)
      .bind(lib, tree, base, person, now),
    db.prepare('DELETE FROM shared_trees WHERE created_at < ?1').bind(now - SHARED_TREE_KEEP_MS),
  ]);
}

/**
 * Whether `person` created `tree` through the proxy since `since` (epoch ms) — on top of `base` when given.
 * @returns {Promise<boolean>}
 */
export async function hasSharedTree(db, { lib, tree, base = null, person, since }) {
  const row = await db.prepare(`
    SELECT 1 AS ok FROM shared_trees
    WHERE lib = ?1 AND tree = ?2 AND person = ?3 AND created_at >= ?4 AND (?5 IS NULL OR base = ?5) LIMIT 1`)
    .bind(lib, tree, person, since, base).first();
  return Boolean(row);
}
