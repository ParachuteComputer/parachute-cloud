/**
 * Server-rendered login + consent + error views for /oauth/authorize. Minimal
 * self-contained HTML (no external assets — CSP-safe), forms POST back to
 * /oauth/authorize. Kept deliberately small: this is the human surface, not the
 * wire contract.
 */
// The first-run research chips mirror the landing page's set; the values live
// in checklist.ts (next to the allowlist that gates the write).
import { NOTES_APP_OPTIONS } from "./checklist.ts";
// Plan copy renders from plans.ts (the single source of truth for
// entitlements + display strings) — the console can never drift from it.
import {
  PARACHUTE_PRICE_MONTHLY_LABEL,
  PARACHUTE_PRICE_YEARLY_LABEL,
  PLAN_SPECS,
  type PlanId,
  formatPlanBytes,
  formatUsageBytes,
  parachuteTeaser,
  planLine,
  vaultCapMessage,
} from "./plans.ts";

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string | null;
  resource: string | null;
  vault: string | null;
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Hidden inputs that round-trip the authorize params through a form POST. */
function hiddenParams(p: AuthorizeParams): string {
  const fields: Array<[string, string]> = [
    ["client_id", p.clientId],
    ["redirect_uri", p.redirectUri],
    ["response_type", p.responseType],
    ["scope", p.scope],
    ["code_challenge", p.codeChallenge],
    ["code_challenge_method", p.codeChallengeMethod],
  ];
  if (p.state !== null) fields.push(["state", p.state]);
  if (p.resource !== null) fields.push(["resource", p.resource]);
  if (p.vault !== null) fields.push(["vault", p.vault]);
  return fields.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("\n");
}

// Brand basics: Instrument Serif display headings, DM Sans body, a calm sage
// palette. Fonts load from Google with a system fallback stack, so the page is
// fully usable if the font request is blocked (the OAuth surfaces stay robust).
const FONT_LINK =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&family=Instrument+Serif&display=swap" rel="stylesheet">';

