/**
 * Server-rendered login + consent + error views for /oauth/authorize. Minimal
 * self-contained HTML (no external assets — CSP-safe), forms POST back to
 * /oauth/authorize. Kept deliberately small: this is the human surface, not the
 * wire contract.
 */
// Plan copy renders from plans.ts (the single source of truth for
// entitlements + display strings) — the console can never drift from it.
import {
  PAID_TIERS,
  PLAN_SPECS,
  TIER_PRICE_LABEL,
  type PaidTier,
  type PlanId,
  formatPlanBytes,
  formatUsageBytes,
  isPaidTier,
  planLine,
  planTotalBytes,
  tierCapSummary,
  tierIntervalPricing,
  trialBannerLine,
  vaultCapMessage,
} from "./plans.ts";
import { type BillingInterval } from "./billing-config.ts";
import { NONCE_ATTR } from "./oauth-shared.ts";

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

// Brand: system font stacks (--font-serif display, --font-round chrome,
// --font-body copy) — no webfont download, matching the parachute.computer
// brand decision to retire Google Fonts (brand-tokens.md §2). This also removes
// the two third-party font requests that used to sit on the auth surface.
// A warm paper ground with a coral accent; see the :root token block below.
const STYLE = `
  :root{
    /* fonts — brand system stacks, no webfont download (brand-tokens.md §2:
       "Fonts are system stacks... Google Fonts retired"), copied verbatim */
    --font-serif:ui-serif,"New York","Iowan Old Style",Georgia,"Times New Roman",serif;
    --font-round:ui-rounded,"SF Pro Rounded","Arial Rounded MT Bold","Hiragino Maru Gothic ProN",Quicksand,system-ui,sans-serif;
    --font-body:-apple-system,system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Monaco,"Cascadia Code",monospace;
    /* grounds + ink — warm paper family (brand §1) */
    --bg:#fdfaf4;--card:#ffffff;--ink:#2a2521;--muted:#6b6459;--line:#ece5d8;--line-2:#e2d9c8;
    /* near-white utility fills — warm neutrals in the paper family */
    --field:#fdfbf5;--fill:#f3ecdd;--fill-hover:#ece3d1;--fill-2:#f7f1e6;--code-bg:#f5efe2;
    /* accent family — coral (brand §1): --accent/-strong = button bg + hover
       (white text, 4.97:1), --accent-link = coral text on light (AA),
       --accent-bright = LARGE decorative only (#e05d3c — never white text on it),
       --accent-soft* = coral-soft badge bg / border / coral-ink text */
    --accent:#bf4a2a;--accent-strong:#a5401f;--accent-link:#bf4a2a;--accent-bright:#e05d3c;
    --accent-soft:#fbe4d9;--accent-soft-line:#f2ccbc;--accent-soft-ink:#8f3417;
    /* semantic — danger/warn kept (brand has no danger token yet, §1 gap) */
    --danger:#a5372b;--warn-bg:#faeee9;--warn-line:#e6c7ba;--warn-ink:#8a3a2a;
    --dot-off:#cdbfa8;--mark-line:#d8ccb6;
    /* elevation — warm ink-tinted shadows (brand §3, byte-identical from the doc) */
    --shadow-soft:0 10px 30px rgba(60,45,30,.08);--shadow-lift:0 18px 44px rgba(60,45,30,.12);
    /* radii (the 7-14px cluster + the ecosystem pill) */
    --radius-card:14px;--radius-panel:11px;--radius-media:10px;--radius-control:9px;--radius-chip:8px;--radius-code:7px;--pill:999px;
  }
  *{box-sizing:border-box}
  body{font-family:var(--font-body);background:var(--bg);max-width:30rem;margin:0 auto;padding:3.5rem 1.25rem;color:var(--ink);line-height:1.55}
  a{color:var(--accent-link)}
  .brand{font-family:var(--font-serif);font-size:1.15rem;color:var(--accent-link);letter-spacing:.01em;margin:0 0 1.5rem;text-align:center}
  h1{font-family:var(--font-serif);font-weight:400;font-size:1.9rem;line-height:1.15;margin:0 0 .35rem}
  h2{font-family:var(--font-serif);font-weight:400;font-size:1.3rem;margin:0 0 .5rem}
  .card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-card);padding:1.6rem;margin-bottom:1.1rem;box-shadow:var(--shadow-soft)}
  label{display:block;font-family:var(--font-round);font-size:.82rem;font-weight:600;margin:.85rem 0 .3rem;color:var(--ink)}
  input[type=email],input[type=password],input[type=text]{width:100%;padding:.6rem .7rem;border:1px solid var(--line-2);border-radius:var(--radius-control);font-size:1rem;background:var(--field);font-family:inherit}
  input:focus{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent)}
  button{font-size:1rem;font-family:var(--font-round);padding:.62rem 1rem;border-radius:var(--radius-control);border:0;cursor:pointer}
  .primary{background:var(--accent);color:#fff;width:100%;margin-top:1.1rem;font-weight:600;border-radius:var(--pill)}
  .primary:hover{background:var(--accent-strong)}
  .row{display:flex;gap:.6rem;margin-top:1.1rem}
  .row button{flex:1}
  .deny{background:var(--fill);color:var(--ink);border-radius:var(--pill)}
  .scopes{list-style:none;padding:0;margin:1rem 0}
  .scopes li{padding:.5rem .7rem;background:var(--fill-2);border-radius:var(--radius-chip);margin-bottom:.4rem;font-size:.92rem}
  .muted{color:var(--muted);font-size:.86rem}
  .err{color:var(--danger);font-size:.9rem;margin-top:.6rem}
  .notice{background:var(--accent-soft);border:1px solid var(--accent-soft-line);color:var(--accent-soft-ink);padding:.7rem .9rem;border-radius:var(--radius-control);font-size:.9rem;margin-bottom:1rem}
  .vault{border:1px solid var(--line);border-radius:var(--radius-panel);padding:1rem 1.1rem;margin-bottom:.9rem;background:var(--field);box-shadow:var(--shadow-soft)}
  .vault h3{margin:0 0 .5rem;font-size:1.05rem;font-family:var(--font-round);font-weight:600}
  .field{margin:.55rem 0}
  .field .k{font-family:var(--font-round);font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.15rem}
  code,pre{font-family:var(--mono);font-size:.82rem}
  pre{background:var(--code-bg);border:1px solid var(--line);border-radius:var(--radius-chip);padding:.6rem .7rem;overflow-x:auto;margin:.15rem 0 0;white-space:pre-wrap;word-break:break-all}
  .foot{margin-top:1.4rem;text-align:center}
  .linkbtn{background:none;border:0;color:var(--accent-link);text-decoration:underline;cursor:pointer;font-size:.9rem;padding:0}
  form.inline{display:inline}
  .secondary{background:var(--fill);color:var(--ink);width:100%;margin-top:1.1rem;font-weight:600;border-radius:var(--pill)}
  .secondary:hover{background:var(--fill-hover)}
  details{margin-top:1.1rem;border-top:1px solid var(--line);padding-top:1rem}
  details>summary{cursor:pointer;color:var(--accent-link);font-size:.9rem;font-weight:600;list-style:none}
  details>summary::-webkit-details-marker{display:none}
  details[open]>summary{margin-bottom:.6rem}
  .qr{width:210px;max-width:100%;margin:.6rem auto;padding:.5rem;background:#fff;border:1px solid var(--line);border-radius:var(--radius-media)}
  .qr svg{width:100%;height:auto;display:block}
  .codegrid{list-style:none;padding:0;margin:.8rem 0;display:grid;grid-template-columns:repeat(2,1fr);gap:.5rem}
  .codegrid li{background:var(--fill-2);border:1px solid var(--line);border-radius:var(--radius-code);padding:.45rem;text-align:center;font-family:var(--mono);font-size:.92rem;letter-spacing:.03em}
  .warn{background:var(--warn-bg);border:1px solid var(--warn-line);color:var(--warn-ink);padding:.7rem .9rem;border-radius:var(--radius-control);font-size:.88rem;margin:.6rem 0}
  .status{display:flex;align-items:center;gap:.5rem;font-weight:600}
  .dot{width:.6rem;height:.6rem;border-radius:var(--pill);display:inline-block}
  .dot-on{background:var(--accent-bright)}.dot-off{background:var(--dot-off)}
  .h2row{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;margin-bottom:.4rem}
  .secret{font-family:var(--mono);font-size:1rem;letter-spacing:.14em;word-break:break-all;background:var(--code-bg);border:1px solid var(--line);border-radius:var(--radius-chip);padding:.55rem .7rem;text-align:center}
  .biginput{font-size:1.15rem;padding:.75rem .8rem}
  .chips{display:flex;flex-wrap:wrap;gap:.45rem;margin-top:.4rem}
  .chips input{position:absolute;opacity:0;pointer-events:none}
  .chips label{display:inline-block;margin:0;padding:.4rem .85rem;border:1px solid var(--line-2);border-radius:var(--pill);font-family:var(--font-round);font-size:.88rem;font-weight:500;cursor:pointer;background:var(--field);color:var(--ink)}
  .chips input:checked+label{background:var(--accent);border-color:var(--accent);color:#fff}
  .chips input:focus-visible+label{outline:2px solid var(--accent);outline-offset:2px}
  .check{list-style:none;padding:0;margin:.3rem 0 0}
  .check>li{border-top:1px solid var(--line)}
  .check>li:first-child{border-top:0}
  .door{display:flex;align-items:center;gap:.65rem;width:100%;background:none;border:0;padding:.62rem .15rem;font-size:.95rem;font-weight:500;font-family:var(--font-round);color:var(--ink);cursor:pointer;text-align:left}
  .door:hover{color:var(--accent-link)}
  .door .mark{width:1.3rem;height:1.3rem;border-radius:var(--pill);border:1.5px solid var(--mark-line);display:inline-flex;align-items:center;justify-content:center;font-size:.72rem;flex:none;color:transparent}
  .check>li[data-done="1"] .door{color:var(--muted)}
  .check>li[data-done="1"] .door .mark{background:var(--accent);border-color:var(--accent);color:#fff}
  .door .go{margin-left:auto;color:var(--accent-link);flex:none}
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
  .copybtn{flex:none;background:var(--fill);border:1px solid var(--line);border-radius:var(--radius-chip);padding:.4rem .85rem;font-size:.85rem;font-weight:600;color:var(--accent-soft-ink)}
  .copybtn:hover{background:var(--fill-hover)}
  ul.history{list-style:none;padding:0;margin:.3rem 0 0}
  ul.history li{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;border-top:1px solid var(--line);padding:.45rem .1rem;font-size:.9rem}
  ul.history li:first-child{border-top:0}
  ul.history .when{font-family:var(--mono);font-size:.84rem}
  ul.history form{margin-left:auto}
  .lead{margin:0 0 1.1rem;color:var(--ink);font-size:1rem;line-height:1.5}
  .lead p{margin:0}
  .pricepill{display:inline-block;background:var(--accent-soft);border:1px solid var(--accent-soft-line);color:var(--accent-soft-ink);padding:.32rem .7rem;border-radius:var(--pill);font-family:var(--font-round);font-size:.86rem;font-weight:600}
  .secnav{display:flex;flex-wrap:wrap;gap:.4rem;margin:0 0 1.3rem}
  .secnav a{padding:.3rem .8rem;border-radius:var(--pill);background:var(--fill-2);color:var(--accent-soft-ink);text-decoration:none;font-family:var(--font-round);font-size:.88rem;font-weight:600;white-space:nowrap}
  .secnav a:hover{background:var(--fill-hover)}
  .interval-pricing{font-size:.82rem;color:var(--muted);margin:.3rem 0 0}
  .connect-block{margin:.9rem 0 0;padding-top:.8rem;border-top:1px solid var(--line)}
  .copyrow + .connect-block{margin-top:.5rem;padding-top:0;border-top:0}
  .connect-block h4{margin:0 0 .35rem;font-size:.9rem;font-family:var(--font-round);font-weight:600}
  .creating{display:flex;flex-direction:column;align-items:center;text-align:center;padding:1.3rem .5rem .9rem}
  .creating-orb{width:2.7rem;height:2.7rem;border-radius:var(--pill);display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.15rem;background:radial-gradient(circle at 50% 38%,var(--accent-bright),var(--accent-strong));margin:.2rem 0 1rem;animation:orbpulse 1.5s ease-in-out infinite}
  .creating-title{font-family:var(--font-serif);font-size:1.35rem;margin:0 0 .3rem;color:var(--ink)}
  .creating-sub{margin:0}
  .creating.ready .creating-orb{animation:none;background:var(--accent);box-shadow:0 0 0 .4rem rgba(224,93,60,.14)}
  .creating.ready .creating-orb::after{content:"\\2713"}
  .creating.ready .creating-title,.creating.ready .creating-sub{animation:readyfade .5s ease}
  @keyframes orbpulse{0%,100%{transform:scale(.82);opacity:.55}50%{transform:scale(1);opacity:1}}
  @keyframes readyfade{from{opacity:0;transform:translateY(.18rem)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion:reduce){.creating-orb{animation:none}.creating.ready .creating-title,.creating.ready .creating-sub{animation:none}}
`;

