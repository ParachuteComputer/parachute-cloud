// deploy-prod.sh refuses a checkout pinned to a 0.9 engine before it calls anything (T-456: door/0.9 deploys to Cloud
// staging, never to production, until Aaron's rollout). Run on a copy, with every tool it could call faked to log.
import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

function run(version: string): { code: number | null; out: string; calls: string } {
  const t = mkdtempSync(join(tmpdir(), "deploy-prod-pin-"));
  mkdirSync(join(t, "scripts"));
  mkdirSync(join(t, "bin"));
  cpSync(join(ROOT, "scripts/deploy-prod.sh"), join(t, "scripts/deploy-prod.sh"));
  writeFileSync(join(t, "scripts/core-source.env"), `PARACHUTE_CORE_VERSION="${version}"\n`);
  const log = join(t, "calls.log");
  for (const tool of ["bun", "bunx", "wrangler", "npx", "git", "curl", "node"]) {
    writeFileSync(join(t, "bin", tool), `#!/usr/bin/env bash\necho "${tool} $*" >> "${log}"\nexit 1\n`);
    chmodSync(join(t, "bin", tool), 0o755);
  }
  const p = Bun.spawnSync(["bash", join(t, "scripts/deploy-prod.sh")], { env: { PATH: `${join(t, "bin")}:/usr/bin:/bin`, HOME: t }, cwd: t });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString(), calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

describe("deploy-prod.sh and the engine line", () => {
  test("refuses this checkout's own pin when it is 0.9, before any call", () => {
    const own = /^PARACHUTE_CORE_VERSION="([^"]+)"/m.exec(readFileSync(join(ROOT, "scripts/core-source.env"), "utf8"))?.[1] ?? "";
    for (const v of [own, "0.9.0-pre.1", "0.9.3"].filter((x) => x.startsWith("0.9"))) {
      const r = run(v);
      expect(r.code, v).toBe(2);
      expect(r.out).toContain("refused: this checkout pins a non-0.8 engine");
      expect(r.calls, v).toBe("");
    }
  });
  test("an 0.8 pin gets past the refusal (and on to its own checks)", () => {
    const r = run("0.8.0-pre.3");
    expect(r.out).not.toContain("refused: this checkout pins a non-0.8 engine");
  });
});
