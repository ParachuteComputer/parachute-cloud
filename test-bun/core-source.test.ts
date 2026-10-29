// The engine pin: workers/vault builds against file:../../../parachute-core/packages/vault/core, and
// scripts/materialize-vault-core.sh is the only gate between "the SHA in scripts/core-source.env" and what bun
// copies into node_modules. These tests run the real script against a real parachute-core clone.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const coreRepo = resolve(root, "../parachute-core");
const helper = resolve(root, "scripts/materialize-vault-core.sh");
const pin = read("scripts/core-source.env");
const coreRef = pin.match(/PARACHUTE_CORE_REF="([0-9a-f]{40})"/)?.[1];
if (!coreRef) throw new Error("scripts/core-source.env has no valid parachute-core ref");
const tempDirs: string[] = [];

afterAll(() => {
  for (const path of tempDirs) rmSync(path, { recursive: true, force: true });
});

function pinnedCoreClone(prefix: string): string {
  const temp = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(temp);
  const core = resolve(temp, "parachute-core");
  const clone = Bun.spawnSync(["git", "clone", "--shared", "--no-checkout", coreRepo, core], { stdout: "pipe", stderr: "pipe" });
  expect(clone.exitCode, clone.stderr.toString()).toBe(0);
  const checkout = Bun.spawnSync(["git", "-C", core, "checkout", "--detach", coreRef as string], { stdout: "pipe", stderr: "pipe" });
  expect(checkout.exitCode, checkout.stderr.toString()).toBe(0);
  return core;
}

function runHelper(core: string, sourceFile?: string) {
  return Bun.spawnSync(["bash", helper], {
    cwd: root,
    env: { ...process.env, PARACHUTE_CORE_REPO: core, ...(sourceFile ? { CORE_SOURCE_FILE: sourceFile } : {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function sourceFileWith(overrides: Record<string, string>): string {
  const dir = mkdtempSync(resolve(tmpdir(), "cloud-core-pin-"));
  tempDirs.push(dir);
  let text = pin;
  for (const [key, value] of Object.entries(overrides)) {
    text = text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}="${value}"`);
  }
  const file = resolve(dir, "core-source.env");
  writeFileSync(file, text);
  return file;
}

describe("engine pin (parachute-core)", () => {
  test("the vault worker depends on the engine package inside parachute-core", () => {
    const pkg = JSON.parse(read("workers/vault/package.json"));
    expect(pkg.dependencies["@openparachute/core"]).toBe("file:../../../parachute-core/packages/vault/core");
    expect(pin).toContain('CORE_ENGINE_DIR="packages/vault/core"');
  });

  test("materializes and verifies the pinned engine", () => {
    const result = runHelper(pinnedCoreClone("cloud-core-ok-"));
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain(`@ ${coreRef} (engine v0.1.0`);
  });

  test("rejects a checkout that is not the pinned commit", () => {
    const result = runHelper(pinnedCoreClone("cloud-core-ref-"), sourceFileWith({ PARACHUTE_CORE_REF: "0".repeat(40) }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("parachute-core checkout is not the pinned engine source");
  });

  test("rejects local modifications to the engine package", () => {
    const core = pinnedCoreClone("cloud-core-dirty-");
    appendFileSync(resolve(core, "packages/vault/core/src/schema.ts"), "\n// local edit\n");
    const result = runHelper(core);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("engine package has local modifications");
  });

  // The parachute-core workspace root is ALSO named @openparachute/core (the CLI program). A pin that points the
  // engine dir at the root, or at the vault server package, must not pass.
  test("refuses an engine dir that is the workspace root (same npm name, wrong package)", () => {
    const result = runHelper(pinnedCoreClone("cloud-core-root-"), sourceFileWith({ CORE_ENGINE_DIR: "." }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("engine version mismatch");
  });

  test("refuses an engine dir that is another package", () => {
    const result = runHelper(pinnedCoreClone("cloud-core-vault-"), sourceFileWith({ CORE_ENGINE_DIR: "packages/vault" }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("engine package name mismatch");
  });

  test("every CI install and both deploy scripts materialize the engine before installing", () => {
    const ci = read(".github/workflows/ci.yml");
    const installJobs = ci.split(/^  (?=[a-z].*:$)/m).filter((job) => job.includes("run: bun install"));
    expect(installJobs).toHaveLength(3);
    for (const job of installJobs) {
      const materialize = job.indexOf("bash scripts/materialize-vault-core.sh");
      expect(materialize).toBeGreaterThan(-1);
      expect(job.indexOf("run: bun install")).toBeGreaterThan(materialize);
    }
    for (const script of ["deploy-staging.sh", "deploy-prod.sh"]) {
      const source = read(`scripts/${script}`);
      expect(source.indexOf("materialize-vault-core.sh")).toBeGreaterThan(-1);
      expect(source.indexOf("bun install")).toBeGreaterThan(source.indexOf("materialize-vault-core.sh"));
    }
    for (const workflow of ["deploy-staging.yml", "deploy-prod.yml"]) {
      const source = read(`.github/workflows/${workflow}`);
      expect(source).toContain("bash scripts/materialize-vault-core.sh");
    }
  });
});