// Exported for admin-ui.ts (the operator console reuses the exact page shell +
// brand styles, widening itself with its own style block).
export function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="brand">Parachute</div>${inner}</body></html>`;
}

/**
 * The OAuth authorize login (session-less GET /oauth/authorize). Magic-link
 * FIRST — it's the signup default, so most accounts have no password; before
 * this form existed, a passwordless user re-connecting an AI after their
 * session lapsed hit a password-only dead end (launch-flow fix 2). The magic
 * form rides the pending authorize params as hidden fields (the same
 * round-trip the password form uses); /auth/magic stores the reconstructed
 * authorize URL server-side so the emailed link RESUMES this exact request.
 * `showPassword` mirrors renderConsoleLogin: which form the error belongs to.
 */
export function renderLogin(opts: {
  params: AuthorizeParams;
  csrfToken: string;
  error?: string;
  showPassword?: boolean;
}): string {
  const { params, csrfToken, error, showPassword } = opts;
  return page(
    "Sign in — Parachute",
    `<h1>Sign in to Parachute</h1>
     <div class="card">
       <form method="post" action="/auth/magic">
         <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
         ${hiddenParams(params)}
         <label for="email">Email</label>
         <input id="email" name="email" type="email" autocomplete="email" required autofocus>
         ${!showPassword && error ? `<div class="err">${esc(error)}</div>` : ""}
         <button class="primary" type="submit">Email me a sign-in link</button>
       </form>
       <p class="muted" style="margin:.7rem 0 0">We'll email you a link that signs you in and continues connecting your app — no password needed.</p>
       <details${showPassword ? " open" : ""}>
         <summary>Use a password instead</summary>
         <form method="post" action="/oauth/authorize">
           <input type="hidden" name="__action" value="login">
           <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
           ${hiddenParams(params)}
           <label for="pw-email">Email</label>
           <input id="pw-email" name="email" type="email" autocomplete="username" required>
           <label for="password">Password</label>
           <input id="password" name="password" type="password" autocomplete="current-password" required>
           ${showPassword && error ? `<div class="err">${esc(error)}</div>` : ""}
           <button class="secondary" type="submit">Sign in with a password</button>
         </form>
       </details>
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

