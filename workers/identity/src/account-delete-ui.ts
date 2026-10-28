/**
 * The pages behind the "restore your account" link in the deletion notice
 * (T-318). Same page shell + brand styles as every other server-rendered
 * ceremony page (ui.ts `page`), plain words, no urgency. The GET page never
 * changes anything — the button POSTs — because mail link scanners prefetch.
 */
import { esc, page } from "./ui.ts";

/** "28 Oct 2026, 14:05 UTC" — the server can't know the reader's zone, so say UTC. */
export function humanUtc(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

export interface UndoConfirmProps {
  email: string;
  vaultNames: string[];
  deletedAt: string;
  expiresAt: string;
  /** The raw undo token, round-tripped as a hidden field to the POST. */
  token: string;
  csrfToken: string;
  hasSubscription: boolean;
}

export function renderUndoConfirm(p: UndoConfirmProps): string {
  const n = p.vaultNames.length;
  const vaultLine =
    n === 0
      ? `<p>This account has no vaults.</p>`
      : `<p>${n === 1 ? "Your vault comes" : `Your ${n} vaults come`} back exactly as they were, with every note, file and snapshot in ${n === 1 ? "it" : "them"}:</p>
         <ul class="scopes">${p.vaultNames.map((v) => `<li>${esc(v)}</li>`).join("")}</ul>`;
  return page(
    "Restore your account — Parachute",
    `<h1>Restore your account</h1>
     <div class="card" data-testid="undo-confirm">
       <p>The account for <strong>${esc(p.email)}</strong> was closed on ${esc(humanUtc(p.deletedAt))}. Nothing has been erased yet.</p>
       ${vaultLine}
       ${p.hasSubscription ? `<p class="muted">Your subscription picks up where it left off.</p>` : ""}
       <p class="muted">You can restore it until ${esc(humanUtc(p.expiresAt))}. After you restore it, sign in again on each device.</p>
       <form method="post" action="/account/undo-delete">
         <input type="hidden" name="__csrf" value="${esc(p.csrfToken)}">
         <input type="hidden" name="token" value="${esc(p.token)}">
         <button class="primary" type="submit">Restore my account</button>
       </form>
     </div>
     <p class="muted foot">If you meant to delete it, you don't need to do anything. It will be erased after the time above.</p>`,
  );
}

export function renderUndoDone(p: { signInUrl: string; billingResumed: boolean }): string {
  return page(
    "Your account is back — Parachute",
    `<h1>Your account is back</h1>
     <div class="card" data-testid="undo-done">
       <p>Sign in again to continue. Your vaults and everything in them are just as you left them.</p>
       ${p.billingResumed ? "" : `<p class="muted">Your subscription had already ended during the 24 hours, so it was not restarted.</p>`}
       <a class="primary" style="display:block;text-align:center;text-decoration:none;padding:.62rem 1rem" href="${esc(p.signInUrl)}">Sign in</a>
     </div>`,
  );
}

export function renderUndoProblem(p: { title: string; message: string; signInUrl: string }): string {
  return page(
    `${p.title} — Parachute`,
    `<h1>${esc(p.title)}</h1>
     <div class="card" data-testid="undo-problem">
       <p>${esc(p.message)}</p>
     </div>
     <div class="foot"><a href="${esc(p.signInUrl)}">Go to Parachute</a></div>`,
  );
}
