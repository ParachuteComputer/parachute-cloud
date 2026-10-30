/**
 * STAGING/DEV-ONLY hooks for the end-to-end deletion proof (T-318,
 * scripts/smoke-delete-staging.ts). Mounted under `/__test/account-delete/*`
 * in index.ts behind the same `exposeDevLinks` allowlist as every other
 * `__test/*` route (staging | development | test) — 404 in production, pinned
 * by smoke-prod.
 *
 * Belt on top of the env gate: both hooks act ONLY on `@example.com`
 * addresses, the reserved domain every smoke and test account uses. A stray
 * caller on staging therefore cannot fast-forward the purge of, or read the
 * footprint of, any account a person actually signed up with there.
 *
 *   - POST /__test/account-delete/sweep  { email }
 *       Backdates an ALREADY-REQUESTED deletion past its 24-hour window and
 *       runs the real convergence sweep for that one account
 *       (`runAccountDeleteSweep` with `onlyUserId`). Nothing about the sweep
 *       is simulated: same claim, same Stripe teardown, same vault destroy
 *       over the service binding, same D1 purge.
 *   - POST /__test/account-delete/report { email, user_id?, owner_id?, vaults? }
 *       Counts every D1 row that can still name the account. Tables and
 *       columns are enumerated from `sqlite_master` AT RUNTIME, so a table
 *       another change adds later is covered without editing this file.
 *       Returns counts only — never row contents.
 */
import { type AccountDeleteSweepSummary, DELETE_UNDO_WINDOW_MS, runAccountDeleteSweep } from "./account-delete.ts";
import { auditRowsFor } from "./account-audit.ts";
import type { EmailSender } from "./email.ts";
import type { Env } from "./env.ts";
import { type OAuthDeps, jsonResponse } from "./oauth-shared.ts";

const SAFE_DOMAIN = "@example.com";

function bad(status: number, error: string, message: string): Response {
  return jsonResponse({ error, message }, status, { "cache-control": "no-store" });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = (await req.json()) as unknown;
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.endsWith(SAFE_DOMAIN) && email.length > SAFE_DOMAIN.length ? email : null;
}

// --- sweep ---------------------------------------------------------------------

export async function handleTestAccountDeleteSweep(
  env: Env,
  req: Request,
  deps: OAuthDeps,
  sender: EmailSender,
): Promise<Response> {
  const email = safeEmail((await body(req)).email);
  if (!email) return bad(400, "invalid_request", `email must be an ${SAFE_DOMAIN} address`);
  const row = await env.DB
    .prepare("SELECT id, deleted_at, delete_purge_claimed_at FROM users WHERE email = ? COLLATE NOCASE")
    .bind(email)
    .first<{ id: string; deleted_at: string | null; delete_purge_claimed_at: string | null }>();
  if (!row) return bad(404, "not_found", "no account with that email");
  if (row.deleted_at === null) return bad(409, "not_deleting", "this account has not requested deletion");

  const now = deps.now?.() ?? new Date();
  // Backdate only an unclaimed tombstone: once a sweep has claimed the account
  // its tombstone is the CAS value that claim binds, and moving it would turn
  // a retry into a skip.
  if (row.delete_purge_claimed_at === null) {
    const backdated = new Date(now.getTime() - DELETE_UNDO_WINDOW_MS - 1000).toISOString();
    await env.DB
      .prepare("UPDATE users SET deleted_at = ? WHERE id = ? AND deleted_at = ? AND delete_purge_claimed_at IS NULL")
      .bind(backdated, row.id, row.deleted_at)
      .run();
  }
  const summary: AccountDeleteSweepSummary = await runAccountDeleteSweep(env, deps, now, {
    sender,
    onlyUserId: row.id,
  });
  console.log(`event=test_account_delete_sweep user=${row.id} purged=${summary.purged} deferred=${summary.deferred}`);
  return jsonResponse({ user_id: row.id, ...summary }, 200, { "cache-control": "no-store" });
}