/**
 * Same-origin bridge page for a form-POST response that must end in a
 * CROSS-ORIGIN redirect — the OAuth consent approve/deny leg (a client's
 * `redirect_uri`), Stripe Checkout/Portal, and the app deep-links (create-
 * vault's no-JS path, the checklist doors). Chrome enforces `form-action
 * 'self'` (oauth-shared.ts) against the RESULT of a form submission, not
 * just the form's own action URL — a same-origin form whose response is a
 * cross-origin 30x gets silently `net::ERR_ABORTED` in Chrome (confirmed
 * live, 2026-07-16; Firefox does not enforce this). `form-action` only
 * governs form-submission NAVIGATIONS though: a script-initiated navigation
 * is unconstrained by it, so this renders an ordinary same-origin page
 * (passes CSP like any other ceremony response) whose nonce'd inline script
 * immediately continues the journey — plus a visible fallback link (a link
 * CLICK is a user-activation navigation, also unconstrained) for no-JS or a
 * slow/blocked script. Callers only reach for this when the target actually
 * IS cross-origin ({@link isCrossOrigin} in oauth-shared.ts) — a same-origin
 * redirect stays a direct 30x.
 *
 * `url` is always server-derived (a registered client redirect_uri with a
 * server-minted code/state appended, a freshly-minted Stripe session URL, or
 * a config-derived app deep link) — never raw user input — but rendering it
 * into a page is a NEW context the original Location-header-only design
 * never touched, so it's escaped for both places it appears: `esc()` for the
 * href attribute, and a JSON-encoded, `<`-escaped literal for the script (so
 * a redirect target can never smuggle a `</script>` breakout).
 */
