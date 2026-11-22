/**
 * The personal door's public name (deploy/personal, PUBLIC_DOMAIN, T-335). Since #428 the identity worker of a
 * single-owner door hands /vault/*, /mcp and their discovery documents to the vault worker over VAULT_SERVICE, so one
 * Custom Domain on the identity carries the whole door. This renders real configs from a profile and pins:
 *
 *   - the identity worker takes the name as a Custom Domain, the vault worker no route at all, and the identity keeps
 *     what its hand-over needs (OWNER_PUBKEY and the VAULT_SERVICE binding to this door's vault worker);
 *   - the issuer, APP_ORIGIN and VAULT_ORIGIN stay the workers.dev names (every token, key and connection made
 *     before keeps working), workers.dev stays on, and the name is a bound origin and the advertised vault origin;
 *   - without PUBLIC_DOMAIN: no route, no bound origin, and the door gives out its own origin (#428's one address);
 *   - a parachute.computer or workers.dev name, and the retired VAULT_DOMAIN / IDENTITY_DOMAIN / PUBLIC_ZONE, are
 *     refused;
 *   - ./wr asks the broker for the template the job holds: d1-write, r2-admin, workers-scripts-write by subcommand, or
 *     WR_TEMPLATE for every call (a public name's job holds worker-app alone; a d1-write child there is refused
 *     mid-deploy).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Route {
  pattern: string;
  custom_domain?: boolean;
  zone_name?: string;
}
interface Rendered {
  workers_dev?: boolean;
  routes?: Route[];
  vars: Record<string, string>;
  services?: { binding: string; service: string }[];
}

const ROOT = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "personal-domain-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const OWNER = "a".repeat(64);
const ADMIN = "b".repeat(64);
const D1 = "00000000-0000-0000-0000-000000000000";

function render(extra: string): { code: number; err: string; identity?: Rendered; vault?: Rendered } {
  const profile = join(dir, `p-${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(profile, `PREFIX=aaron-parachute\nOWNER_PUBKEY=${OWNER}\nADMIN_PUBKEYS=${ADMIN}\nOWNER_PLAN=power\n${extra}\n`);
  const r = Bun.spawnSync(["bash", join(ROOT, "deploy/personal/render.sh"), profile, D1, "unforced"], { stderr: "pipe", stdout: "pipe" });
  if (r.exitCode !== 0) return { code: r.exitCode ?? -1, err: r.stderr.toString() };
  const read = (w: string) => Bun.TOML.parse(readFileSync(join(ROOT, `workers/${w}/wrangler.personal.gen.toml`), "utf8")) as Rendered;
  return { code: 0, err: "", identity: read("identity"), vault: read("vault") };
}

const ISSUER = "https://aaron-parachute-identity.unforced.workers.dev";
const VAULT_ORIGIN = "https://aaron-parachute-vault.unforced.workers.dev";

describe("personal door with a public name", () => {
  const r = render("PUBLIC_DOMAIN=parachute.unforced.dev");

  it("renders", () => {
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
  });

  it("puts the name on identity as a Custom Domain and no route on the vault: the identity hands vault paths over", () => {
    expect(r.identity!.routes).toEqual([{ pattern: "parachute.unforced.dev", custom_domain: true }]);
    expect(r.vault!.routes).toEqual([]);
    // the hand-over (#428 forwardsVaults) needs both: a single owner and the binding to this door's vault worker
    expect(r.identity!.vars.OWNER_PUBKEY).toBe(OWNER);
    expect(r.identity!.services).toEqual([{ binding: "VAULT_SERVICE", service: "aaron-parachute-vault" }]);
  });

  it("keeps the issuer and the workers.dev names, and adds the name as a bound and advertised origin", () => {
    const v = r.identity!.vars;
    expect(v.ISSUER).toBe(ISSUER);
    expect(v.APP_ORIGIN).toBe(ISSUER);
    expect(v.VAULT_ORIGIN).toBe(VAULT_ORIGIN);
    expect(v.BOUND_ORIGINS).toBe("https://parachute.unforced.dev");
    expect(v.VAULT_PUBLIC_ORIGIN).toBe("https://parachute.unforced.dev");
    expect(r.vault!.vars.ISSUER_ORIGIN).toBe(ISSUER);
    expect(r.vault!.vars.ALLOWED_ISSUERS).toBeUndefined();
    expect(r.identity!.workers_dev).toBe(true);
    expect(r.vault!.workers_dev).toBe(true);
  });
});

describe("personal door without a public name", () => {
  const r = render("");

  it("has no routes and no bound origin, and gives out its own origin (one address)", () => {
    expect(r.code).toBe(0);
    expect(r.identity!.routes).toEqual([]);
    expect(r.vault!.routes).toEqual([]);
    expect("BOUND_ORIGINS" in r.identity!.vars).toBe(false);
    expect(r.identity!.vars.VAULT_PUBLIC_ORIGIN).toBe(ISSUER);
    expect(r.identity!.vars.ISSUER).toBe(ISSUER);
  });
});

describe("refusals", () => {
  it.each([
    ["a parachute.computer name", "PUBLIC_DOMAIN=me.parachute.computer"],
    ["a workers.dev name", "PUBLIC_DOMAIN=x.unforced.workers.dev"],
    ["a name that isn't a plain host", "PUBLIC_DOMAIN=https://parachute.unforced.dev"],
    ["the retired PUBLIC_ZONE", "PUBLIC_DOMAIN=parachute.unforced.dev\nPUBLIC_ZONE=unforced.dev"],
    ["the retired VAULT_DOMAIN", "VAULT_DOMAIN=vault.unforced.dev"],
    ["the retired IDENTITY_DOMAIN", "IDENTITY_DOMAIN=id.unforced.dev"],
  ])("refuses %s", (_why, extra) => {
    const r = render(extra);
    expect(r.code).toBe(2);
    expect(r.err).toContain("refused");
  });
});

describe("wr's child key template", () => {
  // A stand-in for the broker's CLI: records the template wr asks a child for, and succeeds.
  const log = join(dir, "templates.log");
  const stub = join(dir, "sealed-stub.sh");
  writeFileSync(stub, `#!/usr/bin/env bash\necho "$4" >> ${JSON.stringify(log)}\n`);
  chmodSync(stub, 0o755);
  // wr runs the broker's CLI from $HOME/Code/uni-ops: a home of the test's own, so it runs where that folder doesn't exist
  const home = join(dir, "home");
  mkdirSync(join(home, "Code/uni-ops"), { recursive: true });
  const ask = (args: string[], extra: Record<string, string> = {}) => {
    writeFileSync(log, "");
    const r = Bun.spawnSync(["bash", join(ROOT, "deploy/personal/wr"), ...args], {
      env: { ...process.env, HOME: home, UNI_SEALED_ACCOUNT_ID: "f".repeat(32), PY: stub, WR_TRIES: "1", ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    return readFileSync(log, "utf8").trim();
  };

  it("picks by subcommand without WR_TEMPLATE", () => {
    expect(ask(["d1", "list"])).toBe("d1-write");
    expect(ask(["r2", "bucket", "create", "x"])).toBe("r2-admin");
    expect(ask(["deploy"])).toBe("workers-scripts-write");
    expect(ask(["--api", "workers/subdomain"])).toBe("workers-scripts-write");
  });

  it("keeps the child key out of curl's argv for --api (header on stdin)", () => {
    // The broker stand-in hands the command a made-up key on a file descriptor, as job-child does; a stand-in curl
    // records its argv and stdin.
    const key = "made-up-key-" + "k".repeat(20);
    const keyFile = join(dir, "child.key");
    writeFileSync(keyFile, key);
    const seen = join(dir, "curl-seen");
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\n{ printf 'ARGV %s\\n' "$*"; printf 'STDIN '; cat; } > ${JSON.stringify(seen)}\necho '{}'\n`);
    chmodSync(join(bin, "curl"), 0o755);
    const child = join(dir, "sealed-child.sh");
    writeFileSync(child, `#!/usr/bin/env bash\nshift 5\nexec 9< ${JSON.stringify(keyFile)}\nUNI_SEALED_FD=9 exec "$@"\n`);
    chmodSync(child, 0o755);
    const r = Bun.spawnSync(["bash", join(ROOT, "deploy/personal/wr"), "--api", "workers/subdomain"], {
      env: { ...process.env, HOME: home, UNI_SEALED_ACCOUNT_ID: "f".repeat(32), PY: child, WR_TRIES: "1", PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    const got = readFileSync(seen, "utf8");
    expect(got).toContain("ARGV -fsS -H @- https://api.cloudflare.com/client/v4/accounts/" + "f".repeat(32) + "/workers/subdomain");
    expect(got.split("STDIN")[0]).not.toContain(key);
    expect(got).toContain("STDIN Authorization: Bearer " + key);
  });

  it("uses WR_TEMPLATE for every call", () => {
    for (const args of [["d1", "list"], ["r2", "bucket", "create", "x"], ["deploy"], ["--api", "workers/subdomain"]]) {
      expect(ask(args, { WR_TEMPLATE: "worker-app" })).toBe("worker-app");
    }
  });
});
