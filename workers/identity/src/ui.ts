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

const STYLE = `
  body{font-family:system-ui,-apple-system,sans-serif;max-width:26rem;margin:4rem auto;padding:0 1.25rem;color:#1a1a1a;line-height:1.5}
  h1{font-size:1.35rem;margin:0 0 1rem}
  .card{border:1px solid #e3e3e3;border-radius:12px;padding:1.5rem}
  label{display:block;font-size:.85rem;font-weight:600;margin:.75rem 0 .25rem}
  input[type=email],input[type=password],input[type=text]{width:100%;padding:.55rem .65rem;border:1px solid #ccc;border-radius:8px;font-size:1rem;box-sizing:border-box}
  button{font-size:1rem;padding:.6rem 1rem;border-radius:8px;border:0;cursor:pointer}
  .primary{background:#111;color:#fff;width:100%;margin-top:1rem}
  .row{display:flex;gap:.5rem;margin-top:1rem}
  .row button{flex:1}
  .deny{background:#f2f2f2;color:#333}
  .scopes{list-style:none;padding:0;margin:1rem 0}
  .scopes li{padding:.4rem .6rem;background:#f6f6f6;border-radius:6px;margin-bottom:.35rem;font-size:.9rem}
  .muted{color:#666;font-size:.85rem}
  .err{color:#b00020;font-size:.9rem;margin-top:.5rem}
`;

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${inner}</body></html>`;
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
