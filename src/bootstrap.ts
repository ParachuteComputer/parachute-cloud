/**
 * First-boot bootstrap for a freshly-provisioned cloud Fly machine (Tier 1).
 *
 * Lifted from parachute-hub/src/deploy/bootstrap.ts on 2026-04-29 as part of
 * the parachute-cloud Phase 1 cut: the script runs *inside* the user's VM,
 * not the control plane, but cloud is the package that owns provisioning end
 * to end. Hub keeps a copy until the cloud-side caller is wired up; once that
 * lands the hub copy retires.
 *
 * Runs once when the machine starts. Reads a minimal env contract written by
 * the cloud control plane at provision time, installs the configured Tier 1
 * modules onto the persistent volume, and drops a marker so subsequent boots
 * no-op.
 *
 * Env contract (all optional):
 *   - PARACHUTE_VAULT_NAME       — vault slug. Default: "default".
 *   - PARACHUTE_MODULES          — comma-separated shortnames. Default: "vault,scribe,notes".
 *   - PARACHUTE_SCRIBE_PROVIDER  — pre-pick a scribe transcription provider so install
 *                                  doesn't prompt on a non-TTY container.
 *   - PARACHUTE_SCRIBE_KEY       — API key for the chosen scribe provider.
 *   - CLAUDE_API_TOKEN           — optional. Persisted to <configDir>/.env when set
 *                                  so any module on the box can read it (e.g. an
 *                                  Anthropic-backed scribe provider, paraclaw later).
 *                                  Tier 1 (vault/scribe/notes) does not require it
 *                                  — hub#133 dropped the hard requirement.
 *   - PARACHUTE_PROVISION_CALLBACK_URL — control-plane callback endpoint. When set
 *                                  *together with* PARACHUTE_PROVISION_SECRET +
 *                                  PARACHUTE_TENANT_ID, bootstrap POSTs a single-use
 *                                  completion webhook after the marker is written so
 *                                  the control plane can flip the tenant row from
 *                                  `provisioning` → `active`. Failures are logged
 *                                  but DO NOT fail bootstrap — the marker still
 *                                  reflects local success; an operator (or a future
 *                                  drift-reconciler) can replay.
 *   - PARACHUTE_PROVISION_SECRET — pairs with the URL above. Single-use.
 *   - PARACHUTE_TENANT_ID        — pairs with the URL above. UUID from accounts.id.
 *
 * Idempotency: the marker at `<configDir>/bootstrap.json` short-circuits a
 * re-run on machine restart. A failed install does NOT write the marker, so
 * the next boot retries cleanly.
 *
 * Tier 2 modules (paraclaw) are rejected with a clear error — Tier 1 v1
 * only stands up the personal-knowledge tier.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir as defaultConfigDir } from "./config.ts";
import { parseEnvFile, upsertEnvLine, writeEnvFile } from "./env-file.ts";

/** Tier 1 module set per the parachute-deploy design doc. Hub is implicit. */
export const DEFAULT_MODULES = ["vault", "scribe", "notes"] as const;

/** Default vault slug when PARACHUTE_VAULT_NAME isn't supplied. */
export const DEFAULT_VAULT_NAME = "default";

/**
 * Modules carved into Tier 2 by the parachute-deploy design. Passing one in
 * PARACHUTE_MODULES is rejected with a load-bearing error so users (and
 * misconfigured CI) don't silently try to install something v1 can't host.
 */
const TIER2_MODULES = new Set<string>(["paraclaw"]);

/**
 * Subset of hub's `InstallOpts` that bootstrap actually populates. Defined
 * locally so cloud doesn't take a dep on the hub package — the orchestrator
 * supplies `installFn` (a thin shim around hub's `install`) at call time.
 */
export interface BootstrapInstallOpts {
  log?: (line: string) => void;
  configDir?: string;
  vaultName?: string;
  scribeProvider?: string;
  scribeKey?: string;
}

export type BootstrapInstallFn = (
  short: string,
  installOpts: BootstrapInstallOpts,
) => Promise<number>;

export interface BootstrapMarker {
  /** ISO 8601 timestamp of bootstrap completion. */
  bootstrapped_at: string;
  /** Modules that were installed on this machine (in install order). */
  modules: string[];
  /** Vault slug that was created. */
  vault_name: string;
  /** Hub package version that ran the bootstrap. */
  parachute_version: string;
}