export function renderRedirectBridge(url: string): string {
  const scriptSafeUrl = JSON.stringify(url).replace(/</g, "\\u003c");
  return page(
    "Redirecting…",
    `<h1>Redirecting…</h1>
     <div class="card">
       <p class="muted">Taking you back to finish up. If this takes more than a moment, <a href="${esc(url)}">continue here</a>.</p>
     </div>
     <script ${NONCE_ATTR}>location.replace(${scriptSafeUrl});</script>`,
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
     <div class="lead" data-testid="signup-context">
       <p style="margin:.2rem 0 .5rem">A private vault your AI can read and write — your notes, and everything you want it to remember, in one place you own.</p>
       <p class="pricepill" data-testid="signup-pricing">From $1/mo · 30 days free · no card to start</p>
     </div>
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
     <p class="muted" style="margin:.15rem 0 1.1rem">Parachute Cloud — your notes, and everything you want your AI to remember, in a vault of your own. Open format, export anytime.</p>
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
     <div class="foot" data-testid="login-signup-door">New to Parachute? <a href="/signup"><strong>Create your free account</strong></a></div>`,
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
   * ISO timestamp when a scheduled downgrade to free lands (pending_plan =
   * 'free' + plan_downgrade_at — a promo comp's expiry, or a real
   * subscription's scheduled cancel). Non-null → the plan line shows
   * "until <date>" so the paid period's edge is never a silent cliff.
   */
  planUntil?: string | null;
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
  /**
   * Interim MOCK billing active (billing-config.ts `mockBillingEnabled`):
   * non-prod + no real Stripe (or MOCK_BILLING=1). Checkout-eligible users get
   * the tier buttons wired to the mock endpoint + a "test mode" label (the mock
   * applies any tier). Takes precedence over the teaser and, when set, over the
   * real Checkout action. ALWAYS false in production.
   */
  mockBillingEnabled?: boolean;
  /** The user has a Stripe customer (false for comped accounts). */
  hasBillingAccount?: boolean;
  /**
   * Whether the account may START a checkout / redeem a promo (plans.ts
   * canStartCheckout: a trial or expired account with no live subscription).
   * Gates the tier chooser, the mock/teaser affordances, and the "Have a code?"
   * box. A paid-tier account gets Manage-billing instead; a live-sub account
   * neither.
   */
  canCheckout?: boolean;
  /**
   * Trial-state display, non-null only for a `trial` user (console.ts derives it
   * from entitlementPlanFor + the plan_downgrade_at clock):
   *   - `tierLabel`   the tier the trial currently mirrors ("Plus"),
   *   - `isDefault`   pending='expired'/null (the signup default, Plus-mirror),
   *   - `daysLeft`    days until the trial floors to expired (null if no clock),
   *   - `currentTier` which plan card to badge as the one they're trying.
   * Drives the plan-line banner + the "you're trying this" card badge.
   */
  trial?: {
    tierLabel: string;
    isDefault: boolean;
    daysLeft: number | null;
    currentTier: PaidTier;
  } | null;
}

/**
 * The Connect-your-AI walkthrough — your vault's MCP URL up top (copy it once,
 * paste it into any AI), then a stepped path for Claude and one for ChatGPT, the
 * "any MCP client" line, the CLI one-liner as the nerd footnote, and a link out
 * to the fuller guide. Shared between each vault card's disclosure and checklist
 * item ③ so the two can never drift.
 *
 * ChatGPT's connector menu naming varies by plan and moves often, so its steps
 * stay deliberately generic ("your connector settings") rather than pinning an
 * exact label we'd have to chase.
 */
function connectAiContent(v: ConsoleVaultCard): string {
  return `<p class="muted" style="margin:.2rem 0 .3rem">Your vault&#39;s connection URL — copy it, then paste it into any AI below:</p>
    <div class="copyrow"><pre>${esc(v.mcpUrl)}</pre><button type="button" class="copybtn" data-copy="${esc(v.mcpUrl)}">Copy</button></div>
    <div class="connect-block">
      <h4>Claude</h4>
      <ol class="steps">
        <li>Open <a href="https://claude.ai" target="_blank" rel="noopener">claude.ai</a> and go to <strong>Settings → Connectors</strong></li>
        <li>Choose <strong>Add custom connector</strong></li>
        <li>Paste the URL above and connect</li>
      </ol>
    </div>
    <div class="connect-block">
      <h4>ChatGPT</h4>
      <ol class="steps">
        <li>Open ChatGPT and go to <strong>Settings → Connectors</strong> (available on paid plans)</li>
        <li>In your connector settings, add a custom connector / MCP server</li>
        <li>Paste the URL above and connect</li>
      </ol>
    </div>
    <p class="muted" style="margin:.65rem 0 0"><strong>Other AIs:</strong> that same URL works in any MCP-compatible client — paste it wherever your AI asks for an MCP server.</p>
    <p class="muted" style="margin:.45rem 0 0">Command line: <code>${esc(v.connectCmd)}</code></p>
    <p class="muted" style="margin:.45rem 0 0">Need more detail? See the <a href="https://parachute.computer/guides/connect-your-ai/" target="_blank" rel="noopener">Connect your AI guide</a>.</p>`;
}

/** iOS/Android add-to-home-screen steps for the app PWA (checklist item ④). */
function addToPhoneContent(v: ConsoleVaultCard): string {
  // The visible label tracks the actual deep-link host (app origin, or the
  // legacy Notes PWA when APP_ORIGIN is unset) — never a hardcoded host that
  // could diverge from where the link goes.
  const appHost = (() => {
    try {
      return new URL(v.notesUrl).host;
    } catch {
      return "your Parachute app";
    }
  })();
  return `<p class="muted" style="margin:.15rem 0 .45rem">Parachute installs straight from the browser — no app store.</p>
    <p style="margin:.3rem 0;font-size:.92rem"><strong>iPhone / iPad:</strong> open <a href="${esc(v.notesUrl)}" target="_blank" rel="noopener">${esc(appHost)}</a> in Safari → tap <strong>Share</strong> → <strong>Add to Home Screen</strong>.</p>
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
  // TODO(console-launch): the denominator here is planTotalBytes (notes +
  // attachment budgets SUMMED into one number), but storage is now a POOLED
  // TOTAL shared across all vaults AND a two-meter split — "of <total>" per card
  // double-counts the shared budget and hides the notes-vs-attachment split.
  // Show the pooled remaining, or the two meters, instead of a summed per-vault cap.
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
      ${/* TODO(console-launch): "Building a surface?" / "surface (UI)" is insider
           jargon a fresh cloud user won't parse — reword to plain "Build a custom
           app over your vault" language (or gate behind a friendlier framing). */ ""}
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
    <form method="post" action="/console/vaults/export" data-testid="vault-export" style="margin-top:.8rem">
      <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
      <input type="hidden" name="vault" value="${esc(v.name)}">
      <button class="linkbtn" type="submit">Download everything (.tar)</button>
      <span class="muted" style="font-size:.8rem">— portable Markdown, attachment files included</span>
    </form>
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

/**
 * The "Import a vault" disclosure — the other half of the export door: upload a
 * Parachute export (.tar) and get a NEW vault with those notes. Multipart form
 * (a file upload), so it needs `enctype="multipart/form-data"`. Rendered
 * alongside the create-vault form (first-run hero + the create card) and, like
 * that form, only when the account is under its vault-count cap — an import
 * creates a vault, so the POST is refused at the cap regardless.
 */
function importDetails(csrfToken: string): string {
  return `<details data-testid="vault-import" style="margin-top:.9rem">
    <summary>Import a vault</summary>
    <p class="muted" style="margin:.35rem 0 .5rem">Upload a Parachute export (.tar) — from self-host, another account, or another provider's export we can read.</p>
    <form method="post" action="/console/vaults/import" enctype="multipart/form-data">
      <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
      <label for="import-name">New vault name</label>
      <input id="import-name" name="vault_name" type="text" placeholder="e.g. imported-notes" pattern="${VAULT_NAME_PATTERN}" required>
      <label for="import-file" style="margin-top:.5rem">Export file (.tar)</label>
      <input id="import-file" name="tarball" type="file" accept=".tar,application/x-tar" required>
      <button class="secondary" type="submit" style="margin-top:.7rem">Import into a new vault</button>
    </form>
  </details>`;
}

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
 * The first-run hero: one warm card — name your vault, then straight into your
 * notes. Creating a vault lands you in the Notes UI (the 2026-07-08 onboarding
 * decision), so the hero is a single field, no questions in the way.
 */
function firstRunHero(csrfToken: string, values: FirstRunValues, error?: string): string {
  return `<p style="margin:.4rem 0 1.1rem">Welcome. Your vault is where your notes — and everything you want your AI to remember — will live, under a name you choose. It's yours: open format, export anytime.</p>
    <div class="card">
      <form method="post" action="/console/vaults">
        <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
        <label for="name" style="font-size:.95rem">Vault name</label>
        <input class="biginput" id="name" name="name" type="text" placeholder="e.g. field-notes" pattern="${VAULT_NAME_PATTERN}" value="${esc(values.name ?? "")}" required autofocus>
        <p class="muted" style="margin:.35rem 0 0">Lowercase letters, numbers, and hyphens. 2–63 characters.</p>
        ${error ? `<div class="err">${esc(error)}</div>` : ""}
        <button class="primary" type="submit">Create my vault</button>
      </form>
      ${importDetails(csrfToken)}
    </div>`;
}

/**
 * Console page JS — deliberately tiny (this file is otherwise zero-JS):
 * clipboard for the MCP-URL copy buttons, marking an expandable checklist item
 * done on first open, and the vault-creation MOMENT (below). All three degrade
 * quietly without JS — the URL is selectable text, the disclosure still opens
 * (it just isn't recorded), and the create form POSTs to its usual 303.
 *
 * The creation moment (progressive enhancement over the create form): intercept
 * the submit, stage a warm "building → ready" beat, and let the server hand the
 * Notes URL back as JSON (`X-Requested-With: fetch`) — a fetch can't follow that
 * cross-origin 303 past CORS, so we navigate ourselves via window.location. The
 * ceremony is short (≤ ~2s added) and NEVER blocks on a timer when the request
 * errors: a server error drops cleanly back to the form with its message; any
 * unexpected response falls through to the native submit so the server's real
 * response (303 / re-rendered error / login redirect) takes over — never a user
 * stranded in the "building" state.
 */
function consoleScript(csrfToken: string): string {
  // The nonce marker is swapped for the response's real CSP nonce in
  // htmlResponse (oauth-shared.ts). Any future inline <script> MUST carry
  // ${NONCE_ATTR} or the CSP will block it — the csp.test.ts scan pins that.
  return `<script ${NONCE_ATTR}>(function(){
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
  var forms=document.querySelectorAll('form[action="/console/vaults"]');
  for(var fi=0;fi<forms.length;fi++)wireCreate(forms[fi]);
  function wireCreate(form){
    form.addEventListener("submit",function(e){
      if(!window.fetch||!window.FormData||!form.closest)return;
      // In-flight guard: a create is already running for this form — swallow the
      // repeat so a second submit can't double-POST (the display:none below is
      // the visual block; this is the explicit one). Cleared on the error/
      // fallback paths (restore), never on success (we navigate away).
      if(form.getAttribute("data-inflight"))return e.preventDefault();
      e.preventDefault();
      form.setAttribute("data-inflight","1");
      var nameEl=form.querySelector('input[name="name"]');
      var name=nameEl?String(nameEl.value).trim():"";
      var card=form.closest(".card")||form.parentNode;
      var fd=new FormData(form);
      var stash=[];
      for(var i=0;i<card.children.length;i++){var el=card.children[i];stash.push([el,el.style.display]);el.style.display="none";}
      var panel=buildPanel(name);
      card.appendChild(panel);
      var t0=Date.now();
      fetch(form.getAttribute("action"),{method:"POST",body:fd,credentials:"same-origin",headers:{"x-requested-with":"fetch"}}).then(function(res){
        if((res.headers.get("content-type")||"").indexOf("application/json")===-1)throw new Error("non-json");
        return res.json();
      }).then(function(data){
        if(data&&data.redirect){
          var wait=Math.max(0,650-(Date.now()-t0));
          setTimeout(function(){markReady(panel);setTimeout(function(){window.location.assign(data.redirect);},1150);},wait);
          return;
        }
        restore(form,card,panel,stash);
        showError(form,(data&&data.error)||"Something went wrong. Please try again.");
      }).catch(function(){
        restore(form,card,panel,stash);
        form.submit();
      });
    });
  }
  function buildPanel(name){
    var p=document.createElement("div");
    p.className="creating";p.setAttribute("role","status");p.setAttribute("aria-live","polite");
    var orb=document.createElement("div");orb.className="creating-orb";orb.setAttribute("aria-hidden","true");
    var h=document.createElement("p");h.className="creating-title";
    if(name){h.appendChild(document.createTextNode("Preparing "));var s=document.createElement("strong");s.textContent=name;h.appendChild(s);h.appendChild(document.createTextNode("\\u2026"));}
    else{h.textContent="Preparing your vault\\u2026";}
    var sub=document.createElement("p");sub.className="creating-sub muted";sub.textContent="Making a space that's yours.";
    p.appendChild(orb);p.appendChild(h);p.appendChild(sub);
    return p;
  }
  function markReady(panel){
    var h=panel.querySelector(".creating-title"),sub=panel.querySelector(".creating-sub");
    if(h)h.textContent="Your vault is ready";
    if(sub)sub.textContent="Opening your notes\\u2026";
    panel.className="creating ready";
  }
  function restore(form,card,panel,stash){
    if(panel&&panel.parentNode)panel.parentNode.removeChild(panel);
    for(var i=0;i<stash.length;i++)stash[i][0].style.display=stash[i][1];
    form.removeAttribute("data-inflight");
  }
  function showError(form,msg){
    var err=form.querySelector(".err");
    if(!err){err=document.createElement("div");err.className="err";err.setAttribute("role","alert");var btn=form.querySelector('button[type="submit"]')||form.querySelector("button");if(btn)form.insertBefore(err,btn);else form.appendChild(err);}
    err.textContent=msg;
    var nameEl=form.querySelector('input[name="name"]');if(nameEl)nameEl.focus();
  }
})();</script>`;
}

/**
 * The always-visible plan-cards section — the fix for "a trial/expired user on
 * a keyless prod deploy sees NO plans at all" (the old chooser was gated on
 * billingConfigured, so nothing rendered without Stripe). The pricing is now
 * DECOUPLED from Stripe:
 *   - "Choose this plan" (a TRIAL user only) POSTs /console/plan — no card; it
 *     sets the trial's mirrored tier (pending_plan) and re-pushes the caps
 *     immediately. Load-bearing: NO free /console/plan form is rendered for an
 *     expired user (they must pay to reactivate — never a free paid tier).
 *   - "Add a card / subscribe" POSTs the checkout action (hosted Checkout, or
 *     the mock endpoint in non-prod) — ONLY when billing is available; otherwise
 *     a calm no-card / reactivate line stands in (never a broken 500-ing button).
 *   - An EXPIRED user's only affordance is that checkout ("Choose this plan" =
 *     pay to reactivate).
 * Rendered only for checkout-eligible (trial/expired) users; a paid tier /
 * live-sub account uses Manage billing instead and never sees this.
 */
function renderPlanCards(opts: {
  csrfToken: string;
  plan: PlanId;
  billingConfigured: boolean;
  mockBillingEnabled: boolean;
  trial: ConsoleProps["trial"];
}): string {
  const { csrfToken, plan, billingConfigured, mockBillingEnabled, trial } = opts;
  const isTrial = plan === "trial";
  const checkoutAvailable = billingConfigured || mockBillingEnabled;
  const checkoutAction = mockBillingEnabled ? "/billing/mock-checkout" : "/billing/checkout";

  // The billing-interval select (monthly/quarterly/yearly; entry has NO monthly
  // — Stripe's flat fee eats a $1 charge, so it bills quarterly/yearly and the
  // server refuses entry×monthly regardless). The MOCK path ignores it.
  const intervalSelect = (tier: PaidTier): string => {
    const intervals: readonly BillingInterval[] =
      tier === "entry" ? ["quarterly", "yearly"] : ["monthly", "quarterly", "yearly"];
    const options = intervals
      .map((iv, i) => `<option value="${iv}"${i === 0 ? " selected" : ""}>${iv}</option>`)
      .join("");
    return `<select name="interval" aria-label="${esc(PLAN_SPECS[tier].label)} billing interval" style="font-size:.85em;padding:.15rem .2rem">${options}</select>`;
  };

  // The Stripe-gated checkout form for one tier — trial and expired both reuse
  // it with the same "Subscribe" label (same POST /billing checkout endpoint).
  const checkoutForm = (tier: PaidTier, label: string): string =>
    `<form class="inline" method="post" action="${checkoutAction}" data-testid="upgrade-${tier}" style="display:flex;gap:.3rem;align-items:center;margin-top:.5rem">
       <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
       <input type="hidden" name="plan" value="${tier}">
       <button class="linkbtn" type="submit">${esc(label)}</button>${intervalSelect(tier)}
     </form>`;

  const cards = PAID_TIERS.map((tier) => {
    const spec = PLAN_SPECS[tier];
    const isCurrent = isTrial && trial != null && trial.currentTier === tier;
    const badge =
      isCurrent && trial
        ? `<div data-testid="current-tier-${tier}" style="font-size:.72rem;color:var(--sage-dark);font-weight:600;margin-top:.15rem">${trial.isDefault ? "Default while you decide" : "You're trying this"}</div>`
        : "";
    // The FREE "try this free" affordance — TRIAL ONLY. An expired user gets no
    // /console/plan form at all (their affordance is the checkout below). The
    // current tier renders a disabled "You're trying this"; every other tier a
    // live "Try this free" + a tiny "free during your trial" hint.
    const chooseFree = isTrial
      ? `<form class="inline" method="post" action="/console/plan" data-testid="choose-${tier}" style="margin-top:.5rem">
           <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
           <input type="hidden" name="plan" value="${tier}">
           ${
             isCurrent
               ? `<button class="linkbtn" type="submit" disabled style="opacity:.7;cursor:default">You're trying this</button>`
               : `<button class="linkbtn" type="submit">Try this free</button>
              <span class="muted" style="display:block;font-size:.72rem;margin-top:.1rem">free during your trial</span>`
           }
         </form>`
      : "";
    // The Stripe affordance (only when billing is available): "Subscribe" in BOTH
    // the trial (convert / start paying now) and expired (pay to reactivate)
    // cases. Absent → the section-level calm line stands in.
    const paidAffordance = checkoutAvailable ? checkoutForm(tier, "Subscribe") : "";
    return `<div class="card" data-testid="plan-card-${tier}" style="flex:1 1 12rem;min-width:11rem;margin:0;padding:1rem">
         <div style="display:flex;justify-content:space-between;align-items:baseline;gap:.5rem">
           <strong>${esc(spec.label)}</strong><span class="muted">${esc(TIER_PRICE_LABEL[tier])}</span>
         </div>
         ${badge}
         <p class="muted" style="margin:.35rem 0 0">${esc(tierCapSummary(tier))}</p>
         <p class="interval-pricing" data-testid="interval-pricing-${tier}">${esc(tierIntervalPricing(tier))}</p>
         ${chooseFree}${paidAffordance}
       </div>`;
  }).join("");

  // The calm stand-in when billing isn't wired — never a broken checkout button.
  const noCardLine = checkoutAvailable
    ? ""
    : isTrial
      ? `<p class="muted" data-testid="no-card-line" style="margin:.6rem 0 0">You're on your 30-day free trial — no card needed. We'll ask before it ends.</p>`
      : `<p class="muted" data-testid="reactivate-line" style="margin:.6rem 0 0">Add a payment method to reactivate a plan — your notes stay readable and exportable anytime.</p>`;
  const mockNote = mockBillingEnabled
    ? ` <span class="muted" data-testid="mock-billing-note">test mode &mdash; no real charge</span>`
    : "";
  // `upgrade-billing` marks that the Stripe affordance is present (the smokes +
  // billing tests key off it); absent → the no-card/reactivate line stands in.
  const billingWrap = checkoutAvailable ? ` data-testid="upgrade-billing"` : "";
  return `<section id="plans" data-testid="plans"${billingWrap} style="margin:0 0 1.1rem">
       <h2 style="margin:0 0 .4rem;font-size:1rem">Plans${mockNote}</h2>
       <p class="muted" data-testid="plans-storage-note" style="margin:0 0 .6rem;font-size:.82rem">Storage is a shared total across all your vaults — use it for one big vault or several.</p>
       <div style="display:flex;flex-wrap:wrap;gap:.7rem">${cards}</div>
       ${noCardLine}
     </section>`;
}

/**
 * The console section nav (#97) — a light, wrapping row of anchor links that
 * turns the one-long-scroll page into something you can jump around. Anchors
 * resolve to the on-page sections (#vaults, #plans); Security is its own page.
 * With exactly one vault, an "Open notes" link (#99) puts the everyday
 * destination one tap away — no scroll to the card. Wraps on narrow screens
 * (`.secnav` flex-wrap), so it stays usable on mobile.
 */
function sectionNav(vaults: ConsoleVaultCard[], hasPlans: boolean): string {
  const links: string[] = [`<a href="#vaults">Vaults</a>`];
  if (vaults.length === 1) {
    links.push(
      `<a href="${esc(vaults[0]!.notesUrl)}" target="_blank" rel="noopener" data-testid="nav-open-notes">Open notes &nearr;</a>`,
    );
  }
  if (hasPlans) links.push(`<a href="#plans">Plan</a>`);
  links.push(`<a href="/console/security">Security</a>`);
  return `<nav class="secnav" data-testid="section-nav" aria-label="Console sections">${links.join("")}</nav>`;
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
    planUntil,
    totalUsedBytes,
    atVaultCap,
    isOperator,
    billingConfigured,
    mockBillingEnabled,
    hasBillingAccount,
    canCheckout,
    trial,
  } = props;
  // Plan display. The across-vaults usage total (latest rollup rows) rides the
  // plan line. The plan-line TEXT depends on state: a trial user gets the
  // "you're trying <Tier> — N days left" banner (trial.tierLabel from
  // entitlementPlanFor); expired reads its floor copy; a paid tier reads its
  // spec + any scheduled-cancel date + the Manage-billing door.
  //
  // The pricing itself now lives in an ALWAYS-VISIBLE plan-cards SECTION below
  // (renderPlanCards) — decoupled from Stripe: picking a tier during a trial
  // needs no card (POST /console/plan sets pending_plan; caps re-push). Only the
  // "Add a card / subscribe" affordance is Stripe-gated. The old
  // billingConfigured-gated compact chooser (which rendered NOTHING on a
  // keyless prod deploy — the bug this PR fixes) is gone.
  const usageHtml =
    totalUsedBytes != null
      ? ` <span data-testid="usage-total">&middot; Using ${esc(formatUsageBytes(totalUsedBytes))}</span>`
      : "";
  const manageBillingHtml =
    isPaidTier(plan) && billingConfigured && hasBillingAccount
      ? ` <form class="inline" method="post" action="/billing/portal" data-testid="manage-billing">
           <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
           <span style="opacity:.75">&middot;</span> <button class="linkbtn" type="submit">Manage billing</button>
         </form>`
      : "";
  // A scheduled downgrade's date (a promo comp expiry, or a real subscription's
  // scheduled cancel) rides the plan line for NON-trial users — quiet, honest,
  // never a silent cliff. A trial's clock is shown by its banner (days left)
  // instead, so it isn't double-rendered here.
  const planUntilHtml =
    planUntil && plan !== "trial"
      ? ` <span data-testid="plan-until">&middot; until ${esc(planUntil.slice(0, 10))}</span>`
      : "";
  // The plan-line lead text: the trial banner (with a "Change plan" jump to the
  // cards) when trialing, else the plan's spec line.
  const planLead =
    plan === "trial" && trial
      ? `<span data-testid="trial-banner">${esc(trialBannerLine(trial.tierLabel, trial.isDefault, trial.daysLeft))}</span> <a href="#plans" data-testid="change-plan">Change plan</a>`
      : esc(planLine(plan));
  const planHtml = `${planLead}${planUntilHtml}${usageHtml}${manageBillingHtml}`;
  // The always-visible plan cards — for checkout-eligible (trial/expired) users
  // only; a paid tier / live-sub account uses Manage billing and never sees it.
  const plansSectionHtml =
    canCheckout === true
      ? renderPlanCards({
          csrfToken,
          plan,
          billingConfigured: billingConfigured === true,
          mockBillingEnabled: mockBillingEnabled === true,
          trial,
        })
      : "";
  // "Have a code?" — promo redemption (promo.ts), checkout-eligible accounts
  // only (a paid tier has nothing to redeem onto; the POST refuses regardless).
  // A quiet disclosure under the plan line: present for launch codes, invisible
  // noise otherwise. Inline styles undo the details/input defaults.
  const promoHtml =
    canCheckout
      ? `<details data-testid="promo-code" style="margin:-.9rem 0 1.2rem;border-top:0;padding-top:0;font-size:.88rem">
       <summary class="muted" style="font-weight:500">Have a code?</summary>
       <form method="post" action="/console/promo" style="display:flex;gap:.5rem;align-items:center;margin-top:.45rem;max-width:22rem">
         <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
         <input name="code" type="text" placeholder="Your code" required aria-label="Promo code" autocomplete="off" spellcheck="false" style="text-transform:uppercase;font-size:.92rem;padding:.45rem .6rem">
         <button class="secondary" type="submit" style="width:auto;margin-top:0;font-size:.92rem;padding:.45rem .9rem;white-space:nowrap">Redeem</button>
       </form>
     </details>`
      : "";
  // The Admin link renders ONLY for operators — everyone else never learns the
  // route exists (it answers 404 to them anyway; admin.ts).
  const header = (title: string) => `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:1rem">
       <h1 style="margin:0">${esc(title)}</h1>
       <span style="display:flex;gap:1rem;align-items:baseline">${isOperator ? `<a href="/admin" data-testid="admin-link">Admin</a>` : ""}<a href="/console/security">Security</a>
       <form class="inline" method="post" action="/logout"><input type="hidden" name="__csrf" value="${esc(csrfToken)}"><button class="linkbtn" type="submit">Sign out</button></form></span>
     </div>
     <p class="muted" style="margin:.15rem 0 .2rem">${esc(email)}</p>
     <p class="muted" data-testid="plan-line" style="margin:0 0 1.2rem;font-size:.88rem">${planHtml}</p>
     ${promoHtml}`;

  if (vaults.length === 0) {
    // The hero stays the primary top action (name + create the first vault); the
    // plan cards sit BELOW it so a fresh user can actually pick a tier and the
    // header's trial banner "Change plan" / #plans anchor resolves — before this
    // the zero-vault screen linked to a #plans that never rendered (FIX 1).
    return page(
      "Console — Parachute",
      `${header("Name your vault")}
       ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
       ${firstRunHero(csrfToken, firstRun ?? {}, error)}
       ${plansSectionHtml}
       ${consoleScript(csrfToken)}`,
    );
  }

  const list = vaults.map((v) => vaultCard(v, csrfToken, planTotalBytes(plan))).join("\n");
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
       ${importDetails(csrfToken)}
     </div>`;
  // The dismissed checklist's way back: a quiet footer link, never a banner —
  // guidance stays reachable without ever re-imposing itself.
  const restoreFoot = showChecklistRestore
    ? `<div class="foot"><form class="inline" method="post" action="/console/checklist/restore">
         <input type="hidden" name="__csrf" value="${esc(csrfToken)}">
         <button class="linkbtn" type="submit" style="color:var(--muted)" data-testid="show-setup-guide">Show setup guide</button>
       </form></div>`
    : "";
  // Product above the upsell (FIX 4): a user who just made their first vault sees
  // getting-started + their vault(s) + the create/at-cap door FIRST, then the
  // plan cards — pricing sits below the thing they came here to use. The section
  // nav (#97) rides just under the header so the page is navigable, not just a
  // scroll; the vault list + create door live under the #vaults anchor it points
  // to.
  return page(
    "Console — Parachute",
    `${header("Your vaults")}
     ${sectionNav(vaults, plansSectionHtml !== "")}
     ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
     ${checklist ? checklistCard(checklist, csrfToken) : ""}
     <section id="vaults" data-testid="section-vaults">
       ${list}
       ${createCard}
     </section>
     ${plansSectionHtml}
     ${restoreFoot}
     ${consoleScript(csrfToken)}`,
  );
}
