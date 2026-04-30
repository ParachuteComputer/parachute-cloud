// Admin CLI — internal-use binary for operating the fleet.
//
// Phase 3-(b) subcommands hit the admin HTTP endpoints (same code path
// as the cron tick) so an operator can manually kick the reconciler
// without waiting up to 15 minutes:
//
//   parachute-cloud-admin reconcile-tiers          POST /api/admin/reconcile-tiers
//   parachute-cloud-admin reconcile-terminations   POST /api/admin/reconcile-terminations
//   parachute-cloud-admin reconcile                POST /api/admin/reconcile
//
// Required env:
//   PARACHUTE_CLOUD_BASE_URL    e.g. https://parachute-cloud.workers.dev
//   PARACHUTE_CLOUD_ADMIN_BEARER  matches ADMIN_BEARER_SECRET in wrangler vars
//
// Future phase-2 subcommands (provision, destroy, list, tail, migrate)
// will go alongside these — they'll talk to the provider abstraction
// directly rather than via the worker.
//
// Bun-native shebang. No framework — flat argv parsing, same shape as
// parachute-hub/src/cli.ts.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AdminCliEnv {
  PARACHUTE_CLOUD_BASE_URL?: string;
  PARACHUTE_CLOUD_ADMIN_BEARER?: string;
}

export interface AdminCliDeps {
  env?: AdminCliEnv;
  fetchImpl?: FetchLike;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const RECONCILE_PATHS: Record<string, string> = {
  reconcile: "/api/admin/reconcile",
  "reconcile-tiers": "/api/admin/reconcile-tiers",
  "reconcile-terminations": "/api/admin/reconcile-terminations",
};

export async function main(argv: string[], deps: AdminCliDeps = {}): Promise<number> {
  const env = deps.env ?? (process.env as AdminCliEnv);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));

  const [cmd] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    out(usage());
    return cmd ? 0 : 2;
  }

  const path = RECONCILE_PATHS[cmd];
  if (!path) {
    err(`unknown command: ${cmd}`);
    err(usage());
    return 2;
  }

  const baseUrl = env.PARACHUTE_CLOUD_BASE_URL?.replace(/\/$/, "");
  const bearer = env.PARACHUTE_CLOUD_ADMIN_BEARER;
  if (!baseUrl) {
    err("PARACHUTE_CLOUD_BASE_URL is required");
    return 1;
  }
  if (!bearer) {
    err("PARACHUTE_CLOUD_ADMIN_BEARER is required");
    return 1;
  }

  const res = await fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}` },
  });
  const text = await res.text();
  if (!res.ok) {
    err(`HTTP ${res.status}: ${text}`);
    return 1;
  }
  // Pretty-print so an operator can read the report directly. The body
  // is small (one entry per pendingTier / terminating row), so JSON.stringify
  // is fine.
  try {
    out(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    out(text);
  }
  return 0;
}

function usage(): string {
  return [
    "usage: parachute-cloud-admin <command>",
    "",
    "commands:",
    "  reconcile                run both tier-change and termination passes",
    "  reconcile-tiers          drive pendingTier → tier via the provider",
    "  reconcile-terminations   destroy past-grace machines + GC retired rows",
    "",
    "env:",
    "  PARACHUTE_CLOUD_BASE_URL       worker URL (e.g. https://parachute-cloud.workers.dev)",
    "  PARACHUTE_CLOUD_ADMIN_BEARER   ADMIN_BEARER_SECRET value",
  ].join("\n");
}