export interface BootstrapOpts {
  /**
   * Per-module install fn. Required: cloud doesn't bundle hub's `install`,
   * so the orchestrator (or a test) must inject it. The `parachute deploy`
   * caller passes a shim that calls into the bun-linked hub on the VM.
   */
  installFn: BootstrapInstallFn;
  /** Process env. Tests inject a synthetic env; production reads `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override the resolved config dir. Tests point this at a tmpdir. */
  configDir?: string;
  /** Output sink. Tests capture into an array; production logs to stdout. */
  log?: (line: string) => void;
  /** Extra opts merged into every install() call. */
  baseInstallOpts?: BootstrapInstallOpts;
  /** Test seam: deterministic timestamp for the marker. */
  now?: () => Date;
  /** Override the version stamped into the marker. Tests pin it. */
  parachuteVersion?: string;
  /**
   * HTTP fetch override for the control-plane callback. Tests inject a stub
   * that records the request and returns a synthetic Response. Production
   * uses the global `fetch`.
   */
  fetchFn?: typeof fetch;
}

export interface BootstrapResult {
  exitCode: number;
  /** Present on success and on idempotent re-run; absent on failure. */
  marker?: BootstrapMarker;
  /** True when the marker already existed and bootstrap was a no-op. */
  alreadyBootstrapped?: boolean;
}

export async function bootstrap(opts: BootstrapOpts): Promise<BootstrapResult> {
  const env = opts.env ?? process.env;
  const dir = opts.configDir ?? defaultConfigDir(env);
  const log = opts.log ?? ((line: string) => console.log(line));
  const installFn = opts.installFn;
  const now = opts.now ?? (() => new Date());
  const version = opts.parachuteVersion ?? readPackageVersion();
  const markerPath = join(dir, "bootstrap.json");

  if (existsSync(markerPath)) {
    log(`bootstrap: marker already at ${markerPath} — already provisioned, no-op.`);
    const existing = readMarker(markerPath);
    return existing
      ? { exitCode: 0, marker: existing, alreadyBootstrapped: true }
      : { exitCode: 0, alreadyBootstrapped: true };
  }

  // Container-bootstrap ephemeral-layer guard: PARACHUTE_HOME must point at
  // the persistent volume mount (e.g. /data on a Fly machine). When it isn't
  // set, configDir() falls back to ~/.parachute under the running user's
  // homedir, which on a Fly machine is a writable layer of the *image* —
  // looks fine until the next deploy/restart wipes it.
  //
  // We check `defaultConfigDir(env)` rather than the resolved `dir` so an
  // injected `opts.configDir` (tests, future integration harnesses) doesn't
  // false-positive when the override happens to live under homedir.
  if ((env.PARACHUTE_HOME ?? "").length === 0 && defaultConfigDir(env).startsWith(homedir())) {
    log(`bootstrap: ⚠ PARACHUTE_HOME is not set — config dir resolved to ${dir} (under homedir).`);
    log(
      "  On a containerized deploy this is the ephemeral image layer; data will NOT survive restart.",
    );
    log("  Set PARACHUTE_HOME to your volume mount path (e.g. /data) in the machine env.");
  }

  const vaultName = pickVaultName(env);
  const modules = parseModuleList(env);

  const tier2 = modules.filter((m) => TIER2_MODULES.has(m));
  if (tier2.length > 0) {
    log(
      `bootstrap: ✗ module(s) ${tier2.join(", ")} are Tier 2 and not part of \`parachute deploy\` v1.`,
    );
    log("  Tier 1 is hub + vault + scribe + notes; Tier 2 (paraclaw) lands later.");
    return { exitCode: 1 };
  }

  log(
    `bootstrap: starting (modules: ${modules.join(", ")}, vault: ${vaultName}, configDir: ${dir})`,
  );

  // Persist CLAUDE_API_TOKEN into the config-dir .env when it's set. Tier 1
  // (vault/scribe/notes) doesn't require it — hub#133 dropped the hard gate
  // — but if the user did paste a token at deploy time we still thread it
  // through so an Anthropic-backed scribe provider (or Tier 2 paraclaw,
  // later) can pick it up without a second round-trip. ANTHROPIC_API_KEY is
  // the name the Anthropic SDK + scribe's anthropic provider both look for;
  // setting both covers the common cases and costs nothing.
  mkdirSync(dir, { recursive: true });
  const claudeToken = (env.CLAUDE_API_TOKEN ?? "").trim();
  if (claudeToken.length > 0) {
    persistTokenIntoEnvFile(join(dir, ".env"), claudeToken);
  }

  // install() is itself idempotent — the bun-add gate skips re-linking when
  // the package is already wired. That's what lets a failed mid-loop
  // bootstrap retry cleanly on the next boot without double-installing the
  // modules that already succeeded.
  for (const short of modules) {
    log(`bootstrap: — ${short} —`);
    const installOpts: BootstrapInstallOpts = {
      log,
      configDir: dir,
      ...opts.baseInstallOpts,
    };
    if (short === "vault") {
      installOpts.vaultName = vaultName;
    }
    if (short === "scribe") {
      const provider = (env.PARACHUTE_SCRIBE_PROVIDER ?? "").trim();
      const key = (env.PARACHUTE_SCRIBE_KEY ?? "").trim();
      if (provider.length > 0) installOpts.scribeProvider = provider;
      if (key.length > 0) installOpts.scribeKey = key;
    }
    const code = await installFn(short, installOpts);
    if (code !== 0) {
      log(
        `bootstrap: ✗ install ${short} exited ${code} — aborting, marker NOT written so the next boot retries.`,
      );
      return { exitCode: code };
    }
  }

  const marker: BootstrapMarker = {
    bootstrapped_at: now().toISOString(),
    modules: [...modules],
    vault_name: vaultName,
    parachute_version: version,
  };
  writeMarkerAtomic(markerPath, marker);
  log(`bootstrap: ✓ complete — marker written to ${markerPath}`);

  await postProvisionComplete(env, opts.fetchFn ?? fetch, log);
  return { exitCode: 0, marker };
}

