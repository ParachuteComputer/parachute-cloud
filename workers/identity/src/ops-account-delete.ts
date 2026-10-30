/**
 * POST /ops/account-delete (T-328) — the operator AGENT acting on a person's
 * own WRITTEN request to delete their account ("please delete my account",
 * by email). Bearer `OPS_DELETE_TOKEN`, its own secret (this one erases;
 * /ops/daily only reads and /ops/snapshot-run only backs up). Unset → null,
 * and the router answers its plain 404.
 *
 * Why not /admin/users/delete: that path needs an operator's BROWSER session
 * and deliberately keeps the 24-hour undo window and the notice email with
 * the undo link — right when an operator presses the button for someone, wrong
 * when the person has already asked in writing: there is nothing to undo, and
 * the reply ("it's done, here is what remains and when it expires") is written
 * by a person, not mailed by this worker.
 *
 * What it runs is NOT a second deletion. It is the self-service pair, in order:
 *   1. `requestAccountDeletion` — billing hold, tombstone, sessions + tokens +
 *      auth codes cut, vaults locked — with `notifyHolder: false`, so the
 *      holder is not mailed (the sender still carries OPERATOR alerts: a
 *      stuck billing hold, a purge that will not converge);
 *   2. `runAccountDeleteSweep` for this one account with the window waived —
 *      the same claim, Stripe teardown, vault destroy (DO SQLite + the whole
 *      R2 prefix: attachments, snapshots, exports) and D1 purge as the hourly
 *      sweep;
 *   3. the rows keyed by the EMAIL alone (sign-up magic links), deleted even
 *      when no account row exists — an address that started a sign-up and never
 *      finished has no account to purge, and was otherwise unreachable.
 * Then it answers the purge report (counts only, every D1 table enumerated at
 * runtime). That report is a deliberately wide substring net, so every row it
 * flags is re-read here and judged with real boundaries ({@link confirmLeftovers}):
 * another account whose address CONTAINS this one (`ike@x.co` in
 * `mike@x.com`) or a vault named `notes2` next to `notes` is not a leftover,
 * and must not hold `done` at false forever. A vault that will not destroy defers like the sweep does:
 * the account row stays (still closed), the answer says how many passes have
 * failed, and a second call converges.
 *
 * Body: `{ email, confirm, written_request, dry_run? }` — the address twice
 * (the retype guard) and a short reference to the written request, kept on the
 * audit rows (the request's and the purge's). The reference must not contain
 * an address: the audit table never holds one. `dry_run: true` reads only.
 *
 * Operator accounts are refused (409): erasing the console's own operator is
 * never an emailed request.
 */
import { confirmMatchesEmail, requestAccountDeletion, runAccountDeleteSweep } from "./account-delete.ts";
import { buildPurgeReport } from "./account-delete-hooks.ts";
import { opsBearerRefusal } from "./ops-daily.ts";
import type { EmailSender } from "./email.ts";
import type { Env } from "./env.ts";
import type { OAuthDeps } from "./oauth-shared.ts";
import { getUserByEmail, getUserById } from "./users.ts";
import { EMAIL_RE } from "./validation.ts";
import { listVaultsForOwner } from "./vaults.ts";

const NO_STORE = { "cache-control": "no-store" };

function refuse(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status, headers: NO_STORE });
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Double-quote an SQL identifier. */
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
/** Inline an SQL string literal (D1 caps bound parameters at 100 per statement). */
const lit = (t: string) => `'${t.replace(/'/g, "''")}'`;
/** Rows re-read per flagged table; past this every flagged row counts. */
const CONFIRM_ROW_CAP = 500;

/**
 * Re-read the rows the purge report flagged and keep only the ones that
 * really name this account: an id (UUID) anywhere; the email with nothing
 * address-like on either side (a full stop counts as the end unless the domain
 * goes on, so `…@x.co.` is a hit and `…@x.co.uk` is not); a vault name exactly in
 * a vault column, or as `vault:<n>:` / `vault-<n>/` / `vault.<n>` /
 * `:vaults:<n>` with no slug character after it. Counts only; nothing read
 * here leaves the worker.
 */
export async function confirmLeftovers(
  db: D1Database,
  tables: Record<string, { rows: number; columns: Record<string, number> }>,
  terms: { email: string; ids: string[]; vaults: string[] },
): Promise<{ rows_total: number; tables: Record<string, number> }> {
  const emailRe = new RegExp(`(?<![a-z0-9._%+\\-])${escapeRe(terms.email)}(?![a-z0-9\\-]|\\.[a-z0-9])`);
  const vaultRes = terms.vaults.map(
    (n) => new RegExp(`vault:${escapeRe(n)}:|vault-${escapeRe(n)}/|(?:vault\\.|:vaults:)${escapeRe(n)}(?![a-z0-9\\-])`),
  );
  const prefilter = [terms.email, ...terms.ids, ...terms.vaults];
  const out: Record<string, number> = {};
  let total = 0;
  for (const [table, t] of Object.entries(tables)) {
    if (t.rows === 0) continue;
    const cols = Object.entries(t.columns).filter(([, n]) => n > 0).map(([c]) => c);
    if (cols.length === 0) continue;
    const where = cols
      .flatMap((c) => prefilter.map((term) => `instr(lower(CAST(${ident(c)} AS TEXT)), ${lit(term)}) > 0`))
      .join(" OR ");
    const res = await db
      .prepare(`SELECT ${cols.map(ident).join(", ")} FROM ${ident(table)} WHERE ${where} LIMIT ${CONFIRM_ROW_CAP + 1}`)
      .all<Record<string, unknown>>();
    const rows = res.results ?? [];
    let n = 0;
    if (rows.length > CONFIRM_ROW_CAP) {
      n = t.rows;
    } else {
      for (const row of rows) {
        const hit = cols.some((c) => {
          const raw = row[c];
          if (raw === null || raw === undefined) return false;
          const v = String(raw).toLowerCase();
          const vaultColumn = /vault/i.test(c) || (table === "vaults" && c === "name");
          return (
            terms.ids.some((id) => v.includes(id.toLowerCase())) ||
            emailRe.test(v) ||
            (vaultColumn && terms.vaults.includes(v)) ||
            vaultRes.some((r) => r.test(v))
          );
        });
        if (hit) n++;
      }
    }
    if (n > 0) out[table] = n;
    total += n;
  }
  return { rows_total: total, tables: out };
}

