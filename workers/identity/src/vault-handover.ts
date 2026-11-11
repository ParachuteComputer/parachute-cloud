/**
 * Hand a vault to another account in place (T-446, Parachute 0.9.1). The vault stays where it is: same name, same
 * vault_id, same Durable Object, same notes, history, attachments, snapshots and write stamps. Only
 * `vaults.owner_user_id` changes. Nothing is exported or copied.
 *
 *   POST   /account/vaults/<name>/handover  {to: "<address>"}  → 201 {id, vault, to, status: "open", created_at, expires_at}
 *   DELETE /account/vaults/<name>/handover                     → 200 {id, vault, status: "withdrawn"}
 *   GET    /account/handovers                                  → 200 {outgoing: [...], incoming: [...]}  (open offers)
 *   POST   /account/handovers/<id>/accept                      → 200 {id, vault, status: "accepted", already, accepted_at, cut_now}
 *
 * The rules it holds:
 *   - **Two-sided.** Only the vault's owner offers, with their own account token (`client_id=parachute-account`,
 *     admin; never an OAuth app's account grant, never an app key). Only the account whose PROVEN address the offer
 *     names accepts. An offer to an address with no account is answered exactly like any other (no oracle); it just
 *     can't be accepted until that address has a proven account. One open offer per vault (a partial unique
 *     index); it expires after {@link OFFER_TTL_MS} and the owner can withdraw it.
 *   - **Atomic.** The accept is ONE D1 batch (a transaction): the owner change is guarded on the offer being open,
 *     unexpired and addressed to this account, the vault still the offerer's (same vault_id), both accounts live,
 *     and the receiver's vault count under its plan's limit — all evaluated inside the write. The offer closes in the
 *     same batch only if the owner changed, and everything else in the batch runs only for the request whose nonce
 *     closed it. So the vault never has two owners or none, two racing accepts change it once, and accept racing
 *     withdraw has one winner. A replayed accept answers `already: true` and changes nothing.
 *   - **The old owner's reach to this vault ends** ({@link endOldOwnerReach}); their other vaults are untouched.
 *   - **Recorded on both accounts** in the audit log, fixed labels, notes {vault_id, handover} only.
 *   - **Not on a single-owner door** (OWNER_PUBKEY): it has one account, so there is no one to hand to; the routes
 *     answer 403 `handover_unavailable` with what to do instead.
 *
 * Bearer routes (the account token), not cookie routes: a browser holds the session cookie, and only the
 * CSRF-checked `POST /account/token` turns it into the bearer, so there is no cookie-authenticated write here to
 * forge cross-site.
 */
import { auditTargetHash } from "./account-audit.ts";
import { requireAccount, readJsonBody } from "./account-api.ts";
import { carriesDelegatedPrincipal } from "./account-session-link.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "./account-token.ts";
import { randomBase64url } from "./crypto.ts";
import { isUniqueViolation } from "./nostr-auth.ts";
import { billingModeOf, jsonResponse, type OAuthDeps } from "./oauth-shared.ts";
import { PLAN_SPECS, entitlementPlanFor, isEntitled, planEntitlement, vaultCapMessage, vaultLimitPlan } from "./plans.ts";
import { getUserById, type User } from "./users.ts";
import { EMAIL_RE, normalizeEmail } from "./validation.ts";
import { CAP_PUSH_MAX_ATTEMPTS, callVaultApi, pushVaultCap } from "./vault-call.ts";
import { getVault } from "./vaults.ts";

/** How long an offer stays open. */
export const OFFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PUSH_TIMEOUT_MS = 3000;

/**
 * What a handover keeps with the vault: everything that lives IN the vault, which is everything but who owns it.
 * Nothing on this list is touched by the handover; a write stamp names who wrote at the time and stays so.
 *
 * THE SEAM FOR 1.0 GRANTS (parachute-core SPEC-1.0-grants.md §8–9, draft core PR #69): grants are statements the
 * vault keeps. A handover keeps them as history, readable, with their stamps; the old owner's signed grants stop
 * being authority because the door tells the vault its owner keys (the same push as {@link pushOwnerCut}, which
 * then also carries the new owner-key list), and the accept offers the new owner the list to sign again. Door
 * grants (OAuth apps, named keys) end with their credential, as below. When grants exist, they are added HERE as
 * carried, and the owner-key list goes on the cut push; nothing in the accept batch changes.
 */