// --- report ----------------------------------------------------------------------

/** Tables that are bookkeeping of the platform itself, never about a person. */
function isInternalTable(name: string): boolean {
  return name.startsWith("sqlite_") || name.startsWith("_cf_") || name.startsWith("d1_");
}

/** Double-quote an SQL identifier. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export interface PurgeReport {
  resolved: { user_id: string | null; email: string; owner_id: string | null; vaults: string[] };
  user: {
    exists: boolean;
    tombstoned: boolean;
    purge_claimed: boolean;
    has_stripe_customer: boolean;
    delete_notice_sent: boolean;
  };
  /** Every table that was scanned, with rows still naming the account. */
  tables: Record<string, { rows: number; columns: Record<string, number> }>;
  checked_tables: string[];
  remaining_rows_total: number;
  /** Rows (any table) that still contain the account's email address. */
  email_rows_total: number;
  /** account_audit rows for this account — kept BY DESIGN (hashed target). */
  audit: Array<{ at: string; actor: string; action: string; note: Record<string, unknown> | null }>;
  stripe: { customer_before: boolean | null; customer_deleted: boolean | null };
  notice: { sent: boolean | null };
}

/**
 * Count, in EVERY application table, the rows that can still name this
 * account — by user id, owner id, or email (substring match on every column,
 * which also catches ids embedded in scope strings and alert keys), and by
 * vault name (exact match on `vault*`-named columns and `vaults.name`, plus
 * the scope / R2-key / audience spellings `vault:<n>:`, `vault-<n>/`,
 * `vault.<n>`, `:vaults:<n>`).
 */
