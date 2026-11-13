/**
 * scripts/staging-bootstrap.sh (remote steps) and the scripts/release/bunx key shim, run for real against a FAKE
 * Cloudflare: a stand-in `bunx wrangler` that keeps buckets, databases and secrets in a temp dir. Cloudflare is the one
 * thing faked; the scripts, the env file and copies of the real wrangler.tomls are the real ones.
 * (The local mode — miniflare, both workers under wrangler dev — is rehearsed by `staging-bootstrap.sh --local`.)
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readStagingAccount } from "../scripts/staging-origins.ts";

const ROOT = join(import.meta.dir, "..");
const STAGING = "5b543fa4332a619203356ae1418af504";
const PROD = "d5d7c8646c3b69ce9f16bfd12ecbe98a";
const FAKE_UUID = "1111aaaa-2222-4333-8444-555566667777";
const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const temps: string[] = [];
afterAll(() => temps.forEach((t) => rmSync(t, { recursive: true, force: true })));

const FAKE_WRANGLER = `#!/usr/bin/env bash
# a stand-in for \`bunx wrangler\` on one fake account kept in $FAKE_CF
echo "$CLOUDFLARE_ACCOUNT_ID $*" >> "$FAKE_CF/calls"
[ "$1" = wrangler ] || exit 9; shift
case "$1 $2" in
  "r2 bucket")
    if [ "$3" = list ]; then
      [ -f "$FAKE_CF/buckets" ] && while read -r b; do printf 'name:           %s\\ncreation_date:  2026-11-09\\n\\n' "$b"; done < "$FAKE_CF/buckets"; true
    else echo "$4" >> "$FAKE_CF/buckets"; echo "Created bucket $4"; fi ;;
  "d1 list")
    printf 'wrangler banner\\n['; sep=""
    [ -f "$FAKE_CF/d1" ] && while read -r n id; do printf '%s{"uuid":"%s","name":"%s"}' "$sep" "$id" "$n"; sep=,; done < "$FAKE_CF/d1"
    echo "]" ;;
  "d1 create") echo "$3 ${FAKE_UUID}" >> "$FAKE_CF/d1"; echo "Successfully created DB '$3'" ;;
  "secret bulk")
    w="$(basename "$PWD")"; stat -c %a "$3" > "$FAKE_CF/mode-$w"; cp "$3" "$FAKE_CF/secrets-$w.json"
    echo "✨ Success! Uploaded secrets" ;;
  *) echo "fake wrangler: unexpected $*" >&2; exit 9 ;;
esac
`;

function fixture() {
  const t = mkdtempSync(join(tmpdir(), "staging-bootstrap-"));
  temps.push(t);
  const root = join(t, "cloud");
  for (const f of ["scripts/staging-bootstrap.sh", "scripts/staging-account.env", "workers/identity/wrangler.toml", "workers/vault/wrangler.toml"]) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    cpSync(join(ROOT, f), join(root, f));
  }
  // The real files may already carry the real staging D1 id (bootstrapped on the real account, T-432b): a fixture
  // proves the fresh-account path, so it always starts from the placeholder here, whatever is actually committed.
  const envPath = join(root, "scripts/staging-account.env");
  const tomlPath = join(root, "workers/identity/wrangler.toml");
  const realId = readStagingAccount(envPath).STAGING_D1_ID!;
  const envLine = `STAGING_D1_ID=${realId}`;
  const tomlLine = `database_id = "${realId}"`;
  const envBody = readFileSync(envPath, "utf8");
  const tomlBody = readFileSync(tomlPath, "utf8");
  if (!envBody.includes(envLine)) throw new Error(`fixture: '${envLine}' not found in ${envPath}`);
  if (!tomlBody.includes(tomlLine)) throw new Error(`fixture: '${tomlLine}' not found in ${tomlPath}`);
  writeFileSync(envPath, envBody.replace(envLine, `STAGING_D1_ID=${PLACEHOLDER}`));
  writeFileSync(tomlPath, tomlBody.replace(tomlLine, `database_id = "${PLACEHOLDER}"`));

  const bin = join(t, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bunx"), FAKE_WRANGLER);
  chmodSync(join(bin, "bunx"), 0o755);
  const cf = join(t, "cf");
  mkdirSync(cf);
  const secrets = join(t, "secrets");
  mkdirSync(secrets);
  return { t, root, bin, cf, secrets };
}

function run(fx: ReturnType<typeof fixture>, args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: `${fx.bin}:${process.env.PATH}`, FAKE_CF: fx.cf, ...extraEnv };
  delete env.UNI_SEALED_ACCOUNT_ID;
  Object.assign(env, extraEnv);
  const p = Bun.spawnSync(["bash", join(fx.root, "scripts/staging-bootstrap.sh"), ...args], { env, cwd: fx.t });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}
const calls = (cf: string) => (existsSync(join(cf, "calls")) ? readFileSync(join(cf, "calls"), "utf8").trim().split("\n") : []);
const stagingDbId = (root: string) =>
  (Bun.TOML.parse(readFileSync(join(root, "workers/identity/wrangler.toml"), "utf8")) as any).env.staging.d1_databases[0].database_id;
const prodDbId = (root: string) =>
  (Bun.TOML.parse(readFileSync(join(root, "workers/identity/wrangler.toml"), "utf8")) as any).d1_databases[0].database_id;

describe("staging-bootstrap.sh against a fake Cloudflare", () => {
  test("a fresh account: makes the bucket and D1, writes the id, sets only allowlisted secrets, prints no value", () => {
    const fx = fixture();
    writeFileSync(join(fx.secrets, "OPS_RUN_TOKEN"), "run-value-123\n");
    writeFileSync(join(fx.secrets, "OPS_READ_TOKEN"), "read-value-456");
    writeFileSync(join(fx.secrets, "VAULT_AUTH_TOKEN"), "vault-value-789");
    writeFileSync(join(fx.secrets, "NOT_A_SECRET"), "stray-value");
    const prodBefore = prodDbId(fx.root);
    const r = run(fx, ["--steps", "r2,d1,secrets", "--secrets-dir", fx.secrets]);
    expect(r.code, r.out).toBe(0);
    const c = calls(fx.cf);
    expect(c.every((l) => l.startsWith(`${STAGING} `))).toBe(true); // every call on the staging account
    expect(c.filter((l) => l.includes("r2 bucket create parachute-vault-staging"))).toHaveLength(1);
    expect(c.filter((l) => l.includes("d1 create parachute-identity-staging"))).toHaveLength(1);
    expect(stagingDbId(fx.root)).toBe(FAKE_UUID);
    expect(prodDbId(fx.root)).toBe(prodBefore);
    expect(readFileSync(join(fx.root, "scripts/staging-account.env"), "utf8")).toContain(`STAGING_D1_ID=${FAKE_UUID}\n`);
    expect(JSON.parse(readFileSync(join(fx.cf, "secrets-identity.json"), "utf8"))).toEqual({
      OPS_RUN_TOKEN: "run-value-123",
      OPS_READ_TOKEN: "read-value-456",
    });
    expect(JSON.parse(readFileSync(join(fx.cf, "secrets-vault.json"), "utf8"))).toEqual({ VAULT_AUTH_TOKEN: "vault-value-789" });
    expect(readFileSync(join(fx.cf, "mode-identity"), "utf8").trim()).toBe("600");
    for (const v of ["run-value-123", "read-value-456", "vault-value-789", "stray-value"]) expect(r.out).not.toContain(v);

    // A second run finds both and changes nothing.
    const again = run(fx, ["--steps", "r2,d1"]);
    expect(again.code, again.out).toBe(0);
    expect(calls(fx.cf).filter((l) => / (r2 bucket|d1) create /.test(l))).toHaveLength(2);
    expect(stagingDbId(fx.root)).toBe(FAKE_UUID);
  });

  test("refuses a live-mode Stripe key before any secret is sent, wherever it sits in the file", () => {
    for (const body of ["sk_live_abc", "\n  sk_live_abc\n", " rk_live_abc"]) {
      const fx = fixture();
      writeFileSync(join(fx.secrets, "STRIPE_SECRET_KEY"), body);
      const r = run(fx, ["--steps", "secrets", "--secrets-dir", fx.secrets]);
      expect(r.code).toBe(2);
      expect(r.out).toContain("live-mode Stripe key");
      expect(calls(fx.cf).filter((l) => l.includes("secret bulk"))).toEqual([]);
    }
  });

  test("deploy-staging.sh refuses before any install or call while the D1 id is the placeholder or disagrees", () => {
    const fx = fixture();
    cpSync(join(ROOT, "scripts/deploy-staging.sh"), join(fx.root, "scripts/deploy-staging.sh"));
    // deploy-staging.sh first refuses an engine line staging doesn't take (0.8 and 0.9 only, T-456); then the D1
    // checks run, on this checkout's own pin (0.9 on door/0.9) and on an 0.8 one.
    const pin = join(fx.root, "scripts/core-source.env");
    writeFileSync(pin, 'PARACHUTE_CORE_VERSION="1.0.0"\n');
    const deploy = () => {
      const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: `${fx.bin}:${process.env.PATH}`, FAKE_CF: fx.cf };
      const p = Bun.spawnSync(["bash", join(fx.root, "scripts/deploy-staging.sh")], { env, cwd: fx.t });
      return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
    };
    let r = deploy();
    expect(r.code).toBe(2);
    expect(r.out).toContain("refused: this checkout pins an engine staging doesn't take");
    for (const pinned of [readFileSync(join(ROOT, "scripts/core-source.env"), "utf8"), 'PARACHUTE_CORE_VERSION="0.8.0-pre.2"\n']) {
      writeFileSync(pin, pinned);
      r = deploy(); // as committed: the placeholder
      expect(r.code).toBe(2);
      expect(r.out).toContain("staging-bootstrap.sh");
    }
    const f = join(fx.root, "scripts/staging-account.env"); // the env file names an id the toml does not
    writeFileSync(f, readFileSync(f, "utf8").replace(/^STAGING_D1_ID=.*$/m, `STAGING_D1_ID=${FAKE_UUID}`));
    r = deploy();
    expect(r.code).toBe(2);
    expect(calls(fx.cf)).toEqual([]);
  });

  test("refuses a sealed job on the production account before any call", () => {
    const fx = fixture();
    const r = run(fx, ["--steps", "r2,d1"], { UNI_SEALED_ACCOUNT_ID: PROD });
    expect(r.code).toBe(2);
    expect(calls(fx.cf)).toEqual([]);
  });

  test("never makes a second D1 when the file already names one the account lacks", () => {
    const fx = fixture();
    const f = join(fx.root, "scripts/staging-account.env");
    writeFileSync(f, readFileSync(f, "utf8").replace(/^STAGING_D1_ID=.*$/m, "STAGING_D1_ID=99999999-9999-4999-8999-999999999999"));
    const r = run(fx, ["--steps", "d1"]);
    expect(r.code).toBe(2);
    expect(calls(fx.cf).filter((l) => l.includes("d1 create"))).toEqual([]);
  });
});

describe("staging-bootstrap.sh subdomain step against a fake Cloudflare API", () => {
  // A stand-in curl: answers the workers/subdomain endpoint from $FAKE_CF/subdomain, logs its argv, and reads the
  // header file it was given (so the test sees the token arrived without it ever being on argv).
  const FAKE_CURL = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_CF/curl-argv"
m=GET; prev=""; for a in "$@"; do
  [ "$prev" = -X ] && m="$a"
  case "$a" in @*) cat "\${a#@}" >> "$FAKE_CF/curl-headers" ;; esac
  prev="$a"
done
case "$m" in
  GET) if [ -s "$FAKE_CF/subdomain" ]; then printf '{"success":true,"result":{"subdomain":"%s"}}' "$(cat "$FAKE_CF/subdomain")"
       else printf '{"success":false,"errors":[{"code":10007,"message":"no subdomain"}]}'; fi ;;
  PUT) echo parachute-staging > "$FAKE_CF/subdomain"; printf '{"success":true,"result":{"subdomain":"parachute-staging"}}' ;;
esac
`;
  function withCurl() {
    const fx = fixture();
    writeFileSync(join(fx.bin, "curl"), FAKE_CURL);
    chmodSync(join(fx.bin, "curl"), 0o755);
    return fx;
  }
  const TOKEN = "made-up-token-0123456789";

  test("an account with no subdomain gets the configured one; the token is never on argv", () => {
    const fx = withCurl();
    const r = run(fx, ["--steps", "subdomain"], { CLOUDFLARE_API_TOKEN: TOKEN });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("registered");
    const argv = readFileSync(join(fx.cf, "curl-argv"), "utf8");
    expect(argv).toContain(`/accounts/${STAGING}/workers/subdomain`);
    expect(argv).not.toContain(TOKEN);
    expect(readFileSync(join(fx.cf, "curl-headers"), "utf8")).toContain(`authorization: Bearer ${TOKEN}`);
    expect(r.out).not.toContain(TOKEN);
    expect(run(fx, ["--steps", "subdomain"], { CLOUDFLARE_API_TOKEN: TOKEN }).out).toContain("already set");
  });

  test("an account with another subdomain is refused, not renamed", () => {
    const fx = withCurl();
    writeFileSync(join(fx.cf, "subdomain"), "someone-else\n");
    const r = run(fx, ["--steps", "subdomain"], { CLOUDFLARE_API_TOKEN: TOKEN });
    expect(r.code).toBe(2);
    expect(r.out).toContain("'someone-else'");
    expect(readFileSync(join(fx.cf, "curl-argv"), "utf8")).not.toContain("PUT");
  });

  test("without a token the step is skipped and nothing is called", () => {
    const fx = withCurl();
    const env = { CLOUDFLARE_API_TOKEN: "" };
    const r = run(fx, ["--steps", "subdomain"], env);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("skipped");
    expect(existsSync(join(fx.cf, "curl-argv"))).toBe(false);
  });
});

describe("scripts/release/bunx on the staging account", () => {
  // The sealed CLI stand-in: logs the template asked for, hands a made-up key on a fd, runs the command.
  const FAKE_SEALED = `#!/usr/bin/env bash
shift 2; [ "$1" = job-child ] || exit 9; echo "tpl=$2" >> "$SHIM_TEST_LOG"; shift 3
exec 3< <(printf made-up-key); UNI_SEALED_FD=3 exec "$@"
`;
  const FAKE_REAL = `#!/usr/bin/env bash
echo "real key=\${CLOUDFLARE_API_TOKEN:+set} $*" >> "$SHIM_TEST_LOG"
case "$2" in
  deploy) echo "Uploaded x"; echo "Current Version ID: 0123abcd-0000-4000-8000-000000000001" ;;
  versions) [ "$3" = upload ] && echo "Version ID: 0123abcd-0000-4000-8000-000000000002"; echo ok ;;
  *) echo ok ;;
esac
`;
  function shim(account: string, args: string[], shimPath = join(ROOT, "scripts/release/bunx")) {
    const t = mkdtempSync(join(tmpdir(), "shim-"));
    temps.push(t);
    for (const [n, body] of [["py", FAKE_SEALED], ["real", FAKE_REAL]] as const) {
      writeFileSync(join(t, n), body);
      chmodSync(join(t, n), 0o755);
    }
    writeFileSync(join(t, "wrangler.toml"), 'name = "parachute-vault-do"\n');
    mkdirSync(join(t, "Code", "uni-ops"), { recursive: true }); // the shim runs the sealed CLI from ~/Code/uni-ops
    const log = join(t, "log");
    const deployed = join(t, "deployed");
    const p = Bun.spawnSync(["bash", shimPath, "wrangler", ...args], {
      cwd: t,
      env: { ...(process.env as Record<string, string>), PY: join(t, "py"), SEALED: "unused", REAL_BUNX: join(t, "real"),
        SHIM_TEST_LOG: log, DEPLOYED_LOG: deployed, UNI_SEALED_ACCOUNT_ID: account, SHIM_TRIES: "1", HOME: t },
    });
    const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
    return { code: p.exitCode, log: read(log), deployed: read(deployed), err: p.stderr.toString() };
  }

  test("a staging deploy stays a plain deploy (a new account has no worker for versions upload)", () => {
    const r = shim(STAGING, ["deploy", "--env", "staging"]);
    expect(r.code, r.err).toBe(0);
    expect(r.log).toContain("tpl=workers-scripts-write");
    expect(r.log).toContain("real key=set wrangler deploy --env staging");
    expect(r.log).not.toContain("versions");
    expect(r.deployed.trim()).toBe("parachute-vault-do-staging 0123abcd-0000-4000-8000-000000000001");
  });

  test("on the production account a deploy is still versions upload + versions deploy", () => {
    const r = shim(PROD, ["deploy", "--env", "staging"]);
    expect(r.code, r.err).toBe(0);
    expect(r.log).toContain("wrangler versions upload");
    expect(r.log).toContain("wrangler versions deploy 0123abcd-0000-4000-8000-000000000002@100%");
    expect(r.log).not.toMatch(/wrangler deploy\b/);
  });

  test("every spelling of the staging env passes through; any other env is refused", () => {
    for (const args of [["deploy", "-e", "staging"], ["deploy", "--env=staging"]]) {
      const r = shim(STAGING, args);
      expect(r.code, r.err).toBe(0);
      expect(r.log).toContain(`real key=set wrangler ${args.join(" ")}`);
    }
    const other = shim(STAGING, ["deploy", "--env", "production"]);
    expect(other.code).toBe(2);
    expect(other.log).toBe("");
  });

  test("on the staging account a deploy without --env staging is refused", () => {
    const r = shim(STAGING, ["deploy"]);
    expect(r.code).toBe(2);
    expect(r.log).toBe("");
  });

  test("the shim reads staging-account.env as bash does: a trailing comment does not drop the plain deploy", () => {
    const t = mkdtempSync(join(tmpdir(), "shim-env-"));
    temps.push(t);
    mkdirSync(join(t, "scripts", "release"), { recursive: true });
    cpSync(join(ROOT, "scripts/release/bunx"), join(t, "scripts/release/bunx"));
    const env = readFileSync(join(ROOT, "scripts/staging-account.env"), "utf8");
    writeFileSync(join(t, "scripts/staging-account.env"), env.replace(/^STAGING_ACCOUNT_ID=(\w+)$/m, "STAGING_ACCOUNT_ID=$1   # Parachute Staging"));
    const r = shim(STAGING, ["deploy", "--env", "staging"], join(t, "scripts/release/bunx"));
    expect(r.code, r.err).toBe(0);
    expect(r.log).toContain("real key=set wrangler deploy --env staging");
  });

  test("r2 calls ask for r2-admin", () => {
    const r = shim(STAGING, ["r2", "bucket", "create", "parachute-vault-staging"]);
    expect(r.code, r.err).toBe(0);
    expect(r.log).toContain("tpl=r2-admin");
  });
});