const STYLE = `
  :root{--bg:#f4f6f1;--card:#fff;--ink:#2b332a;--muted:#6a7566;--line:#dde3d6;--sage:#5f7a57;--sage-dark:#4c6547;--danger:#a5372b}
  *{box-sizing:border-box}
  body{font-family:"DM Sans",system-ui,-apple-system,sans-serif;background:var(--bg);max-width:30rem;margin:0 auto;padding:3.5rem 1.25rem;color:var(--ink);line-height:1.55}
  a{color:var(--sage-dark)}
  .brand{font-family:"Instrument Serif",Georgia,serif;font-size:1.15rem;color:var(--sage-dark);letter-spacing:.01em;margin:0 0 1.5rem;text-align:center}
  h1{font-family:"Instrument Serif",Georgia,serif;font-weight:400;font-size:1.9rem;line-height:1.15;margin:0 0 .35rem}
  h2{font-family:"Instrument Serif",Georgia,serif;font-weight:400;font-size:1.3rem;margin:0 0 .5rem}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.6rem;margin-bottom:1.1rem}
  label{display:block;font-size:.82rem;font-weight:600;margin:.85rem 0 .3rem;color:var(--ink)}
  input[type=email],input[type=password],input[type=text]{width:100%;padding:.6rem .7rem;border:1px solid var(--line);border-radius:9px;font-size:1rem;background:#fcfdfb;font-family:inherit}
  input:focus{outline:2px solid var(--sage);outline-offset:0;border-color:var(--sage)}
  button{font-size:1rem;font-family:inherit;padding:.62rem 1rem;border-radius:9px;border:0;cursor:pointer}
  .primary{background:var(--sage);color:#fff;width:100%;margin-top:1.1rem;font-weight:600}
  .primary:hover{background:var(--sage-dark)}
  .row{display:flex;gap:.6rem;margin-top:1.1rem}
  .row button{flex:1}
  .deny{background:#eef0ea;color:var(--ink)}
  .scopes{list-style:none;padding:0;margin:1rem 0}
  .scopes li{padding:.5rem .7rem;background:#eff3ea;border-radius:8px;margin-bottom:.4rem;font-size:.92rem}
  .muted{color:var(--muted);font-size:.86rem}
  .err{color:var(--danger);font-size:.9rem;margin-top:.6rem}
  .notice{background:#eaf2e6;border:1px solid #cfe0c4;color:var(--sage-dark);padding:.7rem .9rem;border-radius:9px;font-size:.9rem;margin-bottom:1rem}
  .vault{border:1px solid var(--line);border-radius:11px;padding:1rem 1.1rem;margin-bottom:.9rem;background:#fcfdfb}
  .vault h3{margin:0 0 .5rem;font-size:1.05rem;font-family:"DM Sans",sans-serif;font-weight:600}
  .field{margin:.55rem 0}
  .field .k{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.15rem}
  code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem}
  pre{background:#eef1ea;border:1px solid var(--line);border-radius:8px;padding:.6rem .7rem;overflow-x:auto;margin:.15rem 0 0;white-space:pre-wrap;word-break:break-all}
  .foot{margin-top:1.4rem;text-align:center}
  .linkbtn{background:none;border:0;color:var(--sage-dark);text-decoration:underline;cursor:pointer;font-size:.9rem;padding:0}
  form.inline{display:inline}
  .secondary{background:#eef0ea;color:var(--ink);width:100%;margin-top:1.1rem;font-weight:600}
  .secondary:hover{background:#e4e8dd}
  details{margin-top:1.1rem;border-top:1px solid var(--line);padding-top:1rem}
  details>summary{cursor:pointer;color:var(--sage-dark);font-size:.9rem;font-weight:600;list-style:none}
  details>summary::-webkit-details-marker{display:none}
  details[open]>summary{margin-bottom:.6rem}
  .qr{width:210px;max-width:100%;margin:.6rem auto;padding:.5rem;background:#fff;border:1px solid var(--line);border-radius:10px}
  .qr svg{width:100%;height:auto;display:block}
  .codegrid{list-style:none;padding:0;margin:.8rem 0;display:grid;grid-template-columns:repeat(2,1fr);gap:.5rem}
  .codegrid li{background:#eff3ea;border:1px solid var(--line);border-radius:7px;padding:.45rem;text-align:center;font-family:ui-monospace,Menlo,monospace;font-size:.92rem;letter-spacing:.03em}
  .warn{background:#faeee9;border:1px solid #e6c7ba;color:#8a3a2a;padding:.7rem .9rem;border-radius:9px;font-size:.88rem;margin:.6rem 0}
  .status{display:flex;align-items:center;gap:.5rem;font-weight:600}
  .dot{width:.6rem;height:.6rem;border-radius:999px;display:inline-block}
  .dot-on{background:var(--sage)}.dot-off{background:#b9c2ad}
  .h2row{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;margin-bottom:.4rem}
  .secret{font-family:ui-monospace,Menlo,monospace;font-size:1rem;letter-spacing:.14em;word-break:break-all;background:#eef1ea;border:1px solid var(--line);border-radius:8px;padding:.55rem .7rem;text-align:center}
  .biginput{font-size:1.15rem;padding:.75rem .8rem}
  .chips{display:flex;flex-wrap:wrap;gap:.45rem;margin-top:.4rem}
  .chips input{position:absolute;opacity:0;pointer-events:none}
  .chips label{display:inline-block;margin:0;padding:.4rem .85rem;border:1px solid var(--line);border-radius:999px;font-size:.88rem;font-weight:500;cursor:pointer;background:#fcfdfb;color:var(--ink)}
  .chips input:checked+label{background:var(--sage);border-color:var(--sage);color:#fff}
  .chips input:focus-visible+label{outline:2px solid var(--sage);outline-offset:2px}
  .check{list-style:none;padding:0;margin:.3rem 0 0}
  .check>li{border-top:1px solid var(--line)}
  .check>li:first-child{border-top:0}
  .door{display:flex;align-items:center;gap:.65rem;width:100%;background:none;border:0;padding:.62rem .15rem;font-size:.95rem;font-weight:500;font-family:inherit;color:var(--ink);cursor:pointer;text-align:left}
  .door:hover{color:var(--sage-dark)}
  .door .mark{width:1.3rem;height:1.3rem;border-radius:999px;border:1.5px solid #c3ccb8;display:inline-flex;align-items:center;justify-content:center;font-size:.72rem;flex:none;color:transparent}
  .check>li[data-done="1"] .door{color:var(--muted)}
  .check>li[data-done="1"] .door .mark{background:var(--sage);border-color:var(--sage);color:#fff}
  .door .go{margin-left:auto;color:var(--sage-dark);flex:none}
  details.checkx{margin:0;border-top:0;padding:0}
  details.checkx>.doorbody{padding:.1rem .3rem 1rem 2.1rem}
  summary.door{font-size:.95rem;font-weight:500;color:var(--ink)}
  details.checkx[open]>summary{margin-bottom:0}
  .check-foot{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;border-top:1px solid var(--line);padding-top:.7rem;margin-top:.2rem;font-size:.86rem}
  .check-foot .hide{margin-left:auto}
  ol.steps{margin:.5rem 0 .65rem;padding-left:1.35rem}
  ol.steps li{margin:.32rem 0}
  .copyrow{display:flex;gap:.5rem;align-items:stretch}
  .copyrow pre{flex:1;margin:0}
  .copybtn{flex:none;background:#eef0ea;border:1px solid var(--line);border-radius:8px;padding:.4rem .85rem;font-size:.85rem;font-weight:600;color:var(--sage-dark)}
  .copybtn:hover{background:#e4e8dd}
  ul.history{list-style:none;padding:0;margin:.3rem 0 0}
  ul.history li{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;border-top:1px solid var(--line);padding:.45rem .1rem;font-size:.9rem}
  ul.history li:first-child{border-top:0}
  ul.history .when{font-family:ui-monospace,Menlo,monospace;font-size:.84rem}
  ul.history form{margin-left:auto}
`;

