/**
 * Server-rendered login + consent + error views for /oauth/authorize. Minimal
 * self-contained HTML (no external assets — CSP-safe), forms POST back to
 * /oauth/authorize. Kept deliberately small: this is the human surface, not the
 * wire contract.
 */

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

function esc(s: string): string {
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
`;

function page(title: string, inner: string): string {
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
  const { params, csrfToken, clientName, scopeDescriptions, lockedVault, needsVaultPick } = props;
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

/** Signup — create a cloud account. Posts to /signup. */
export function renderSignup(opts: { csrfToken: string; error?: string; email?: string }): string {
  const { csrfToken, error, email } = opts;
  return page(
    "Create your account — Parachute",
    `<h1>Create your account</h1>
     <p class="muted" style="margin:0 0 1.1rem">A vault of your own, hosted. Free while in beta — no card needed.</p>
     <div class="card">
       <form method="post" action="/signup">
         <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
         <label for="email">Email</label>
         <input id="email" name="email" type="email" autocomplete="username" value="${esc(email ?? "")}" required autofocus>
         <label for="password">Password</label>
         <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
         <p class="muted" style="margin:.35rem 0 0">At least 8 characters.</p>
         ${error ? `<div class="err">${esc(error)}</div>` : ""}
         <button class="primary" type="submit">Create account</button>
       </form>
     </div>
     <div class="foot"><span class="muted">Already have an account?</span> <a href="/login">Sign in</a></div>`,
  );
}

/** Console login (standalone, distinct from the OAuth authorize login). */
export function renderConsoleLogin(opts: { csrfToken: string; error?: string; email?: string }): string {
  const { csrfToken, error, email } = opts;
  return page(
    "Sign in — Parachute",
    `<h1>Sign in</h1>
     <div class="card">
       <form method="post" action="/login">
         <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
         <label for="email">Email</label>
         <input id="email" name="email" type="email" autocomplete="username" value="${esc(email ?? "")}" required autofocus>
         <label for="password">Password</label>
         <input id="password" name="password" type="password" autocomplete="current-password" required>
         ${error ? `<div class="err">${esc(error)}</div>` : ""}
         <button class="primary" type="submit">Sign in</button>
       </form>
     </div>
     <div class="foot"><span class="muted">New here?</span> <a href="/signup">Create an account</a></div>`,
  );
}

export interface ConsoleVaultCard {
  name: string;
  mcpUrl: string;
  restUrl: string;
  connectCmd: string;
}

export interface ConsoleProps {
  email: string;
  vaults: ConsoleVaultCard[];
  csrfToken: string;
  error?: string;
  notice?: string;
}

function vaultCard(v: ConsoleVaultCard): string {
  return `<div class="vault">
    <h3>${esc(v.name)}</h3>
    <div class="field"><div class="k">Connect Claude Code</div><pre>${esc(v.connectCmd)}</pre></div>
    <div class="field"><div class="k">MCP endpoint</div><pre>${esc(v.mcpUrl)}</pre></div>
    <div class="field"><div class="k">REST base</div><pre>${esc(v.restUrl)}</pre></div>
  </div>`;
}

/** The console: my vaults + a create form + per-vault connect cards. */
export function renderConsole(props: ConsoleProps): string {
  const { email, vaults, csrfToken, error, notice } = props;
  const list =
    vaults.length > 0
      ? vaults.map(vaultCard).join("\n")
      : `<p class="muted">No vaults yet. Create your first one below.</p>`;
  return page(
    "Console — Parachute",
    `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:1rem">
       <h1 style="margin:0">Your vaults</h1>
       <form class="inline" method="post" action="/logout"><input type="hidden" name="__csrf" value="${esc(csrfToken)}"><button class="linkbtn" type="submit">Sign out</button></form>
     </div>
     <p class="muted" style="margin:.15rem 0 1.2rem">${esc(email)}</p>
     ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
     ${list}
     <div class="card">
       <h2>Create a vault</h2>
       <form method="post" action="/console/vaults">
         <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
         <label for="name">Vault name</label>
         <input id="name" name="name" type="text" placeholder="e.g. field-notes" pattern="[a-z0-9][a-z0-9-]{1,62}" required>
         <p class="muted" style="margin:.35rem 0 0">Lowercase letters, numbers, and hyphens. 2–63 characters.</p>
         ${error ? `<div class="err">${esc(error)}</div>` : ""}
         <button class="primary" type="submit">Create vault</button>
       </form>
     </div>`,
  );
}