export const HANDOVER_CARRIES_OVER = [
  "notes, revisions and attachments",
  "write stamps (created_by / last_updated_by, *_via)",
  "tags, schemas and links",
  "snapshots and usage",
  "the vault's name and vault_id",
] as const;

/**
 * What a handover ENDS: every credential that reached this vault through the old owner's account, and nothing that
 * reaches only their other vaults. Each statement runs inside the accept batch, and only if this request's nonce
 * closed the offer (`closedHere`), so a replay or a lost race ends nothing twice.
 *
 *   - Named app keys on this vault: revoked (their `app_keys` rows keep their names, as every revoked key does).
 *     The new owner mints their own. A key is an account's credential; it is not handed with the vault.
 *   - OAuth tokens (access + refresh share the registry row) and app-key registry rows that name this vault:
 *     revoked, so the public revocation list carries them and no refresh mints again. A token that ALSO names one
 *     of the old owner's other vaults is one credential: it ends too (its refresh would already be refused by the
 *     mint-time ownership gate); the app reconnects to the other vault.
 *   - Standing OAuth consent (`grants`): this vault's scopes are removed (the row is deleted when nothing is left).
 *   - Unredeemed authorization codes naming this vault: deleted.
 *   - Account-wide reach (the account token, account-wide OAuth grants, sessions) is NOT revoked: every path from it
 *     to a vault checks the vault's current owner (vault-token mint, the account MCP fan-out, the console), so it
 *     simply stops reaching this vault and keeps reaching the others.
 *   - Live short-lived tokens with no registry row (vault tokens the account minted, 15 minutes), and any token a
 *     mint racing the batch signs: the vault itself refuses every token of the old owner from the handover on,
 *     told by {@link pushOwnerCut} after the batch.
 */