/**
 * Push completion to the control plane when the env trio is set.
 *
 * All three of CALLBACK_URL + SECRET + TENANT_ID must be present; a partial
 * trio is treated as "not configured" so a stale fragment from manual
 * tinkering can't accidentally call the wrong endpoint. Failures here are
 * logged but never propagate — the marker is the source of truth for local
 * success, and a control-plane drift reconciler can fill the gap later.
 */
async function postProvisionComplete(
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
  log: (line: string) => void,
): Promise<void> {
  const url = (env.PARACHUTE_PROVISION_CALLBACK_URL ?? "").trim();
  const secret = (env.PARACHUTE_PROVISION_SECRET ?? "").trim();
  const tenantId = (env.PARACHUTE_TENANT_ID ?? "").trim();
  if (url.length === 0 || secret.length === 0 || tenantId.length === 0) {
    return;
  }
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: tenantId, secret }),
    });
    if (res.ok) {
      log(`bootstrap: ✓ control-plane callback acknowledged (${res.status})`);
    } else {
      log(`bootstrap: ⚠ control-plane callback returned ${res.status} — leaving for reconcile.`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`bootstrap: ⚠ control-plane callback failed: ${msg} — leaving for reconcile.`);
  }
}

/**
 * Atomic marker write — tmp + rename, mirroring `writeEnvFile` in env-file.ts.
 * Guards against the readMarker() check at next boot picking up a half-written
 * file if the process is killed mid-write (Fly host maintenance, OOM kill, etc).
 */
function writeMarkerAtomic(path: string, marker: BootstrapMarker): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`);
  renameSync(tmp, path);
}

function pickVaultName(env: NodeJS.ProcessEnv): string {
  const raw = (env.PARACHUTE_VAULT_NAME ?? "").trim();
  return raw.length > 0 ? raw : DEFAULT_VAULT_NAME;
}

function parseModuleList(env: NodeJS.ProcessEnv): string[] {
  const raw = (env.PARACHUTE_MODULES ?? "").trim();
  if (raw.length === 0) return [...DEFAULT_MODULES];
  const parts = raw
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  return parts.length > 0 ? parts : [...DEFAULT_MODULES];
}

function readMarker(path: string): BootstrapMarker | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BootstrapMarker;
  } catch {
    return null;
  }
}

function persistTokenIntoEnvFile(path: string, token: string): void {
  const parsed = parseEnvFile(path);
  let lines = parsed.lines;
  lines = upsertEnvLine(lines, "CLAUDE_API_TOKEN", token);
  lines = upsertEnvLine(lines, "ANTHROPIC_API_KEY", token);
  writeEnvFile(path, lines);
}

function readPackageVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}
