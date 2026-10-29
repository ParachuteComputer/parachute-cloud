/**
 * The operator path for an EMAILED deletion request (T-318) —
 * `/admin/users/delete`. Same trust boundary as every /admin surface
 * (admin.ts: operator session or the router's own 404; POSTs add CSRF +
 * same-origin), and the SAME request path as self-service
 * (`requestAccountDeletion`): billing hold, tombstone, sessions + tokens cut,
 * vaults locked, the 24-hour undo window, and the deletion notice to the
 * account holder — so a person who emailed us gets exactly the outcome (and
 * the undo link) they would have had pressing the button themselves.
 *
 * Logged twice, by design: an `account_audit` row whose actor is
 * `operator:<operator user id>` (durable, hashed target — no email in clear)
 * and an `event=admin_account_delete_requested` log line.
 */
import { confirmMatchesEmail, requestAccountDeletion } from "./account-delete.ts";
import { actionContext, notFound, operatorFor } from "./admin.ts";
import { renderAdminDeleteConfirm } from "./admin-ui.ts";
import { ensureCsrfToken } from "./csrf.ts";
import type { EmailSender } from "./email.ts";
import type { Env } from "./env.ts";
import { type OAuthDeps, htmlResponse, redirectResponse } from "./oauth-shared.ts";
import { getUserByEmail, getUserById } from "./users.ts";
import { countVaultsForOwner } from "./vaults.ts";

async function confirmPage(
  db: D1Database,
  req: Request,
  userId: string,
  error?: string,
): Promise<Response | null> {
  const target = await getUserById(db, userId);
  if (!target) return null;
  const csrf = ensureCsrfToken(req);
  return htmlResponse(
    renderAdminDeleteConfirm({
      user: {
        id: target.id,
        email: target.email,
        vaultCount: await countVaultsForOwner(db, target.id),
        deletedAt: target.deletedAt,
        role: target.role,
      },
      csrfToken: csrf.token,
      ...(error ? { error } : {}),
    }),
    error ? 400 : 200,
    { "cache-control": "no-store", ...(csrf.setCookie ? { "set-cookie": csrf.setCookie } : {}) },
  );
}

/**
 * GET /admin/users/delete?user_id= (from the users table) or ?email= (the
 * operator CLI, which starts from the address in the request email) — the
 * retype-the-email confirm step.
 */
export async function handleAdminDeleteGet(db: D1Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const operator = await operatorFor(db, req, deps);
  if (!operator) return notFound();
  const params = new URL(req.url).searchParams;
  let userId = params.get("user_id") ?? "";
  const email = params.get("email");
  if (!userId && email) userId = (await getUserByEmail(db, email.trim()))?.id ?? "";
  return (await confirmPage(db, req, userId)) ?? redirectResponse("/admin/users?err=not-found");
}

/** POST /admin/users/delete — request deletion on the account holder's behalf. */
export async function handleAdminDeletePost(
  env: Env,
  req: Request,
  deps: OAuthDeps,
  sender: EmailSender,
): Promise<Response> {
  const ctx = await actionContext(env.DB, req, deps);
  if (ctx instanceof Response) return ctx;
  const { operator, form, back } = ctx;

  const target = await getUserById(env.DB, String(form.get("user_id") ?? ""));
  if (!target) return back("err=not-found");
  if (target.id === operator.id) return back("err=self-delete");
  if (target.deletedAt !== null) return back("err=already-deleting");
  if (!confirmMatchesEmail(form.get("confirm_email"), target.email)) {
    return (
      (await confirmPage(env.DB, req, target.id, "That isn't this account's email. Nothing was deleted.")) ??
      back("err=not-found")
    );
  }

  const outcome = await requestAccountDeletion(env, deps, target, { sender, actor: `operator:${operator.id}` });
  if (!outcome.ok) {
    console.error(
      `event=admin_account_delete_failed user=${target.id} by=${operator.id} error=${outcome.error} status=${outcome.status}`,
    );
    return back(outcome.error === "already_deleting" ? "err=already-deleting" : "err=delete-failed");
  }
  console.log(
    `event=admin_account_delete_requested user=${target.id} by=${operator.id} notice_sent=${outcome.noticeSent} vaults_locked=${outcome.vaultsLocked}`,
  );
  return back("notice=delete-requested");
}
