// D1 access. Per proxied request: one batch to look the code up (the failed-attempt count, which writes nothing
// for a code that exists, + the code, today's budgets and the caller's counter; auth.js) and one batched write
// (usage upsert).

/**
 * @typedef {{ code: string, name: string, active: number, allowed_models: string, daily_limit_usd: number,
 *             created_at: number, last_used_at: number | null, person_salt?: string | null,
 *             library_id?: string | null, library_max_bytes?: number | null }} CodeRow
 *   person_salt: absent (a database from before the column) or null for codes made before code deletion existed.
 *   library_id: the code's own library (codes/<library_id>/ in the team repo, docs/CODE-LIBRARIES.md); absent or null until
 *   the code first opens it (made lazily by ensureLibraryId) — codes made since code libraries get one at creation.
 *   library_max_bytes: that library's size cap (null = the default, CODE_LIBRARY_MAX_BYTES).
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

/** Set once this isolate has seen (or added) the optional columns of codes. */
let codeColumnsReady = false;

/** Columns of codes that a database made before them lacks (SQLite has no "ADD COLUMN IF NOT EXISTS"). */
const OPTIONAL_CODE_COLUMNS = [
  ['person_salt', 'TEXT'], // 2026-10-19, code deletion
  ['library_id', 'TEXT'], // 2026-10-19, code libraries
  ['library_max_bytes', 'INTEGER'], // 2026-10-19, code libraries
];

/**
 * Make sure codes has person_salt, library_id and library_max_bytes (and the unique index on library_id).
 * schema.sql creates them in a new database, but SQLite (and D1) has no "ADD COLUMN IF NOT EXISTS", so a database
 * made before 2026-10-19 gets them here, the first time they are needed after the update (creating a code, a code's
 * first visit to its own library, an admin change of a library's cap): PRAGMA table_info, then ALTER TABLE for each
 * missing column (a parallel ALTER from another isolate that won the race is fine). Lookups read `c.*` and treat a
 * missing column as unset, so requests with a code never pay for this check.
 */
export async function ensureCodeColumns(db) {
  if (codeColumnsReady) return;
  const columns = async () => new Set((await db.prepare('PRAGMA table_info(codes)').all()).results.map((c) => c.name));
  const have = await columns();
  for (const [name, type] of OPTIONAL_CODE_COLUMNS) {
    if (have.has(name)) continue;
    try {
      await db.prepare(`ALTER TABLE codes ADD COLUMN ${name} ${type}`).run();
    } catch (err) {
      if (!(await columns()).has(name)) throw err; // not "duplicate column": a real failure
    }
  }
  // Not in schema.sql: on an old database the column does not exist yet when schema.sql runs.
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS codes_by_library ON codes (library_id)').run();
  codeColumnsReady = true;
}

/** A fresh code library id: 16 hex (64 random bits); codes.library_id, the folder codes/<id>/ of the team repo. */
export function newLibraryId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The code's library id, made now when it has none yet (a code from before code libraries, on its first visit to its
 * library, or a code an admin operation needs one for). Concurrent first visits agree: the id is only set while NULL
 * and then read back. @returns {Promise<string>}
 */
export async function ensureLibraryId(db, row) {
  if (/^[0-9a-f]{16}$/.test(row?.library_id || '')) return row.library_id;
  await ensureCodeColumns(db);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db.prepare('UPDATE codes SET library_id = ?2 WHERE code = ?1 AND library_id IS NULL').bind(row.code, newLibraryId()).run();
    } catch (err) {
      if (!/UNIQUE/i.test(String(err?.message))) throw err; // a 2^-64 clash with another code: try another id
      continue;
    }
    const got = await db.prepare('SELECT library_id FROM codes WHERE code = ?1').bind(row.code).first();
    if (/^[0-9a-f]{16}$/.test(got?.library_id || '')) {
      row.library_id = got.library_id;
      return got.library_id;
    }
    if (!got) break;
  }
  throw new Error(`no library id for ${row.code}`);
}

/** Set a code's library size cap (null = the default); false when the code does not exist. */
export async function setLibraryMaxBytes(db, code, maxBytes) {
  await ensureCodeColumns(db);
  const res = await db.prepare('UPDATE codes SET library_max_bytes = ?2 WHERE code = ?1').bind(code, maxBytes).run();
  return res.meta.changes === 1;
}

/** Every code (all columns), oldest first: the split looks codes up by name. @returns {Promise<CodeRow[]>} */
export async function allCodes(db) {
  const { results } = await db.prepare('SELECT * FROM codes ORDER BY created_at, code').all();
  return results;
}

