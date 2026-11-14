// deploy-prod.sh takes the engine lines production runs and refuses any other before it calls anything (T-456:
// production deploys from door/0.9 from the 0.9 move on, Aaron 11-14; an 0.8 pin is a rollback to a pre-move commit).
// Run on a copy, with every tool it could call faked to log.
import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const REFUSED = "refused: this checkout pins an engine production doesn't take";

function run(version: string): { code: number | null; out: string; calls: string } {
  const t = mkdtempSync(join(tmpdir(), "deploy-prod-pin-"));
  mkdirSync(join(t, "scripts"));
  mkdirSync(join(t, "bin"));
  cpSync(join(ROOT, "scripts/deploy-prod.sh"), join(t, "scripts/deploy-prod.sh"));
  writeFileSync(join(t, "scripts/core-source.env"), `PARACHUTE_CORE_VERSION="${version}"\n`);
  const log = join(t, "calls.log");
  // The script's first step after the check: logged, so "got past the check" is a call, not just no refusal.
  writeFileSync(join(t, "scripts/materialize-vault-core.sh"), `echo "materialize-vault-core" >> "${log}"\nexit 1\n`);
  for (const tool of ["bun", "bunx", "wrangler", "npx", "git", "curl", "node"]) {
    writeFileSync(join(t, "bin", tool), `#!/usr/bin/env bash\necho "${tool} $*" >> "${log}"\nexit 1\n`);
    chmodSync(join(t, "bin", tool), 0o755);
  }
  const p = Bun.spawnSync(["bash", join(t, "scripts/deploy-prod.sh")], { env: { PATH: `${join(t, "bin")}:/usr/bin:/bin`, HOME: t }, cwd: t });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString(), calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

describe("deploy-prod.sh and the engine line", () => {
  test("this checkout's own pin gets past the refusal (and on to its own checks)", () => {
    const own = /^PARACHUTE_CORE_VERSION="([^"]+)"/m.exec(readFileSync(join(ROOT, "scripts/core-source.env"), "utf8"))?.[1] ?? "";
    expect(own).not.toBe("");
    const r = run(own);
    expect(r.out, own).not.toContain(REFUSED);
    expect(r.calls, own).toContain("materialize-vault-core");
  });
  test("0.9 and 0.8 pins get past the refusal", () => {
    for (const v of ["0.9.0-pre.1", "0.9.3", "0.8.0-pre.3"]) {
      const r = run(v);
      expect(r.out, v).not.toContain(REFUSED);
      expect(r.calls, v).toContain("materialize-vault-core");
    }
  });
  test("any other engine line is refused before any call", () => {
    for (const v of ["1.0.0", "0.7.9", "", "0.10.0", "10.9.0"]) {
      const r = run(v);
      expect(r.code, v).toBe(2);
      expect(r.out, v).toContain(REFUSED);
      expect(r.calls, v).toBe("");
    }
  });
});