function endOldOwnerReach(
  db: D1Database,
  p: { oldOwner: string; vault: string; nowIso: string; grants: { client_id: string; scopes: string }[] },
  closedHere: { sql: string; binds: unknown[] },
): D1PreparedStatement[] {
  const needles = vaultNeedles(p.oldOwner, p.vault);
  // Lowercased like deleteVaultD1Rows: a vault name is lowercase, a stored scope may not be.
  const reaches = `(${needles.map(() => "instr(' ' || lower(scopes) || ' ', ?) > 0").join(" OR ")})`;
  const out: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? AND ${reaches} AND ${closedHere.sql}`,
      )
      .bind(p.nowIso, p.oldOwner, p.nowIso, ...needles, ...closedHere.binds),
    db
      .prepare(`UPDATE app_keys SET revoked_at = ? WHERE user_id = ? AND vault_name = ? AND revoked_at IS NULL AND ${closedHere.sql}`)
      .bind(p.nowIso, p.oldOwner, p.vault, ...closedHere.binds),
    db
      .prepare(`DELETE FROM auth_codes WHERE user_id = ? AND ${reaches} AND ${closedHere.sql}`)
      .bind(p.oldOwner, ...needles, ...closedHere.binds),
  ];
  for (const g of p.grants) {
    const scopes = g.scopes.split(" ").filter((s) => s.length > 0);
    const kept = scopes.filter((s) => !needles.some((n) => ` ${s.toLowerCase()} `.includes(n)));
    if (kept.length === scopes.length) continue;
    out.push(
      kept.length === 0
        ? db
            .prepare(`DELETE FROM grants WHERE user_id = ? AND client_id = ? AND scopes = ? AND ${closedHere.sql}`)
            .bind(p.oldOwner, g.client_id, g.scopes, ...closedHere.binds)
        : db
            .prepare(`UPDATE grants SET scopes = ? WHERE user_id = ? AND client_id = ? AND scopes = ? AND ${closedHere.sql}`)
            .bind(kept.join(" "), p.oldOwner, g.client_id, g.scopes, ...closedHere.binds),
    );
  }
  return out;
}

/** The scope tokens that name exactly this vault for this owner (never the account-wide forms). */
function vaultNeedles(owner: string, vault: string): string[] {
  return [` vault:${vault}:`, ` account:${owner}:vaults:${vault}:`, ` account:${owner}:vaults:${vault} `];
}

interface OfferRow {
  id: string;
  vault_id: string;
  vault_name: string;
  from_user_id: string;
  to_email: string;
  to_user_id: string | null;
  state: "open" | "withdrawn" | "accepted" | "expired";
  created_at: string;
  expires_at: string;
  closed_at: string | null;
}

const err = (status: number, error: string, message: string) =>
  jsonResponse({ error, message }, status, { "cache-control": "no-store" });
const ok = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });

/** The gate for every handover route: not on a single-owner door; the owner's own account token, admin. */
async function gate(db: D1Database, req: Request, deps: OAuthDeps) {
  if (deps.ownerPubkey) {
    return {
      ok: false as const,
      response: err(
        403,
        "handover_unavailable",
        "This door has one owner, so there is no other account to hand a vault to. To give a vault to someone, export it (GET /api/export) and they import it at their own door.",
      ),
    };
  }
  const auth = await requireAccount(db, req, deps, "admin");
  if (!auth.ok) return auth;
  // Not an app's account grant, and not a delegated principal (an admin key acting for the account).
  if (auth.clientId !== ACCOUNT_TOKEN_CLIENT_ID || carriesDelegatedPrincipal(req)) {
    return { ok: false as const, response: err(403, "insufficient_scope", "a vault is handed over with the account's own token, not an app's or an admin's") };
  }
  return auth;
}

function vaultFromPath(req: Request): string | null {
  const m = /^\/account\/vaults\/([^/]+)\/handover\/?$/.exec(new URL(req.url).pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!).toLowerCase();
  } catch {
    return null;
  }
}

const nowOf = (deps: OAuthDeps) => deps.now?.() ?? new Date();

function frozen(user: User, deps: OAuthDeps): boolean {
  return !isEntitled(entitlementPlanFor(user.plan, user.pendingPlan, billingModeOf(deps)));
}

const auditInsert = (db: D1Database, p: { action: string; targetHash: string; vaultId: string; offerId: string; at: string }, closedHere: { sql: string; binds: unknown[] }) =>
  db
    .prepare(
      `INSERT INTO account_audit (id, at, actor, action, target_hash, note) SELECT ?, ?, 'self', ?, ?, ? WHERE ${closedHere.sql}`,
    )
    .bind(randomBase64url(16), p.at, p.action, p.targetHash, JSON.stringify({ vault_id: p.vaultId, handover: p.offerId }), ...closedHere.binds);

// --- offer --------------------------------------------------------------------------------------------------------

export async function handleHandoverOffer(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await gate(db, req, deps);
  if (!auth.ok) return auth.response;
  const name = vaultFromPath(req);
  const vault = name ? await getVault(db, name) : null;
  if (!vault || vault.ownerUserId !== auth.accountId || !vault.vaultId) {
    return err(404, "vault_not_found", `you have no vault named "${name ?? ""}"`);
  }
  const body = await readJsonBody(req);
  const extra = Object.keys(body).filter((k) => k !== "to");
  if (extra.length) return err(400, "invalid_request", `unknown field(s): ${extra.join(", ")}; an offer takes only "to"`);
  if (typeof body.to !== "string" || !EMAIL_RE.test(body.to.trim())) {
    return err(400, "invalid_request", 'to: the address of the account that should receive the vault');
  }
  const to = normalizeEmail(body.to);
  if (to === normalizeEmail(auth.user.email)) return err(400, "same_account", "that address is this account's own; name the account that should receive the vault");
  if (frozen(auth.user, deps)) {
    return err(403, "plan_frozen", "This account's plan has ended, so its vaults are read-only and can't be handed over. Choose a plan first.");
  }
  if (vault.importPendingAt !== null) return err(409, "vault_busy", "This vault is still being imported or restored; hand it over once that finishes.");

  const now = nowOf(deps);
  const nowIso = now.toISOString();
  const id = randomBase64url(16);
  const expiresAt = new Date(now.getTime() + OFFER_TTL_MS).toISOString();
  try {
    await db.batch([
      // An open offer past its time is dead; mark it so the new one can take its place.
      db
        .prepare("UPDATE vault_handovers SET state = 'expired', closed_at = ? WHERE vault_id = ? AND state = 'open' AND expires_at <= ?")
        .bind(nowIso, vault.vaultId, nowIso),
      db
        .prepare(
          `INSERT INTO vault_handovers (id, vault_id, vault_name, from_user_id, to_email, state, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .bind(id, vault.vaultId, vault.name, auth.accountId, to, nowIso, expiresAt),
      auditInsert(db, { action: "vault_handover_offered", targetHash: await auditTargetHash(auth.accountId), vaultId: vault.vaultId, offerId: id, at: nowIso }, { sql: "1", binds: [] }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) return err(409, "offer_exists", `"${vault.name}" already has an open offer; withdraw it first (DELETE /account/vaults/${vault.name}/handover)`);
    throw e;
  }
  return ok({ id, vault: vault.name, to, status: "open", created_at: nowIso, expires_at: expiresAt }, 201);
}