/**
 * Insert a new code with its person salt and its own library id; false when a code with the same key already exists
 * ("EICU2026" is taken by "EICU-2026": the untargeted ON CONFLICT covers the primary key, the unique index
 * codes_by_key and codes_by_library).
 */
export async function insertCode(db, { code, name, active, allowedModels, dailyLimitUsd, createdAt, personSalt, libraryId }) {
  await ensureCodeColumns(db);
  const res = await db.prepare(`
    INSERT INTO codes (code, name, active, allowed_models, daily_limit_usd, created_at, person_salt, library_id)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT DO NOTHING`)
    .bind(code, name, active ? 1 : 0, JSON.stringify(allowedModels), dailyLimitUsd, createdAt, personSalt, libraryId ?? null).run();
  return res.meta.changes === 1;
}

/**
 * Remove a code for good, in one batch (one transaction): its usage rows are kept as history under
 * `deleted:<ISO time>:<code>` (never a valid code, so they count in the totals and the global daily budget but never
 * attach to a code made later with the same letters), the code row goes, and so do the shared_trees rows of its
 * person ids. The caller has already removed the person's files from the shared libraries.
 * @returns {Promise<boolean>} false when the code was already gone
 */
export async function deleteCodeRecord(db, { code, personIds, now }) {
  const statements = [
    db.prepare('UPDATE usage SET code = ?2 WHERE code = ?1').bind(code, deletedUsageCode(code, now)),
    db.prepare('DELETE FROM codes WHERE code = ?1').bind(code),
  ];
  if (personIds.length) {
    statements.push(db.prepare(`DELETE FROM shared_trees WHERE person IN (${personIds.map((_, i) => `?${i + 1}`).join(', ')})`)
      .bind(...personIds));
  }
  const results = await db.batch(statements);
  return results[1].meta.changes === 1;
}

/** The usage.code of a deleted code's history rows. */
export function deletedUsageCode(code, now) {
  return `deleted:${new Date(now).toISOString()}:${code}`;
}

/**
 * Usage that belongs to no code any more (deleted codes; also a request still in flight when its code was deleted):
 * today, this month (KST) and in total.
 * @returns {Promise<{ today_usd: number, month_usd: number, total_usd: number, total_requests: number }>}
 */
export async function deletedCodesUsage(db, { day, month }) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN u.day = ?1 THEN u.usd END), 0) AS today_usd,
      COALESCE(SUM(CASE WHEN substr(u.day, 1, 7) = ?2 THEN u.usd END), 0) AS month_usd,
      COALESCE(SUM(u.usd), 0) AS total_usd,
      COALESCE(SUM(u.requests), 0) AS total_requests
    FROM usage u WHERE NOT EXISTS (SELECT 1 FROM codes c WHERE c.code = u.code)`).bind(day, month).first();
  return row ?? { today_usd: 0, month_usd: 0, total_usd: 0, total_requests: 0 };
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

/**
 * How long rows of shared_trees are kept: trees created through the shared-library proxy and the upload proofs
 * (insertSharedBlob) — an upload proves possession of the bytes this long (js/store/sync.js re-uploads before).
 */
export const SHARED_TREE_KEEP_MS = 60 * 60 * 1000;
/** Upload proofs share shared_trees with the trees: under lib 'blob:<lib>' (tree = the blob sha), never a tree key. */
const blobProofLib = (lib) => `blob:${lib}`;

/**
 * Remember that `person` uploaded blob `sha` through library `lib` (POST git/blobs): the proof that lets them name
 * the blob in a tree of that library (shared.js createTree) when the tree reaches another isolate than the upload.
 * Pruned with the trees (insertSharedTree) after SHARED_TREE_KEEP_MS; removed with a deleted code's person ids.
 */
export async function insertSharedBlob(db, { lib, sha, person, now }) {
  await db.prepare(`
    INSERT INTO shared_trees (lib, tree, base, person, created_at) VALUES (?1, ?2, '', ?3, ?4)
    ON CONFLICT (lib, tree, base, person) DO UPDATE SET created_at = excluded.created_at`)
    .bind(blobProofLib(lib), sha, person, now).run();
}

/**
 * Of `shas`, those `person` uploaded through library `lib` since `since` (insertSharedBlob). One query whatever the
 * number of shas (a tree may name thousands): this person's proofs of the last hour, matched here.
 * @returns {Promise<Set<string>>}
 */
export async function uploadedBlobs(db, { lib, shas, person, since }) {
  const wanted = new Set(shas);
  const { results } = await db.prepare(`
    SELECT tree FROM shared_trees WHERE lib = ?1 AND person = ?2 AND created_at >= ?3 AND base = ''`)
    .bind(blobProofLib(lib), person, since).all();
  return new Set(results.map((r) => r.tree).filter((sha) => wanted.has(sha)));
}

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