// Exported for admin-ui.ts (the operator console reuses the exact page shell +
// brand styles, widening itself with its own style block).
export function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${FONT_LINK}<style>${STYLE}</style></head><body><div class="brand">Parachute</div>${inner}</body></html>`;
}

export function renderLogin(opts: { params: AuthorizeParams; csrfToken: string; error?: string }): string {
  const { params, csrfToken, error } = opts;
  return page(
    "Sign in — Parachute",
    `<h1>Sign in to Parachute</h1>
     <div class="card">
       <form method="post" action="/oauth/authorize">
         <input type="hidden" name="__action" value="login">
         <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
         ${hiddenParams(params)}
         <label for="email">Email</label>
         <input id="email" name="email" type="email" autocomplete="username" required autofocus>
         <label for="password">Password</label>
         <input id="password" name="password" type="password" autocomplete="current-password" required>
         ${error ? `<div class="err">${esc(error)}</div>` : ""}
         <button class="primary" type="submit">Sign in</button>
       </form>
     </div>`,
  );
}

export interface ConsentProps {
  params: AuthorizeParams;
  csrfToken: string;
  clientName: string;
  scopeDescriptions: Array<{ scope: string; label: string }>;
  /** When set, the vault this consent is bound to (from resource/hint). */
  lockedVault: string | null;
  /** True when an unnamed vault verb needs a vault chosen at submit time. */
  needsVaultPick: boolean;
  /**
   * The issuer's host, derived from CONFIG (deps.issuer — never request/user
   * input): the "issued by <host>" trust line so the user can verify WHERE
   * they're consenting (#42; also disambiguates staging vs production).
   */
  issuerHost: string;
}

function scopeLabel(scope: string): string {
  if (scope === "vault:read" || /^vault:[^:]+:read$/.test(scope)) return "Read your vault notes";
  if (scope === "vault:write" || /^vault:[^:]+:write$/.test(scope)) return "Create and edit your vault notes";
  if (scope === "vault:admin" || /^vault:[^:]+:admin$/.test(scope)) return "Full administrative access to your vault";
  return scope;
}

export function describeScopes(scopes: string[]): Array<{ scope: string; label: string }> {
  return scopes.map((scope) => ({ scope, label: scopeLabel(scope) }));
}

export function renderConsent(props: ConsentProps): string {
  const { params, csrfToken, clientName, scopeDescriptions, lockedVault, needsVaultPick, issuerHost } = props;
  const scopeList = scopeDescriptions
    .map((s) => `<li><strong>${esc(s.label)}</strong><br><span class="muted">${esc(s.scope)}</span></li>`)
    .join("\n");
  const vaultDisplay = lockedVault ? `<p class="muted">Vault: <strong>${esc(lockedVault)}</strong></p>` : "";
  const vaultField = lockedVault
    ? `<input type="hidden" name="vault_pick" value="${esc(lockedVault)}">`
    : needsVaultPick
      ? `<label for="vault_pick">Vault name</label>
         <input id="vault_pick" name="vault_pick" type="text" required>`
      : "";
  return page(
    "Authorize — Parachute",
    `<h1>Authorize ${esc(clientName)}</h1>
     <p class="muted" style="margin:0 0 1rem">issued by <strong>${esc(issuerHost)}</strong></p>
     <div class="card">
       <p class="muted"><strong>${esc(clientName)}</strong> is requesting access to:</p>
       <ul class="scopes">${scopeList}</ul>
       ${vaultDisplay}
       <form method="post" action="/oauth/authorize">
         <input type="hidden" name="__action" value="consent">
         <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
         ${hiddenParams(params)}
         ${vaultField}
         <div class="row">
           <button class="deny" type="submit" name="decision" value="deny">Deny</button>
           <button class="primary" type="submit" name="decision" value="approve" style="margin-top:0">Approve</button>
         </div>
       </form>
     </div>`,
  );
}

export function renderError(opts: { title: string; message: string }): string {
  return page(
    opts.title,
    `<h1>${esc(opts.title)}</h1><div class="card"><p>${esc(opts.message)}</p></div>`,
  );
}

// --- console (accounts + vaults) ------------------------------------------

/** The magic-link (passwordless) form — the primary sign-in / sign-up affordance. */
function magicForm(csrfToken: string, email: string | undefined, buttonLabel: string, error?: string): string {
  return `<form method="post" action="/auth/magic">
       <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
       <label for="email">Email</label>
       <input id="email" name="email" type="email" autocomplete="email" value="${esc(email ?? "")}" required autofocus>
       ${error ? `<div class="err">${esc(error)}</div>` : ""}
       <button class="primary" type="submit">${esc(buttonLabel)}</button>
     </form>`;
}

/** Signup — create a cloud account. Magic-link default; password in the disclosure. */
export function renderSignup(opts: { csrfToken: string; error?: string; email?: string; showPassword?: boolean }): string {
  const { csrfToken, error, email, showPassword } = opts;
  return page(
    "Create your account — Parachute",
    `<h1>Create your account</h1>
     <p class="muted" style="margin:0 0 1.1rem">A vault of your own, hosted. Free while in beta — no card needed.</p>
     <div class="card">
       ${magicForm(csrfToken, email, "Email me a sign-in link", showPassword ? undefined : error)}
       <p class="muted" style="margin:.7rem 0 0">We'll email you a link — no password to choose. It signs you in and creates your account.</p>
       <details${showPassword ? " open" : ""}>
         <summary>Use a password instead</summary>
         <form method="post" action="/signup">
           <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
           <label for="pw-email">Email</label>
           <input id="pw-email" name="email" type="email" autocomplete="username" value="${esc(email ?? "")}" required>
           <label for="password">Password</label>
           <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
           <p class="muted" style="margin:.35rem 0 0">At least 8 characters.</p>
           ${showPassword && error ? `<div class="err">${esc(error)}</div>` : ""}
           <button class="secondary" type="submit">Create account with a password</button>
         </form>
       </details>
     </div>
     <div class="foot"><span class="muted">Already have an account?</span> <a href="/login">Sign in</a></div>`,
  );
}

/** Console login (standalone, distinct from the OAuth authorize login). Magic-link default. */
export function renderConsoleLogin(opts: { csrfToken: string; error?: string; email?: string; showPassword?: boolean }): string {
  const { csrfToken, error, email, showPassword } = opts;
  return page(
    "Sign in — Parachute",
    `<h1>Sign in</h1>
     <div class="card">
       ${magicForm(csrfToken, email, "Email me a sign-in link", showPassword ? undefined : error)}
       <p class="muted" style="margin:.7rem 0 0">We'll email you a link that signs you in — no password needed.</p>
       <details${showPassword ? " open" : ""}>
         <summary>Use a password instead</summary>
         <form method="post" action="/login">
           <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
           <label for="pw-email">Email</label>
           <input id="pw-email" name="email" type="email" autocomplete="username" value="${esc(email ?? "")}" required>
           <label for="password">Password</label>
           <input id="password" name="password" type="password" autocomplete="current-password" required>
           ${showPassword && error ? `<div class="err">${esc(error)}</div>` : ""}
           <button class="secondary" type="submit">Sign in with a password</button>
         </form>
       </details>
     </div>
     <div class="foot"><span class="muted">New here?</span> <a href="/signup">Create an account</a></div>`,
  );
}

/** "Check your email" — the neutral response to a magic-link request (no enumeration). */
export function renderMagicSent(opts: { email: string }): string {
  return page(
    "Check your email — Parachute",
    `<h1>Check your email</h1>
     <div class="card">
       <p>If <strong>${esc(opts.email)}</strong> has (or can have) a Parachute account, a sign-in link is on its way.</p>
       <p class="muted">The link works once and expires in 10 minutes. You can close this tab — open the link from your email to continue.</p>
     </div>
     <div class="foot"><a href="/login">← Back to sign in</a></div>`,
  );
}

/** The TOTP second-factor prompt after primary auth, when 2FA is enabled. */
export function renderLogin2fa(opts: { csrfToken: string; error?: string }): string {
  const { csrfToken, error } = opts;
  return page(
    "Two-factor — Parachute",
    `<h1>Enter your code</h1>
     <div class="card">
       <form method="post" action="/login/2fa">
         <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
         <label for="code">Authentication code</label>
         <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" required autofocus>
         <p class="muted" style="margin:.35rem 0 0">From your authenticator app, or a backup code.</p>
         ${error ? `<div class="err">${esc(error)}</div>` : ""}
         <button class="primary" type="submit">Verify</button>
       </form>
     </div>`,
  );
}

// --- security (TOTP 2FA + password) ---------------------------------------

export type SecurityState =
  | { kind: "overview"; enrolled: boolean; enrolledAt: string | null; backupRemaining: number }
  | { kind: "enrolling"; qrSvg: string; secret: string }
  | { kind: "backup-codes"; codes: string[] };

export interface SecurityProps {
  csrfToken: string;
  email: string;
  hasPassword: boolean;
  state: SecurityState;
  error?: string;
  notice?: string;
}

function passwordSection(csrfToken: string, hasPassword: boolean): string {
  return `<div class="card">
     <h2>${hasPassword ? "Change your password" : "Add a password"}</h2>
     <p class="muted" style="margin:.1rem 0 .3rem">${
       hasPassword
         ? "Update the optional password you sign in with."
         : "Optional — a magic link already signs you in. Add a password if you'd like a second way in."
     }</p>
     <form method="post" action="/console/security">
       <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
       <input type="hidden" name="action" value="set-password">
       <label for="new-password">${hasPassword ? "New password" : "Password"}</label>
       <input id="new-password" name="password" type="password" autocomplete="new-password" minlength="8" required>
       <p class="muted" style="margin:.35rem 0 0">At least 8 characters.</p>
       <button class="secondary" type="submit">${hasPassword ? "Update password" : "Set password"}</button>
     </form>
   </div>`;
}

export function renderSecurity(props: SecurityProps): string {
  const { csrfToken, email, hasPassword, state, error, notice } = props;
  const banner = `${notice ? `<div class="notice">${esc(notice)}</div>` : ""}${error ? `<div class="err" style="margin-bottom:1rem">${esc(error)}</div>` : ""}`;

  if (state.kind === "enrolling") {
    return page(
      "Set up two-factor — Parachute",
      `<div class="h2row"><h1 style="margin:0">Set up two-factor</h1><a href="/console/security">Cancel</a></div>
       ${banner}
       <div class="card">
         <p>1. Scan this QR code with your authenticator app (Google Authenticator, 1Password, Authy, …):</p>
         <div class="qr" aria-label="TOTP QR code">${state.qrSvg}</div>
         <p class="muted">Can't scan? Enter this key manually:</p>
         <div class="secret" data-testid="totp-secret">${esc(state.secret)}</div>
         <form method="post" action="/console/security" style="margin-top:1.1rem">
           <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
           <input type="hidden" name="action" value="confirm">
           <input type="hidden" name="secret" value="${esc(state.secret)}">
           <label for="code">2. Enter the 6-digit code to confirm</label>
           <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" required autofocus>
           <button class="primary" type="submit">Confirm and enable</button>
         </form>
       </div>`,
    );
  }

  if (state.kind === "backup-codes") {
    const list = state.codes.map((c) => `<li>${esc(c)}</li>`).join("");
    return page(
      "Backup codes — Parachute",
      `<h1>Two-factor is on</h1>
       ${banner}
       <div class="card">
         <div class="warn"><strong>Save these backup codes now.</strong> Each works once if you lose your authenticator. They're shown only this once.</div>
         <ul class="codegrid" data-testid="backup-codes">${list}</ul>
         <a class="primary" href="/console/security" style="display:block;text-align:center;text-decoration:none;padding:.62rem 1rem">I've saved my codes</a>
       </div>`,
    );
  }

  // overview
  const twoFactor = state.enrolled
    ? `<div class="card">
         <div class="status"><span class="dot dot-on"></span>Two-factor authentication is <strong>on</strong>${
           state.enrolledAt ? ` (since ${esc(state.enrolledAt.slice(0, 10))})` : ""
         }.</div>
         <p class="muted" style="margin:.5rem 0 0">You have <strong data-testid="backup-remaining">${state.backupRemaining}</strong> backup code${state.backupRemaining === 1 ? "" : "s"} left.</p>
         <form method="post" action="/console/security" style="margin-top:1rem">
           <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
           <input type="hidden" name="action" value="disable">
           <label for="code">Turn off — enter a current code to confirm</label>
           <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="123456 or a backup code" required>
           <button class="secondary" type="submit">Turn off two-factor</button>
         </form>
       </div>`
    : `<div class="card">
         <div class="status"><span class="dot dot-off"></span>Two-factor authentication is <strong>off</strong>.</div>
         <p class="muted" style="margin:.5rem 0 0">Require a 6-digit code from your authenticator app in addition to your sign-in link or password.</p>
         <form method="post" action="/console/security" style="margin-top:1rem">
           <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
           <input type="hidden" name="action" value="start">
           <button class="primary" type="submit">Set up two-factor</button>
         </form>
       </div>`;

  return page(
    "Security — Parachute",
    `<div class="h2row"><h1 style="margin:0">Security</h1><a href="/console">← Vaults</a></div>
     <p class="muted" style="margin:.15rem 0 1.2rem">${esc(email)}</p>
     ${banner}
     ${twoFactor}
     ${passwordSection(csrfToken, hasPassword)}`,
  );
}

/** One restore point in the History section (Wave 4e). */
export interface VaultHistoryEntry {
  /** The snapshot's R2 key — the restore form's `key` field. */
  key: string;
  /** ISO-8601 taken-at (rendered as "YYYY-MM-DD HH:MM UTC"). */
  takenAt: string;
  bytes: number;
  ranks: string[];
}

/**
 * The card's History section: paid plans get restore points + the
 * restore-to-a-new-vault doors; free plans get the teaser line (their
 * internal rolling weekly is never surfaced — it's ours, not theirs).
 */
export type VaultHistory =
  | { kind: "restore-points"; entries: VaultHistoryEntry[] }
  | { kind: "teaser" };

export interface ConsoleVaultCard {
  name: string;
  /** Notes-PWA connect deep link (`/?add=<vault URL>`) — the card's primary action. */
  notesUrl: string;
  /** Notes-PWA connect deep link that lands on the new-note editor (`/new`). */
  writeUrl: string;
  /** Notes-PWA connect deep link that lands on /import after connecting. */
  importUrl: string;
  mcpUrl: string;
  connectCmd: string;
  /**
   * Latest recorded storage usage (the daily rollup's `vault_usage` row):
   * set → "Using X of Y"; null → no row yet ("usage appears within a day");
   * undefined → caller didn't look it up (non-render paths).
   */
  usage?: { usedBytes: number; day: string } | null;
  /** Snapshot history (Wave 4e); undefined → caller didn't look it up. */
  history?: VaultHistory;
}

/** State for the getting-started checklist card (null → don't render it). */
export interface ConsoleChecklistProps {
  /** Item keys already done (checklist.ts CHECKLIST_ITEMS). */
  done: ReadonlySet<string>;
  /** The vault the checklist doors open — the user's first vault. */
  vault: ConsoleVaultCard;
  /** Render the quiet "add 2FA" footer line (TOTP not enrolled). */
  showTwoFactorNudge: boolean;
}

/** First-run form values preserved across a validation-error re-render. */
export interface FirstRunValues {
  name?: string;
  notesApp?: string;
  firstNote?: string;
}

export interface ConsoleProps {
  email: string;
  vaults: ConsoleVaultCard[];
  csrfToken: string;
  error?: string;
  notice?: string;
  /** Non-null → render the checklist card above the vault cards. */
  checklist?: ConsoleChecklistProps | null;
  /** Checklist dismissed → render the quiet "Show setup guide" footer link. */
  showChecklistRestore?: boolean;
  /** Zero-vault re-render values (the first-run hero preserves answers). */
  firstRun?: FirstRunValues;
  /** The user's plan — the header line + the at-cap create card render from plans.ts. */
  plan: PlanId;
  /**
   * Across-vaults total of the latest recorded usage rows (bytes). Null until
   * the first rollup lands — the plan line then omits the usage segment
   * rather than claiming a misleading zero.
   */
  totalUsedBytes?: number | null;
  /** At/over the plan's vault count → the create form yields to the at-cap note. */
  atVaultCap: boolean;
  /** Operator account → the quiet "Admin" header link (/admin). */
  isOperator?: boolean;
  /**
   * Stripe config present (billing-config.ts) → free users get the Upgrade
   * buttons, paid users the Manage-billing door. False (today's deploy,
   * pre-keys) → the teaser stays and no billing UI renders at all.
   */
  billingConfigured?: boolean;
  /** The user has a Stripe customer (false for comped parachute accounts). */
  hasBillingAccount?: boolean;
}

/**
 * The Connect-your-AI walkthrough — Claude first (numbered doors, not a
 * manual), then the "any MCP client" line, with the CLI one-liner as the nerd
 * footnote. Shared between each vault card's disclosure and checklist item ③
 * so the two can never drift.
 */
function connectAiContent(v: ConsoleVaultCard): string {
  return `<ol class="steps">
      <li>Open <a href="https://claude.ai" target="_blank" rel="noopener">claude.ai</a> and go to <strong>Settings → Connectors</strong></li>
      <li>Choose <strong>Add custom connector</strong></li>
      <li>Paste your vault&#39;s URL and connect:</li>
    </ol>
    <div class="copyrow"><pre>${esc(v.mcpUrl)}</pre><button type="button" class="copybtn" data-copy="${esc(v.mcpUrl)}">Copy</button></div>
    <p class="muted" style="margin:.65rem 0 0"><strong>Other AIs:</strong> that same URL works in any MCP-compatible client — paste it wherever your AI asks for an MCP server.</p>
    <p class="muted" style="margin:.45rem 0 0">Command line: <code>${esc(v.connectCmd)}</code></p>`;
}

/** iOS/Android add-to-home-screen steps for the Notes PWA (checklist item ④). */
function addToPhoneContent(v: ConsoleVaultCard): string {
  return `<p class="muted" style="margin:.15rem 0 .45rem">Parachute Notes installs straight from the browser — no app store.</p>
    <p style="margin:.3rem 0;font-size:.92rem"><strong>iPhone / iPad:</strong> open <a href="${esc(v.notesUrl)}" target="_blank" rel="noopener">notes.parachute.computer</a> in Safari → tap <strong>Share</strong> → <strong>Add to Home Screen</strong>.</p>
    <p style="margin:.3rem 0;font-size:.92rem"><strong>Android:</strong> open it in Chrome → menu <strong>⋮</strong> → <strong>Add to Home screen</strong> (or <strong>Install app</strong>).</p>`;
}

/** "2026-07-03T04:00:12.345Z" → "2026-07-03 04:00 UTC" (deterministic, tz-free). */
function humanSnapshotDate(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** The highest GFS rank a snapshot carries — the one-word label on its row. */
function topRank(ranks: string[]): string {
  if (ranks.includes("monthly")) return "monthly";
  if (ranks.includes("weekly")) return "weekly";
  return "daily";
}

/**
 * The History disclosure (Wave 4e). Paid: restore points, newest first, each
 * with a "Restore to a new vault" door — plus the standing caveats (restore
 * never touches this vault; v1 snapshots carry no attachment binaries). Free:
 * the plan teaser — the internal DR snapshot is deliberately not mentioned.
 */
function historySection(v: ConsoleVaultCard, csrfToken: string): string {
  if (!v.history) return "";
  if (v.history.kind === "teaser") {
    return `<details data-testid="vault-history">
      <summary>History</summary>
      <p class="muted" style="margin:.2rem 0 0" data-testid="history-teaser">Nightly restore points — 14 daily, 8 weekly, and 12 monthly snapshots of this vault — come with the Parachute plan.</p>
    </details>`;
  }
  const { entries } = v.history;
  const body =
    entries.length === 0
      ? `<p class="muted" style="margin:.2rem 0 0">Nightly snapshots begin within a day — restore points will appear here.</p>`
      : `<p class="muted" style="margin:.2rem 0 .5rem">Restoring never touches this vault — it creates a new one from the snapshot. Heads up: v1 snapshots don't include attachment files, so notes and their attachment references restore, the files themselves don't.</p>
    <ul class="history">
      ${entries
        .map(
          (e) => `<li data-testid="restore-point">
        <span class="when">${esc(humanSnapshotDate(e.takenAt))}</span>
        <span class="muted">${esc(formatUsageBytes(e.bytes))} &middot; ${esc(topRank(e.ranks))}</span>
        <form class="inline" method="post" action="/console/vaults/restore">
          <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
          <input type="hidden" name="vault" value="${esc(v.name)}">
          <input type="hidden" name="key" value="${esc(e.key)}">
          <button class="linkbtn" type="submit">Restore to a new vault</button>
        </form>
      </li>`,
        )
        .join("\n")}
    </ul>`;
  return `<details data-testid="vault-history">
      <summary>History</summary>
      ${body}
    </details>`;
}

function vaultCard(v: ConsoleVaultCard, csrfToken: string, planCapBytes: number): string {
  // Storage line: the latest rollup row, human units against the plan cap
  // (v1: each vault's cap IS the plan total — plans.ts). No row yet (fresh
  // vault, or the nightly rollup hasn't reached it) → the honest "within a
  // day" line, never a made-up zero.
  const usageLine = v.usage
    ? `Using ${formatUsageBytes(v.usage.usedBytes)} of ${formatPlanBytes(planCapBytes)}`
    : "Usage appears within a day.";
  // Primary door: the Notes PWA connect deep-link. The Claude walkthrough +
  // MCP coordinates stay one disclosure below — demoted from the headline,
  // not removed.
  return `<div class="vault">
    <h3>${esc(v.name)}</h3>
    <p class="muted" data-testid="vault-usage" style="margin:.1rem 0 0;font-size:.85rem">${esc(usageLine)}</p>
    <a class="primary" href="${esc(v.notesUrl)}" target="_blank" rel="noopener" style="display:block;text-align:center;text-decoration:none;padding:.62rem 1rem;margin-top:.6rem">Open your notes &rarr;</a>
    <details>
      <summary>Connect your AI</summary>
      ${connectAiContent(v)}
    </details>
    <details>
      <summary>Building a surface?</summary>
      <p class="muted" style="margin:.2rem 0 0">Seed this vault with the <strong>Surface Starter</strong> guide — a living note that walks your connected AI through building a custom surface (UI) over the vault. It's not seeded by default; adding it again is harmless.</p>
      <form method="post" action="/console/packs">
        <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
        <input type="hidden" name="vault" value="${esc(v.name)}">
        <input type="hidden" name="pack" value="surface-starter">
        <button class="secondary" type="submit" style="margin-top:.7rem">Add the Surface Starter guide</button>
      </form>
    </details>
    ${historySection(v, csrfToken)}
  </div>`;
}

/**
 * Browser-hint pattern for the vault-name input. Chrome compiles `pattern`
 * with the RegExp `v` flag, which REJECTS an unescaped hyphen inside a
 * character class — `[a-z0-9-]` throws at compile time and the attribute is
 * silently ignored (console error). The `\\` here emits a literal `\-` into
 * the HTML. Cosmetic only: vaults.ts server validation is the real gate.
 */
const VAULT_NAME_PATTERN = "[a-z0-9][a-z0-9\\-]{1,62}";

// --- the getting-started checklist card -------------------------------------

/** A checklist door that navigates: POST marks it done, then 302s onward. */
function checklistDoor(item: string, label: string, done: boolean, csrfToken: string, extra = ""): string {
  return `<li data-item="${esc(item)}" data-done="${done ? "1" : "0"}">
    <form method="post" action="/console/checklist" target="_blank">
      <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
      <input type="hidden" name="item" value="${esc(item)}">
      <button class="door" type="submit"><span class="mark">&#10003;</span>${esc(label)}${extra}<span class="go">&rarr;</span></button>
    </form>
  </li>`;
}

/** A checklist item that expands in place (marked done on first open, via JS). */
function checklistExpand(item: string, label: string, done: boolean, body: string): string {
  return `<li data-item="${esc(item)}" data-done="${done ? "1" : "0"}">
    <details class="checkx" data-check="${esc(item)}">
      <summary class="door"><span class="mark">&#10003;</span>${esc(label)}<span class="go">+</span></summary>
      <div class="doorbody">${body}</div>
    </details>
  </li>`;
}

/**
 * The getting-started checklist: five doors, each one an action — never just
 * an instruction. Dismissible ("hide this", persisted), never a modal wall.
 * The 2FA nudge rides the footer so it dismisses with the card; 2FA remains a
 * surfaced option, not a gate.
 */
function checklistCard(c: ConsoleChecklistProps, csrfToken: string): string {
  const d = (item: string) => c.done.has(item);
  const optional = `<span class="muted" style="font-weight:400;margin-left:.35rem">(optional)</span>`;
  return `<div class="card" data-testid="checklist">
    <h2 style="margin-bottom:.1rem">Getting started</h2>
    <p class="muted" style="margin:0 0 .3rem">Five small steps and this place is yours.</p>
    <ul class="check">
      ${checklistDoor("open-notes", "Open your notes", d("open-notes"), csrfToken)}
      ${checklistDoor("write-note", "Write a note", d("write-note"), csrfToken)}
      ${checklistExpand("connect-ai", "Connect your AI", d("connect-ai"), connectAiContent(c.vault))}
      ${checklistExpand("add-phone", "Add Notes to your phone", d("add-phone"), addToPhoneContent(c.vault))}
      ${checklistDoor("import-notes", "Import your old notes", d("import-notes"), csrfToken, optional)}
    </ul>
    <div class="check-foot">
      ${c.showTwoFactorNudge ? `<span class="muted">Secure your account: <a href="/console/security">add 2FA &rarr;</a></span>` : ""}
      <form class="inline hide" method="post" action="/console/checklist">
        <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
        <input type="hidden" name="item" value="hidden">
        <button class="linkbtn" type="submit" style="color:var(--muted)">hide this</button>
      </form>
    </div>
  </div>`;
}

// --- first-run (zero vaults) -------------------------------------------------

/**
 * The first-run hero: one warm card — name your vault (the only required
 * field) plus two OPTIONAL research questions. The questions never gate
 * creation; skipping both is a fine answer.
 */
function firstRunHero(csrfToken: string, values: FirstRunValues, error?: string): string {
  const chips = NOTES_APP_OPTIONS.map(
    ({ value, label }) =>
      `<span><input type="radio" id="na-${esc(value)}" name="notes_app" value="${esc(value)}"${
        values.notesApp === value ? " checked" : ""
      }><label for="na-${esc(value)}">${esc(label)}</label></span>`,
  ).join("\n");
  return `<p style="margin:.4rem 0 1.1rem">Welcome. Your vault is where your notes — and everything you want your AI to remember — will live, under a name you choose. It's yours: open format, export anytime.</p>
    <div class="card">
      <form method="post" action="/console/vaults">
        <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
        <label for="name" style="font-size:.95rem">Vault name</label>
        <input class="biginput" id="name" name="name" type="text" placeholder="e.g. field-notes" pattern="${VAULT_NAME_PATTERN}" value="${esc(values.name ?? "")}" required autofocus>
        <p class="muted" style="margin:.35rem 0 0">Lowercase letters, numbers, and hyphens. 2–63 characters.</p>
        <label style="margin-top:1.3rem">What do you take notes in today? <span class="muted" style="font-weight:400">(optional)</span></label>
        <div class="chips">${chips}</div>
        <label for="first_note" style="margin-top:1.3rem">What's the first thing you want your AI to remember? <span class="muted" style="font-weight:400">(optional)</span></label>
        <input id="first_note" name="first_note" type="text" maxlength="500" placeholder="e.g. I'm rebuilding my garden this summer" value="${esc(values.firstNote ?? "")}">
        <p class="muted" style="margin:.35rem 0 0">We'll tuck it into your new vault as your first note.</p>
        ${error ? `<div class="err">${esc(error)}</div>` : ""}
        <button class="primary" type="submit">Create my vault</button>
      </form>
    </div>`;
}

/**
 * Console page JS — deliberately tiny (this file is otherwise zero-JS):
 * clipboard for the MCP-URL copy buttons, and marking an expandable checklist
 * item done on first open. Both degrade quietly without JS (the URL is
 * selectable text; the disclosure still opens — it just isn't recorded).
 */
function consoleScript(csrfToken: string): string {
  return `<script>(function(){
  var CSRF=${JSON.stringify(csrfToken)};
  document.addEventListener("click",function(e){
    var b=e.target&&e.target.closest?e.target.closest("[data-copy]"):null;
    if(!b)return;
    navigator.clipboard.writeText(b.getAttribute("data-copy")).then(function(){
      var t=b.textContent;b.textContent="Copied \\u2713";
      setTimeout(function(){b.textContent=t;},1600);
    });
  });
  var ds=document.querySelectorAll("details[data-check]");
  for(var i=0;i<ds.length;i++)(function(d){
    d.addEventListener("toggle",function(){
      if(!d.open||d.getAttribute("data-sent"))return;
      d.setAttribute("data-sent","1");
      fetch("/console/checklist",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({__csrf:CSRF,item:d.getAttribute("data-check")}).toString()});
    });
  })(ds[i]);
})();</script>`;
}

/**
 * The console: first-run hero when no vault exists yet; otherwise the
 * getting-started checklist (until dismissed) + vault cards + create form.
 */
export function renderConsole(props: ConsoleProps): string {
  const {
    email,
    vaults,
    csrfToken,
    error,
    notice,
    checklist,
    showChecklistRestore,
    firstRun,
    plan,
    totalUsedBytes,
    atVaultCap,
    isOperator,
    billingConfigured,
    hasBillingAccount,
  } = props;
  // Plan display. The across-vaults usage total (latest rollup rows) rides the
  // plan line. Billing doors (Wave 4d) render only while billing is CONFIGURED
  // (billing-config.ts): free users get the two Upgrade buttons (hosted
  // Checkout, POST /billing/checkout), paid users with a real Stripe customer
  // get Manage billing (the portal, POST /billing/portal — comped accounts
  // have no customer, so no door). Unconfigured — today's deploy — free users
  // see the copy-only teaser exactly as before.
  const usageHtml =
    totalUsedBytes != null
      ? ` <span data-testid="usage-total">&middot; Using ${esc(formatUsageBytes(totalUsedBytes))}</span>`
      : "";
  const upgradeHtml =
    plan === "free" && billingConfigured
      ? `<form class="inline" method="post" action="/billing/checkout" data-testid="upgrade-billing" style="margin-left:.35rem">
           <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
           <span style="opacity:.85">&middot; ${esc(PLAN_SPECS.parachute.label)}: ${PLAN_SPECS.parachute.vault_count} vaults, ${esc(formatPlanBytes(PLAN_SPECS.parachute.total_bytes))} —</span>
           <button class="linkbtn" type="submit" name="interval" value="monthly">Upgrade &mdash; ${esc(PARACHUTE_PRICE_MONTHLY_LABEL)}</button>
           <span class="muted">or</span>
           <button class="linkbtn" type="submit" name="interval" value="yearly">${esc(PARACHUTE_PRICE_YEARLY_LABEL)}</button>
         </form>`
      : "";
  const manageBillingHtml =
    plan === "parachute" && billingConfigured && hasBillingAccount
      ? ` <form class="inline" method="post" action="/billing/portal" data-testid="manage-billing">
           <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
           <span style="opacity:.75">&middot;</span> <button class="linkbtn" type="submit">Manage billing</button>
         </form>`
      : "";
  const teaserHtml =
    plan === "free" && !billingConfigured
      ? ` <span style="opacity:.75">&middot; ${esc(parachuteTeaser())}</span>`
      : "";
  const planHtml = `${esc(planLine(plan))}${usageHtml}${teaserHtml}${upgradeHtml}${manageBillingHtml}`;
  // The Admin link renders ONLY for operators — everyone else never learns the
  // route exists (it answers 404 to them anyway; admin.ts).
  const header = (title: string) => `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:1rem">
       <h1 style="margin:0">${esc(title)}</h1>
       <span style="display:flex;gap:1rem;align-items:baseline">${isOperator ? `<a href="/admin" data-testid="admin-link">Admin</a>` : ""}<a href="/console/security">Security</a>
       <form class="inline" method="post" action="/logout"><input type="hidden" name="__csrf" value="${esc(csrfToken)}"><button class="linkbtn" type="submit">Sign out</button></form></span>
     </div>
     <p class="muted" style="margin:.15rem 0 .2rem">${esc(email)}</p>
     <p class="muted" data-testid="plan-line" style="margin:0 0 1.2rem;font-size:.88rem">${planHtml}</p>`;

  if (vaults.length === 0) {
    return page(
      "Console — Parachute",
      `${header("Name your vault")}
       ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
       ${firstRunHero(csrfToken, firstRun ?? {}, error)}`,
    );
  }

  const list = vaults.map((v) => vaultCard(v, csrfToken, PLAN_SPECS[plan].total_bytes)).join("\n");
  // At the plan's vault cap the create form yields to the friendly note (the
  // POST handler enforces regardless — this keeps the door honest). An error
  // still renders inside whichever card is shown.
  const createCard = atVaultCap
    ? `<div class="card" data-testid="vault-cap">
       <h2>Create a vault</h2>
       <p class="muted" style="margin:.35rem 0 0">${esc(vaultCapMessage(plan))}</p>
       ${error ? `<div class="err">${esc(error)}</div>` : ""}
     </div>`
    : `<div class="card">
       <h2>Create a vault</h2>
       <form method="post" action="/console/vaults">
         <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
         <label for="name">Vault name</label>
         <input id="name" name="name" type="text" placeholder="e.g. field-notes" pattern="${VAULT_NAME_PATTERN}" required>
         <p class="muted" style="margin:.35rem 0 0">Lowercase letters, numbers, and hyphens. 2–63 characters.</p>
         ${error ? `<div class="err">${esc(error)}</div>` : ""}
         <button class="primary" type="submit">Create vault</button>
       </form>
     </div>`;
  // The dismissed checklist's way back: a quiet footer link, never a banner —
  // guidance stays reachable without ever re-imposing itself.
  const restoreFoot = showChecklistRestore
    ? `<div class="foot"><form class="inline" method="post" action="/console/checklist/restore">
         <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
         <button class="linkbtn" type="submit" style="color:var(--muted)" data-testid="show-setup-guide">Show setup guide</button>
       </form></div>`
    : "";
  return page(
    "Console — Parachute",
    `${header("Your vaults")}
     ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
     ${checklist ? checklistCard(checklist, csrfToken) : ""}
     ${list}
     ${createCard}
     ${restoreFoot}
     ${consoleScript(csrfToken)}`,
  );
}