async function countMagicLinks(db: D1Database, email: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE email = ?").bind(email).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function handleOpsAccountDeletePost(
  env: Env,
  req: Request,
  deps: OAuthDeps,
  sender?: EmailSender,
): Promise<Response | null> {
  const refused = await opsBearerRefusal(env.OPS_DELETE_TOKEN, req);
  if (refused !== undefined) return refused;
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });

  let body: Record<string, unknown> = {};
  try {
    const parsed = (await req.json()) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    return refuse(400, "invalid_request", "body must be JSON");
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return refuse(400, "invalid_request", "email must be one address");
  if (!confirmMatchesEmail(body.confirm, email)) {
    return refuse(400, "confirm_mismatch", "confirm must repeat email. Nothing was deleted.");
  }
  const ref = typeof body.written_request === "string" ? body.written_request.trim() : "";
  if (ref.length < 3 || ref.length > 200 || ref.includes("@")) {
    return refuse(
      400,
      "written_request_required",
      "written_request: a 3-200 character reference to the person's written request, with no email address in it. Nothing was deleted.",
    );
  }

  const user = await getUserByEmail(env.DB, email);
  if (user?.role === "operator") {
    return refuse(409, "operator_account", "An operator account is not erased this way. Nothing was deleted.");
  }
  const vaults = user
    ? (await listVaultsForOwner(env.DB, user.id)).map((v) => ({ name: v.name, vault_id: v.vaultId }))
    : [];
  const found = {
    account_found: user !== null,
    user_id: user?.id ?? null,
    tombstoned_before: user?.deletedAt != null,
    vaults,
  };

  if (body.dry_run === true) {
    return Response.json(
      {
        dry_run: true,
        ...found,
        purge_claimed: user?.deletePurgeClaimedAt != null,
        stripe_customer: user?.stripeCustomerId != null,
        stripe_subscription: user?.stripeSubscriptionId != null,
        purge_attempts: user?.deletePurgeAttempts ?? 0,
        email_rows: { magic_links: await countMagicLinks(env.DB, email) },
      },
      { headers: NO_STORE },
    );
  }

  let sweep = null;
  if (user) {
    if (user.deletedAt === null) {
      // The person asked in writing; the operator replies by hand.
      const outcome = await requestAccountDeletion(env, deps, user, {
        actor: "operator:ops-agent",
        writtenRequest: ref,
        notifyHolder: false,
        ...(sender ? { sender } : {}),
      });
      if (!outcome.ok && outcome.error !== "already_deleting") {
        return refuse(outcome.status, outcome.error, outcome.message);
      }
    }
    sweep = await runAccountDeleteSweep(env, deps, deps.now?.() ?? new Date(), {
      onlyUserId: user.id,
      waiveWindow: true,
      writtenRequest: ref,
      ...(sender ? { sender } : {}),
    });
  }

  const purged = sweep === null || sweep.purged === 1;
  let magicLinksDeleted = 0;
  if (purged) {
    // The account purge already took its own links by email; this catches the
    // address with no account at all.
    const res = await env.DB.prepare("DELETE FROM magic_links WHERE email = ?").bind(email).run();
    magicLinksDeleted = res.meta.changes ?? 0;
  }

  const report = await buildPurgeReport(env.DB, {
    email,
    ...(user ? { userId: user.id } : {}),
    ...(user?.ownerId ? { ownerId: user.ownerId } : {}),
    vaults: vaults.map((v) => v.name),
  });
  const confirmed = await confirmLeftovers(env.DB, report.tables, {
    email,
    ids: [user?.id, user?.ownerId].filter((t): t is string => typeof t === "string" && t.length >= 3),
    vaults: vaults.map((v) => v.name.toLowerCase()),
  });
  const done = purged && confirmed.rows_total === 0;
  // Still there after a deferral: how many passes have failed (the sweep pages
  // the operator at ACCOUNT_PURGE_ALERT_AFTER_ATTEMPTS). The reason is on the
  // `event=account_purge_deferred` log line.
  const purgeAttempts = user && !purged ? ((await getUserById(env.DB, user.id))?.deletePurgeAttempts ?? null) : null;
  console.log(
    `event=ops_account_delete user=${user?.id ?? "none"} found=${user !== null} purged=${purged} vaults=${vaults.length} magic_links=${magicLinksDeleted} remaining=${report.remaining_rows_total} done=${done}`,
  );
  return Response.json(
    {
      done,
      ...found,
      sweep,
      ...(purgeAttempts !== null ? { purge_attempts: purgeAttempts } : {}),
      magic_links_deleted: magicLinksDeleted,
      leftovers: confirmed,
      report: {
        remaining_rows_total: report.remaining_rows_total,
        email_rows_total: report.email_rows_total,
        tables_with_rows: Object.fromEntries(Object.entries(report.tables).filter(([, t]) => t.rows > 0)),
        checked_tables: report.checked_tables.length,
        audit: report.audit,
      },
    },
    { status: done ? 200 : 502, headers: NO_STORE },
  );
}