// --- withdraw -----------------------------------------------------------------------------------------------------

export async function handleHandoverWithdraw(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await gate(db, req, deps);
  if (!auth.ok) return auth.response;
  const name = vaultFromPath(req);
  const vault = name ? await getVault(db, name) : null;
  if (!vault || vault.ownerUserId !== auth.accountId || !vault.vaultId) {
    return err(404, "vault_not_found", `you have no vault named "${name ?? ""}"`);
  }
  const nowIso = nowOf(deps).toISOString();
  const offer = await db
    .prepare("SELECT * FROM vault_handovers WHERE vault_id = ? AND from_user_id = ? AND state = 'open' AND expires_at > ?")
    .bind(vault.vaultId, auth.accountId, nowIso)
    .first<OfferRow>();
  if (!offer) return err(404, "no_offer", `"${vault.name}" has no open offer`);
  const nonce = randomBase64url(16);
  const closedHere = { sql: "EXISTS (SELECT 1 FROM vault_handovers WHERE id = ? AND close_nonce = ?)", binds: [offer.id, nonce] };
  const res = await db.batch([
    db
      .prepare("UPDATE vault_handovers SET state = 'withdrawn', closed_at = ?, close_nonce = ? WHERE id = ? AND state = 'open'")
      .bind(nowIso, nonce, offer.id),
    auditInsert(db, { action: "vault_handover_withdrawn", targetHash: await auditTargetHash(auth.accountId), vaultId: offer.vault_id, offerId: offer.id, at: nowIso }, closedHere),
  ]);
  // Lost a race with an accept (or another withdraw): the offer is no longer open.
  if ((res[0]?.meta.changes ?? 0) === 0) return err(404, "no_offer", `"${vault.name}" has no open offer`);
  return ok({ id: offer.id, vault: vault.name, status: "withdrawn" });
}

// --- list ---------------------------------------------------------------------------------------------------------

export async function handleHandoversList(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await gate(db, req, deps);
  if (!auth.ok) return auth.response;
  const nowIso = nowOf(deps).toISOString();
  const outgoing = await db
    .prepare("SELECT * FROM vault_handovers WHERE from_user_id = ? AND state = 'open' AND expires_at > ? ORDER BY created_at")
    .bind(auth.accountId, nowIso)
    .all<OfferRow>();
  // Offers to this account's address, once that address is proven (an unproven holder sees nothing).
  const incoming = auth.user.emailVerified
    ? await db
        .prepare(
          `SELECT h.*, u.email AS from_email FROM vault_handovers h LEFT JOIN users u ON u.id = h.from_user_id
            WHERE h.to_email = ? AND h.state = 'open' AND h.expires_at > ? ORDER BY h.created_at`,
        )
        .bind(normalizeEmail(auth.user.email), nowIso)
        .all<OfferRow & { from_email: string | null }>()
    : { results: [] as (OfferRow & { from_email: string | null })[] };
  const view = (r: OfferRow) => ({ id: r.id, vault: r.vault_name, to: r.to_email, status: "open", created_at: r.created_at, expires_at: r.expires_at });
  return ok({
    outgoing: (outgoing.results ?? []).map(view),
    incoming: (incoming.results ?? []).map((r) => ({ ...view(r), from: r.from_email })),
  });
}

// --- accept -------------------------------------------------------------------------------------------------------

