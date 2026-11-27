import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const hubRepo = resolve(root, "../parachute-hub");
const appRepoName = read("scripts/spa-source.env").match(/^SPA_APP_REPO="([\w.-]+\/[\w.-]+)"$/m)?.[1];
if (!appRepoName) throw new Error("scripts/spa-source.env names no App repository");
const appRepo = resolve(root, "..", appRepoName.split("/")[1] as string);
const appRef = read("scripts/spa-source.env").match(/SPA_APP_REF="([0-9a-f]{40})"/)?.[1];
if (!appRef) throw new Error("scripts/spa-source.env has no valid App ref");
const doorContractHelper = resolve(root, "scripts/materialize-door-contract.sh");
const doorContractRef = read("scripts/door-contract-source.env").match(/DOOR_CONTRACT_HUB_REF="([0-9a-f]{40})"/)?.[1];
if (!doorContractRef) throw new Error("scripts/door-contract-source.env has no valid Hub ref");
const tempDirs: string[] = [];

afterAll(() => {
  for (const path of tempDirs) rmSync(path, { recursive: true, force: true });
});

function runDoorContractHelper(sourceFile?: string) {
  return Bun.spawnSync(["bash", doorContractHelper], {
    cwd: root,
    env: {
      ...process.env,
      PARACHUTE_HUB_REPO: hubRepo,
      ...(sourceFile ? { DOOR_CONTRACT_SOURCE_FILE: sourceFile } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function makePinnedHubClone(prefix: string): string {
  const temp = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(temp);
  const hub = resolve(temp, "hub");
  const clone = Bun.spawnSync(["git", "clone", "--shared", "--no-checkout", hubRepo, hub], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(clone.exitCode, clone.stderr.toString()).toBe(0);
  const checkout = Bun.spawnSync(["git", "-C", hub, "checkout", "--detach", doorContractRef as string], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(checkout.exitCode, checkout.stderr.toString()).toBe(0);
  return hub;
}

describe("served SPA source", () => {
  test("builds the pinned Parachute App at the origin root", () => {
    const sourcePin = read("scripts/spa-source.env");
    const script = read("scripts/build-spa.sh");

    // The version moves with every pin bump; the shape (and build-spa.sh's check of it) is the contract.
    expect(sourcePin).toMatch(/SPA_APP_VERSION="\d+\.\d+\.\d+(-rc\.\d+)?"/);
    expect(sourcePin).toMatch(/SPA_APP_REF="[0-9a-f]{40}"/);
    // the pin says which repository and package it is: one of the two Cloud can serve
    expect(sourcePin).toMatch(/^SPA_APP_REPO="ParachuteComputer\/(?:parachute-app|parachute)"$/m);
    expect(sourcePin).toMatch(/^SPA_APP_NAME="(?:@openparachute\/app|parachute)"$/m);
    expect(script).toContain('source "${SPA_SOURCE_FILE:-$ROOT/scripts/spa-source.env}"');
    expect(script).toContain("SPA_APP_REF");
    expect(script).toContain("git rev-parse HEAD");
    expect(script).toContain("APP_REPO");
    expect(script).toContain('"$ACTUAL_NAME" != "$SPA_APP_NAME"');
    expect(script).toContain('VITE_BASE_PATH="/" bun run build');
    expect(script).toContain("npm ci");
    expect(script).not.toContain("@openparachute/notes-ui");
    expect(script).not.toContain("SURFACE_REPO");
    // Pages-era artifacts must be stripped post-copy: wrangler hard-rejects the
    // app's Pages-style _redirects at deploy (code 100324 — cloud#156).
    expect(script).toContain('rm -f "$DEST/CNAME" "$DEST/_redirects"');
  });

  test("rejects an untracked App public asset before building", () => {
    const temp = mkdtempSync(resolve(tmpdir(), "parachute-cloud-dirty-app-"));
    tempDirs.push(temp);
    const app = resolve(temp, "app");
    const clone = Bun.spawnSync(["git", "clone", "--shared", "--no-checkout", appRepo, app], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(clone.exitCode, clone.stderr.toString()).toBe(0);
    const checkout = Bun.spawnSync(["git", "-C", app, "checkout", "--detach", appRef], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(checkout.exitCode, checkout.stderr.toString()).toBe(0);
    mkdirSync(resolve(app, "public"), { recursive: true });
    writeFileSync(resolve(app, "public/untracked-review-asset.txt"), "must not deploy\n");

    const result = Bun.spawnSync(["bash", resolve(root, "scripts/build-spa.sh")], {
      cwd: root,
      env: { ...process.env, APP_REPO: app, SPA_DEST: resolve(temp, "dist-assets") },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("tracked or untracked local modifications");
  });

  // The Parachute app's web build, as the pin will name it: a package built with
  // npm that says what it asks of a host. A made-up package stands in for it here
  // (no network: it has no dependencies), through the real script.
  function madeUpNpmApp(csp: string, name = "parachute") {
    const temp = mkdtempSync(resolve(tmpdir(), "parachute-cloud-npm-app-"));
    tempDirs.push(temp);
    const app = resolve(temp, "parachute");
    mkdirSync(app, { recursive: true });
    const build = `const fs=require("fs");fs.mkdirSync("dist",{recursive:true});fs.writeFileSync("dist/index.html",'<!doctype html><div id="root"></div><script type="module" src="/assets/x.js"></script>');fs.writeFileSync("dist/hosted.json",JSON.stringify({contract:1,csp:${JSON.stringify(csp)},spa:["/"]}));`;
    writeFileSync(resolve(app, "build.cjs"), build);
    writeFileSync(resolve(app, ".gitignore"), "dist/\nnode_modules/\n");
    writeFileSync(resolve(app, "package.json"), JSON.stringify({ name, version: "0.1.0", private: true, scripts: { build: "node build.cjs" } }));
    writeFileSync(resolve(app, "package-lock.json"), JSON.stringify({ name, version: "0.1.0", lockfileVersion: 3, requires: true, packages: { "": { name, version: "0.1.0" } } }));
    const git = (...a: string[]) => { const r = Bun.spawnSync(["git", "-C", app, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { stdout: "pipe", stderr: "pipe" }); expect(r.exitCode, r.stderr.toString()).toBe(0); return r.stdout.toString().trim(); };
    git("init", "-q"); git("add", "-A"); git("commit", "-q", "-m", "a made-up app");
    const pin = resolve(temp, "spa-source.env");
    writeFileSync(pin, `SPA_APP_REPO="ParachuteComputer/parachute"\nSPA_APP_NAME="parachute"\nSPA_APP_VERSION="0.1.0"\nSPA_APP_REF="${git("rev-parse", "HEAD")}"\n`);
    const dest = resolve(temp, "dist-assets");
    const run = () => Bun.spawnSync(["bash", resolve(root, "scripts/build-spa.sh")], { cwd: root, env: { ...process.env, APP_REPO: app, SPA_DEST: dest, SPA_SOURCE_FILE: pin }, stdout: "pipe", stderr: "pipe" });
    return { dest, run };
  }
  const HOSTED_ASKS = "default-src 'self'; connect-src 'self' https: wss:; img-src 'self' data: blob: https:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-src about:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

  test("builds an npm app that says what it asks of a host, and sends Cloud's policy for it", () => {
    const { dest, run } = madeUpNpmApp(HOSTED_ASKS);
    const result = run();
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(resolve(dest, "index.html"))).toBe(true);
    const headers = readFileSync(resolve(dest, "_headers"), "utf8");
    expect(headers).toContain("script-src 'self' 'unsafe-inline'");
    expect(headers).toContain("frame-src about:");
  }, 120_000);

  test("refuses an npm app that asks for a policy Cloud hasn't reviewed, and a package that isn't the pin's", () => {
    const wider = madeUpNpmApp(HOSTED_ASKS.replace("frame-src about:", "frame-src *"));
    const refused = wider.run();
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toString()).toContain("asks for a policy Cloud hasn't reviewed");
    const other = madeUpNpmApp(HOSTED_ASKS, "not-parachute");
    const named = other.run();
    expect(named.exitCode).not.toBe(0);
    expect(named.stderr.toString()).toContain("expected parachute at");
  }, 120_000);

  test("materializes and verifies the pinned shared door contract", () => {
    const script = read("scripts/materialize-door-contract.sh");
    expect(script).toContain('source "$SOURCE_FILE"');
    expect(script).toContain("DOOR_CONTRACT_HUB_REF");
    expect(script).toContain("DOOR_CONTRACT_VERSION");
    expect(script).toContain("git -C \"$HUB_REPO\" rev-parse HEAD");
    expect(script).toContain("status --porcelain -- packages/door-contract");
    expect(script).toContain('rm -rf "$PACKAGE_DIR/dist"');
    expect(script).toContain("bunx --package=typescript@5.6.3 tsc");

    const pinnedHub = makePinnedHubClone("parachute-cloud-pinned-hub-");
    const result = Bun.spawnSync(["bash", doorContractHelper], {
      cwd: root,
      env: { ...process.env, PARACHUTE_HUB_REPO: pinnedHub },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("door-contract v0.6.1");
    expect(existsSync(resolve(pinnedHub, "packages/door-contract/dist/index.js"))).toBe(true);
  });

  test("rejects a Hub checkout that does not match the configured source pin", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "cloud-door-contract-pin-"));
    tempDirs.push(dir);
    const sourceFile = resolve(dir, "source.env");
    writeFileSync(
      sourceFile,
      'DOOR_CONTRACT_VERSION="0.4.0"\nDOOR_CONTRACT_HUB_REF="0000000000000000000000000000000000000000"\n',
    );

    const result = runDoorContractHelper(sourceFile);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Hub checkout is not the pinned door-contract source");
  });

  test("rejects a dirty inherited Hub tsconfig build input", () => {
    const hub = makePinnedHubClone("parachute-cloud-dirty-hub-");
    appendFileSync(resolve(hub, "tsconfig.json"), "\n// dirty inherited build input\n");

    const result = Bun.spawnSync(["bash", doorContractHelper], {
      cwd: root,
      env: { ...process.env, PARACHUTE_HUB_REPO: hub },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("build inputs have local modifications");
    expect(result.stderr.toString()).toContain("tsconfig.json");
  });

  for (const workflow of ["deploy-staging.yml", "deploy-prod.yml"]) {
    test(`${workflow} checks out Parachute App for the asset build`, () => {
      const source = read(`.github/workflows/${workflow}`);

      // the checkout follows the pin: its repository, in a sibling directory of that name
      expect(source).toContain('"https://github.com/$SPA_APP_REPO.git"');
      expect(source).toContain('APP_REPO="$GITHUB_WORKSPACE/../${SPA_APP_REPO##*/}"');
      expect(source).not.toContain("parachute-app.git");
      expect(source).not.toContain("ParachuteComputer/parachute-surface.git");
      expect(source).not.toContain("SPA_ALLOW_VERSION_DRIFT");
    });

    test(`${workflow} materializes the pinned contract before deploying`, () => {
      const source = read(`.github/workflows/${workflow}`);
      const helper = source.indexOf("bash scripts/materialize-door-contract.sh");
      const deploy = source.indexOf(`bash scripts/${workflow === "deploy-prod.yml" ? "deploy-prod" : "deploy-staging"}.sh`);

      expect(helper).toBeGreaterThan(-1);
      expect(deploy).toBeGreaterThan(helper);
    });
  }

  test("ordinary CI fetches the pinned App for the executable source-boundary regression", () => {
    const source = read(".github/workflows/ci.yml");
    const controlPlane = source.slice(source.indexOf("  control-plane:"));
    expect(controlPlane).toContain("source scripts/spa-source.env");
    expect(controlPlane).toContain('git -C "$APP_REPO" fetch --depth 1 origin "$SPA_APP_REF"');
    expect(controlPlane).toContain('test "$(git -C "$APP_REPO" rev-parse HEAD)" = "$SPA_APP_REF"');
    expect(controlPlane.indexOf("source scripts/spa-source.env")).toBeLessThan(controlPlane.indexOf("run: bun run test"));
  });

  test("ordinary CI uses the same pinned contract helper before every install", () => {
    const source = read(".github/workflows/ci.yml");
    // The two workers, the door contracts (which run both workers) and the control plane.
    expect(source.match(/bash scripts\/materialize-door-contract\.sh/g)).toHaveLength(4);
    expect(source.match(/run: bun install/g)).toHaveLength(4);

    const installJobs = source
      .split(/^  (?=[a-z].*:$)/m)
      .filter((job) => job.includes("run: bun install"));
    expect(installJobs).toHaveLength(4);
    for (const job of installJobs) {
      const helper = job.indexOf("bash scripts/materialize-door-contract.sh");
      const install = job.indexOf("run: bun install");
      expect(helper).toBeGreaterThan(-1);
      expect(install).toBeGreaterThan(helper);
    }
  });

  for (const deployScript of ["deploy-staging.sh", "deploy-prod.sh"]) {
    test(`${deployScript} materializes the contract before installing`, () => {
      const source = read(`scripts/${deployScript}`);
      expect(source.indexOf("materialize-door-contract.sh")).toBeGreaterThan(-1);
      expect(source.indexOf("bun install")).toBeGreaterThan(source.indexOf("materialize-door-contract.sh"));
    });
  }
});
