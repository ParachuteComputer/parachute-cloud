import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const hubRepo = resolve(root, "../parachute-hub");
const appRepo = resolve(root, "../parachute-app");
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
  const checkout = Bun.spawnSync(["git", "-C", hub, "checkout", "--detach", doorContractRef], {
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

    expect(sourcePin).toContain('SPA_APP_VERSION="0.20.16"');
    expect(sourcePin).toMatch(/SPA_APP_REF="[0-9a-f]{40}"/);
    expect(script).toContain('source "$ROOT/scripts/spa-source.env"');
    expect(script).toContain("SPA_APP_REF");
    expect(script).toContain("git rev-parse HEAD");
    expect(script).toContain("APP_REPO");
    expect(script).toContain("@openparachute/parachute-app");
    expect(script).toContain('VITE_BASE_PATH="/" bun run build');
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
    expect(result.stdout.toString()).toContain("door-contract v0.4.0");
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

      expect(source).toContain("ParachuteComputer/parachute-app.git");
      expect(source).toContain("../parachute-app");
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
    expect(source.match(/bash scripts\/materialize-door-contract\.sh/g)).toHaveLength(3);
    expect(source.match(/run: bun install/g)).toHaveLength(3);

    const installJobs = source
      .split(/^  (?=[a-z].*:$)/m)
      .filter((job) => job.includes("run: bun install"));
    expect(installJobs).toHaveLength(3);
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