export async function handleHandoverAccept(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const auth = await gate(db, req, deps);
  if (!auth.ok) return auth.response;
  const me = auth.user;
  const m = /^\/account\/handovers\/([^/]+)\/accept\/?$/.exec(new URL(req.url).pathname);
  const id = m ? m[1]! : "";
  const notFound = () => err(404, "offer_not_found", "no such offer for this account");

  const load = () => db.prepare("SELECT * FROM vault_handovers WHERE id = ?").bind(id).first<OfferRow>();
  const offer = await load();
  if (!offer || offer.to_email !== normalizeEmail(me.email) || offer.from_user_id === me.id) return notFound();

  const replay = () => answerReplay(db, deps, offer.id, me.id);
  const refusal = await whyNot(db, deps, offer, me);
  if (refusal === "replay") return replay();
  if (refusal) return refusal;

  const vault = (await getVault(db, offer.vault_name))!;
  const limit = PLAN_SPECS[vaultLimitPlan(me.plan, me.pendingPlan, billingModeOf(deps))].vault_count;
  const nowIso = nowOf(deps).toISOString();
  const nonce = randomBase64url(16);
  const closedHere = { sql: "EXISTS (SELECT 1 FROM vault_handovers WHERE id = ? AND close_nonce = ?)", binds: [offer.id, nonce] };
  const grants = await db
    .prepare("SELECT client_id, scopes FROM grants WHERE user_id = ?")
    .bind(offer.from_user_id)
    .all<{ client_id: string; scopes: string }>();

  const res = await db.batch([
    // 1. The owner change, every condition checked inside the write.
    db
      .prepare(
        `UPDATE vaults SET owner_user_id = ?
          WHERE name = ? AND vault_id = ? AND owner_user_id = ? AND import_pending_at IS NULL
            AND EXISTS (SELECT 1 FROM vault_handovers WHERE id = ? AND state = 'open' AND expires_at > ? AND to_email = ?)
            AND EXISTS (SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL AND suspended_at IS NULL)
            AND EXISTS (SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL AND suspended_at IS NULL
                          AND email_verified = 1 AND lower(email) = ?)
            AND (SELECT COUNT(*) FROM vaults WHERE owner_user_id = ?) < ?`,
      )
      .bind(me.id, vault.name, offer.vault_id, offer.from_user_id, offer.id, nowIso, offer.to_email, offer.from_user_id, me.id, offer.to_email, me.id, limit),
    // 2. The offer closes, with this request's nonce, only if 1 happened.
    db
      .prepare(
        `UPDATE vault_handovers SET state = 'accepted', to_user_id = ?, closed_at = ?, close_nonce = ?
          WHERE id = ? AND state = 'open' AND EXISTS (SELECT 1 FROM vaults WHERE name = ? AND vault_id = ? AND owner_user_id = ?)`,
      )
      .bind(me.id, nowIso, nonce, offer.id, vault.name, offer.vault_id, me.id),
    // 3. What ends, and 4. the audit rows: only for the request that closed it.
    ...endOldOwnerReach(db, { oldOwner: offer.from_user_id, vault: vault.name, nowIso, grants: grants.results ?? [] }, closedHere),
    auditInsert(db, { action: "vault_handover_given", targetHash: await auditTargetHash(offer.from_user_id), vaultId: offer.vault_id, offerId: offer.id, at: nowIso }, closedHere),
    auditInsert(db, { action: "vault_handover_received", targetHash: await auditTargetHash(me.id), vaultId: offer.vault_id, offerId: offer.id, at: nowIso }, closedHere),
  ]);

  if ((res[1]?.meta.changes ?? 0) === 0) {
    // Something changed between the checks and the write (a racing accept or withdraw, a vault that filled up).
    const now = await load();
    const again = now ? await whyNot(db, deps, now, me) : null;
    if (again === "replay") return replay();
    return again ?? err(409, "offer_unavailable", "This offer can no longer be accepted.");
  }

  const cutNow = await pushOwnerCut(db, deps, vault.name, offer.from_user_id, me.id, nowIso);
  await pushVaultCap(db, deps, me.id, vault.name, planEntitlement(entitlementPlanFor(me.plan, me.pendingPlan, billingModeOf(deps))));
  return ok({ id: offer.id, vault: vault.name, status: "accepted", already: false, accepted_at: nowIso, cut_now: cutNow });
}