export async function buildPurgeReport(
  db: D1Database,
  input: { email: string; userId?: string; ownerId?: string; vaults?: string[]; bounded?: boolean },
): Promise<PurgeReport> {
  const email = input.email.trim().toLowerCase();
  const userRow = await db
    .prepare(
      input.userId
        ? "SELECT id, owner_id, deleted_at, delete_purge_claimed_at, stripe_customer_id, delete_notice_sent_at FROM users WHERE id = ?"
        : "SELECT id, owner_id, deleted_at, delete_purge_claimed_at, stripe_customer_id, delete_notice_sent_at FROM users WHERE email = ? COLLATE NOCASE",
    )
    .bind(input.userId ?? email)
    .first<{
      id: string;
      owner_id: string | null;
      deleted_at: string | null;
      delete_purge_claimed_at: string | null;
      stripe_customer_id: string | null;
      delete_notice_sent_at: string | null;
    }>();
  const userId = input.userId ?? userRow?.id ?? null;
  const ownerId = input.ownerId ?? userRow?.owner_id ?? null;
  const vaults = new Set((input.vaults ?? []).map((v) => v.toLowerCase()));
  if (userId) {
    const owned = await db.prepare("SELECT name FROM vaults WHERE owner_user_id = ?").bind(userId).all<{ name: string }>();
    for (const r of owned.results ?? []) vaults.add(r.name.toLowerCase());
  }

  const idTerms = [userId, ownerId, email].filter((t): t is string => typeof t === "string" && t.length >= 3);
  const vaultList = [...vaults].filter((v) => v.length > 0);

  const tableRes = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>();
  const tables = (tableRes.results ?? []).map((r) => r.name).filter((n) => !isInternalTable(n));
  const infos = await db.batch(tables.map((t) => db.prepare(`PRAGMA table_info(${ident(t)})`)));

  // Terms are INLINED as SQL string literals (quotes doubled), not bound: D1
  // caps bound parameters per statement at 100, and a wide table times every
  // term blows past that. The terms are an email, UUIDs and vault slugs, and
  // doubling `'` is the complete escaping rule for an SQLite string literal.
  const lit = (t: string) => `'${t.replace(/'/g, "''")}'`;
  /** Characters that end an address or a vault slug (bounded mode). */
  const EMAIL_DELIMS = [
    `'"'`, `''''`, `'<'`, `'>'`, `','`, `';'`, `':'`, `'|'`, `'('`, `')'`,
    `'['`, `']'`, `'{'`, `'}'`, `'='`, `'/'`, `'\\'`, "char(9)", "char(10)", "char(13)",
  ];
  const VAULT_DELIMS = [...EMAIL_DELIMS, `'.'`, `'@'`, `'?'`, `'&'`, `'#'`];
  const statements: D1PreparedStatement[] = [];
  const shapes: Array<{ table: string; columns: string[] }> = [];
  tables.forEach((table, i) => {
    const columns = ((infos[i]?.results ?? []) as Array<{ name: string }>).map((c) => c.name);
    if (columns.length === 0) return;
    // `bounded` (the ops door, T-328): the email and vault terms must stand
    // alone, so another account whose address CONTAINS this one (`a@x.io` in
    // `ba@x.io`, `bob@gmail.co` in `bob@gmail.com`) or a vault whose name starts
    // with this one's (`notes` / `notes2`) is not counted as a leftover: every
    // delimiter becomes a space, the value is space-padded, and the term must
    // have a space on each side. Ids (UUIDs) stay substring matches; they
    // cannot collide that way. The staging proof keeps the wider substring net.
    // The padded values are computed ONCE per column in the innermost SELECT
    // (`p<j>` for the email, `q<j>` for vault names), so a wide table cannot
    // push the statement past D1's SQL length cap.
    const bounded = input.bounded === true;
    const pad = (v: string, delims: string[]) =>
      `(' ' || ${delims.reduce((acc, d) => `replace(${acc}, ${d}, ' ')`, v)} || ' ')`;
    // A full stop is part of an address, so it is not a delimiter; an address
    // that ENDS a sentence ("… person@example.com.") is matched on its own.
    const boundedEmail = (p: string) =>
      `(instr(${p}, ${lit(` ${email} `)}) > 0 OR instr(${p}, ${lit(` ${email}. `)}) > 0)`;
    const conds = columns.map((col, j) => {
      const v = `v${j}`;
      const parts: string[] = [];
      for (const term of idTerms) {
        parts.push(
          bounded && term === email ? boundedEmail(`p${j}`) : `instr(${v}, ${lit(term.toLowerCase())}) > 0`,
        );
      }
      const vaultColumn = /vault/i.test(col) || (table === "vaults" && col === "name");
      for (const name of vaultList) {
        if (vaultColumn) parts.push(`${v} = ${lit(name)}`);
        // Bounded: `vault:<n>:`, `vault.<n>`, `:vaults:<n>` read ` vault <n> ` /
        // ` vaults <n> ` once padded; `vault-<n>/` reads ` vault-<n> `.
        const spellings = bounded
          ? [` vault ${name} `, ` vaults ${name} `, ` vault-${name} `]
          : [`vault:${name}:`, `vault-${name}/`, `vault.${name}`, `:vaults:${name}`];
        for (const spelled of spellings) parts.push(`instr(${bounded ? `q${j}` : v}, ${lit(spelled)}) > 0`);
      }
      return parts.length > 0 ? `(${parts.join(" OR ")})` : "0";
    });
    // One pass: the innermost SELECT lowers (and pads) each column once, the
    // middle computes a 0/1 match per column per row, the outer sums them per
    // column and for "any column" (no repeated predicate). `e` flags rows
    // carrying the EMAIL anywhere, reported apart so "no email-bearing rows
    // remain" is its own checkable number.
    const emailCond = columns
      .map((_, j) => (bounded ? boundedEmail(`p${j}`) : `instr(v${j}, ${lit(email)}) > 0`))
      .join(" OR ");
    const base = columns
      .flatMap((col, j) => {
        const v = `lower(CAST(${ident(col)} AS TEXT))`;
        return bounded
          ? [`${v} AS v${j}`, `${pad(v, EMAIL_DELIMS)} AS p${j}`, `${pad(v, VAULT_DELIMS)} AS q${j}`]
          : [`${v} AS v${j}`];
      })
      .join(", ");
    const inner = [
      ...conds.map((c, j) => `(CASE WHEN ${c} THEN 1 ELSE 0 END) AS m${j}`),
      `(CASE WHEN ${emailCond} THEN 1 ELSE 0 END) AS e`,
    ].join(", ");
    const outer = [
      ...columns.map((_, j) => `COALESCE(SUM(m${j}), 0) AS c${j}`),
      `COALESCE(SUM(CASE WHEN ${columns.map((_, j) => `m${j} = 1`).join(" OR ")} THEN 1 ELSE 0 END), 0) AS any_row`,
      `COALESCE(SUM(e), 0) AS email_rows`,
    ].join(", ");
    statements.push(
      // MATERIALIZED: without it SQLite flattens the padded columns back into
      // every predicate that reads them, and the expression tree blows up.
      db.prepare(`WITH b AS MATERIALIZED (SELECT ${base} FROM ${ident(table)}) SELECT ${outer} FROM (SELECT ${inner} FROM b)`),
    );
    shapes.push({ table, columns });
  });
  const counted = statements.length > 0 ? await db.batch(statements) : [];

  const out: PurgeReport["tables"] = {};
  let total = 0;
  let emailRows = 0;
  shapes.forEach(({ table, columns }, i) => {
    const row = ((counted[i]?.results ?? [])[0] ?? {}) as Record<string, number>;
    const perColumn: Record<string, number> = {};
    columns.forEach((col, j) => {
      const n = Number(row[`c${j}`] ?? 0);
      if (n > 0) perColumn[col] = n;
    });
    const rows = Number(row.any_row ?? 0);
    out[table] = { rows, columns: perColumn };
    total += rows;
    emailRows += Number(row.email_rows ?? 0);
  });

  const audit = userId ? await auditRowsFor(db, userId) : [];
  const purged = [...audit].reverse().find((a) => a.action === "purged");
  const requested = [...audit].reverse().find((a) => a.action === "delete_requested");
  return {
    resolved: { user_id: userId, email, owner_id: ownerId, vaults: [...vaults].sort() },
    user: {
      exists: userRow !== null,
      tombstoned: userRow?.deleted_at != null,
      purge_claimed: userRow?.delete_purge_claimed_at != null,
      has_stripe_customer: userRow?.stripe_customer_id != null,
      delete_notice_sent: userRow?.delete_notice_sent_at != null,
    },
    tables: out,
    checked_tables: tables,
    remaining_rows_total: total,
    email_rows_total: emailRows,
    audit,
    stripe: {
      customer_before: purged ? purged.note?.stripe_customer_before === true : userRow ? userRow.stripe_customer_id !== null : null,
      customer_deleted: purged ? purged.note?.stripe_customer_deleted === true : null,
    },
    notice: { sent: requested ? requested.note?.notice_sent === true : null },
  };
}

export async function handleTestAccountDeleteReport(env: Env, req: Request): Promise<Response> {
  const b = await body(req);
  const email = safeEmail(b.email);
  if (!email) return bad(400, "invalid_request", `email must be an ${SAFE_DOMAIN} address`);
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  const vaults = Array.isArray(b.vaults) ? b.vaults.filter((v): v is string => typeof v === "string") : undefined;
  const report = await buildPurgeReport(env.DB, {
    email,
    ...(str(b.user_id) ? { userId: str(b.user_id)! } : {}),
    ...(str(b.owner_id) ? { ownerId: str(b.owner_id)! } : {}),
    ...(vaults ? { vaults } : {}),
  });
  return jsonResponse(report, 200, { "cache-control": "no-store" });
}
