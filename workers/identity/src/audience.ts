/**
 * Scope → audience derivation + vault-scope narrowing. Ports the hub's
 * `jwt-audience.ts`, `resource-binding.ts`, and the `narrowVaultScopes` /
 * `unnamedVaultVerbs` helpers from `oauth-handlers.ts` — the pieces that decide
 * a token's `aud` and rewrite unnamed `vault:<verb>` into the named,
 * audience-correct `vault:<name>:<verb>` shape a vault accepts.
 */

export const VAULT_VERBS = new Set(["read", "write", "admin"]);

/**
 * Named `vault:<name>:<verb>` → `aud="vault.<name>"` (RFC 8707 resource
 * binding; vault strict-checks this against its URL-derived name). Unnamed
 * `<service>:<verb>` → `<service>`. No namespaced scope → `hub`. Named vault
 * scopes win over everything.
 */
export function inferAudience(scopes: readonly string[]): string {
  for (const s of scopes) {
    const parts = s.split(":");
    const name = parts[1];
    const verb = parts[2];
    if (parts.length === 3 && parts[0] === "vault" && name && verb && VAULT_VERBS.has(verb)) {
      return `vault.${name}`;
    }
  }
  for (const s of scopes) {
    const colon = s.indexOf(":");
    if (colon > 0) return s.slice(0, colon);
  }
  return "hub";
}

/** Unnamed `vault:<verb>` verbs present in the set — these need a picked vault. */
export function unnamedVaultVerbs(scopes: readonly string[]): string[] {
  const verbs: string[] = [];
  for (const s of scopes) {
    const parts = s.split(":");
    const verb = parts[1];
    if (parts.length === 2 && parts[0] === "vault" && verb && VAULT_VERBS.has(verb)) {
      verbs.push(verb);
    }
  }
  return verbs;
}

/** Rewrite each unnamed `vault:<verb>` to `vault:<pickedVault>:<verb>`. */
export function narrowVaultScopes(scopes: readonly string[], pickedVault: string): string[] {
  return scopes.map((s) => {
    const parts = s.split(":");
    const verb = parts[1];
    if (parts.length === 2 && parts[0] === "vault" && verb && VAULT_VERBS.has(verb)) {
      return `vault:${pickedVault}:${verb}`;
    }
    return s;
  });
}

const VAULT_MCP_PATH_RE = /^\/vault\/([^/]+)\/mcp\/?$/;
const VAULT_PRM_PATH_RE = /^\/vault\/([^/]+)\/\.well-known\/oauth-protected-resource\/?$/;
const VAULT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function decodeVaultName(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return VAULT_NAME_RE.test(decoded) ? decoded : null;
}

export interface ResolveResourceOpts {
  /** The issuer's own origin set — for the hub-compatible `/vault/<name>/mcp` path form. */
  boundOrigins: readonly string[];
  /** Cloud vault base domain — for the subdomain form `<name>.<base>`. */
  vaultBaseDomain?: string;
}

/**
 * Resolve an RFC 8707 `resource` parameter to a vault instance name, or null
 * when it isn't a per-vault MCP resource.
 *
 * Two recognized shapes:
 *   1. Cloud subdomain addressing — host `<name>.<vaultBaseDomain>` (any path).
 *      This is how a cloud vault at `https://<name>.u.parachute.computer/…`
 *      names itself; the vault name is the leftmost label.
 *   2. Hub-compatible path addressing — an origin in `boundOrigins` with path
 *      `/vault/<name>/mcp` or the per-vault PRM path.
 *
 * A resource off both shapes (foreign origin, malformed, non-vault path) → null,
 * and the flow degrades to the unbound (manual-pick / `vault=` hint) path.
 */
export function resolveResourceVault(
  resource: string | null | undefined,
  opts: ResolveResourceOpts,
): string | null {
  if (!resource) return null;
  let parsed: URL;
  try {
    parsed = new URL(resource);
  } catch {
    return null;
  }
  // 1. Cloud subdomain form: `<name>.<vaultBaseDomain>`.
  if (opts.vaultBaseDomain) {
    const base = opts.vaultBaseDomain.replace(/^\.+/, "").toLowerCase();
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith(`.${base}`)) {
      const label = host.slice(0, host.length - base.length - 1);
      // Single leftmost label only — a deeper subdomain isn't a vault host.
      if (label && !label.includes(".") && VAULT_NAME_RE.test(label)) return label;
    }
  }
  // 2. Hub-compatible path form on a bound origin.
  if (opts.boundOrigins.includes(parsed.origin)) {
    const mcp = VAULT_MCP_PATH_RE.exec(parsed.pathname);
    if (mcp?.[1]) return decodeVaultName(mcp[1]);
    const prm = VAULT_PRM_PATH_RE.exec(parsed.pathname);
    if (prm?.[1]) return decodeVaultName(prm[1]);
  }
  return null;
}

/**
 * Rewrite the requested scope list for a resource-bound vault flow, keeping
 * ONLY scopes usable in the resulting `aud=vault.<name>` token:
 *   - unnamed `vault:<verb>` → `vault:<name>:<verb>`;
 *   - already-named `vault:<other>:<verb>` left untouched (downstream decides);
 *   - non-vault scopes (`scribe:*`, `hub:admin`, …) DROPPED — unusable in a
 *     vault-audience token, and dropping them kills the "scary consent" surface.
 * Idempotent.
 */
export function narrowResourceVaultScopes(scopes: readonly string[], vaultName: string): string[] {
  const out: string[] = [];
  for (const s of scopes) {
    const parts = s.split(":");
    if (parts[0] !== "vault") continue;
    const verb = parts[1];
    if (parts.length === 2 && verb && VAULT_VERBS.has(verb)) {
      out.push(`vault:${vaultName}:${verb}`);
    } else {
      out.push(s);
    }
  }
  return out;
}