/**
 * Why this account can't accept this offer now, as a teaching error; "replay" when it already did; null when it can.
 * Read-only: the batch re-checks every condition inside the write.
 */
async function whyNot(db: D1Database, deps: OAuthDeps, offer: OfferRow, me: User): Promise<Response | "replay" | null> {
  if (offer.state === "accepted") return offer.to_user_id === me.id ? "replay" : err(404, "offer_not_found", "no such offer for this account");
  if (offer.state === "withdrawn") return err(410, "offer_withdrawn", "The owner withdrew this offer.");
  if (offer.state === "expired" || offer.expires_at <= nowOf(deps).toISOString()) {
    return err(410, "offer_expired", "This offer has expired; ask the owner to offer the vault again.");
  }
  if (!me.emailVerified) return err(403, "unverified_account", "Prove this account's address first (the sign-in link), then accept.");
  const vault = await getVault(db, offer.vault_name);
  const from = await getUserById(db, offer.from_user_id);
  if (!vault || vault.vaultId !== offer.vault_id || vault.ownerUserId !== offer.from_user_id || !from || from.deletedAt !== null || from.suspendedAt !== null) {
    return err(409, "offer_unavailable", "This vault can no longer be handed over by the account that offered it.");
  }
  if (vault.importPendingAt !== null) return err(409, "vault_busy", "This vault is still being imported or restored; accept once that finishes.");
  const spec = PLAN_SPECS[vaultLimitPlan(me.plan, me.pendingPlan, billingModeOf(deps))];
  const owned = (await db.prepare("SELECT COUNT(*) AS n FROM vaults WHERE owner_user_id = ?").bind(me.id).first<number>("n")) ?? 0;
  if (owned >= spec.vault_count) {
    return err(403, "vault_limit_reached", `${vaultCapMessage(me.plan, billingModeOf(deps), me.pendingPlan)} The offer stays open until it expires, so you can accept once you have room.`);
  }
  return null;
}

/**
 * A replayed accept: nothing changes in D1. The handover's push is sent again with its own time (idempotent, and the
 * vault ignores it where a newer handover already spoke), so a retry heals a push that failed the first time, even
 * after the vault has moved on.
 */
async function answerReplay(db: D1Database, deps: OAuthDeps, offerId: string, me: string): Promise<Response> {
  const offer = (await db.prepare("SELECT * FROM vault_handovers WHERE id = ?").bind(offerId).first<OfferRow>())!;
  const vault = await getVault(db, offer.vault_name);
  const sameVault = vault !== null && vault.vaultId === offer.vault_id;
  const cutNow = sameVault ? await pushOwnerCut(db, deps, vault.name, offer.from_user_id, me, offer.closed_at!) : false;
  return ok({ id: offer.id, vault: offer.vault_name, status: "accepted", already: true, accepted_at: offer.closed_at, cut_now: cutNow });
}

/**
 * Tell the vault's Durable Object that it changed hands at `at` (`POST /api/internal/handover-cut {from, to, at}`,
 * first-party, minted for the NEW owner): from then on it refuses every token of the previous owner, whenever
 * issued — so a mint that checked ownership just before the batch and signed just after is refused too — until a
 * later handover gives the vault back to them. Ordered by `at`, so a replay or a late push never undoes a newer
 * handover. Retried like the cap push; when it can't land, the registry revocations above still end every
 * registry-backed credential within the revocation list's minute, and an unregistered vault token lives out its
 * 15 minutes; the answer says which (`cut_now`), and a replayed accept pushes again.
 */
async function pushOwnerCut(db: D1Database, deps: OAuthDeps, vaultName: string, oldOwner: string, newOwner: string, at: string): Promise<boolean> {
  for (let attempt = 1; attempt <= CAP_PUSH_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await callVaultApi(db, deps, {
        userId: newOwner,
        vaultName,
        method: "POST",
        apiPath: "/api/internal/handover-cut",
        verb: "admin",
        jsonBody: { from: oldOwner, to: newOwner, at },
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return true;
      if (res.status < 500 && res.status !== 429) break;
    } catch {
      // network: retry
    }
  }
  console.warn(`event=handover_cut_push_failed vault=${vaultName}`);
  return false;
}

