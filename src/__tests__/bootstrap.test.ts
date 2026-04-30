import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BootstrapMarker,
  DEFAULT_MODULES,
  DEFAULT_VAULT_NAME,
  bootstrap,
} from "../bootstrap.ts";

function harness(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-bootstrap-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const FROZEN_NOW = () => new Date("2026-04-29T12:00:00.000Z");

describe("bootstrap — fresh-boot path", () => {
  test("default env installs vault+scribe+notes, writes marker, returns 0", async () => {
    const h = harness();
    try {
      const logs: string[] = [];
      const installCalls: Array<{ short: string; vaultName?: string }> = [];
      const result = await bootstrap({
        env: { CLAUDE_API_TOKEN: "sk-test-claude-token" },
        configDir: h.dir,
        log: (l) => logs.push(l),
        installFn: async (short, opts) => {
          installCalls.push({ short, vaultName: opts.vaultName });
          return 0;
        },
        now: FROZEN_NOW,
        parachuteVersion: "0.4.0-rc.27",
      });

      expect(result.exitCode).toBe(0);
      expect(result.alreadyBootstrapped).toBeUndefined();
      expect(installCalls.map((c) => c.short)).toEqual([...DEFAULT_MODULES]);

      const vaultCall = installCalls.find((c) => c.short === "vault");
      expect(vaultCall?.vaultName).toBe(DEFAULT_VAULT_NAME);

      const markerPath = join(h.dir, "bootstrap.json");
      expect(existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as BootstrapMarker;
      expect(marker).toEqual({
        bootstrapped_at: "2026-04-29T12:00:00.000Z",
        modules: [...DEFAULT_MODULES],
        vault_name: DEFAULT_VAULT_NAME,
        parachute_version: "0.4.0-rc.27",
      });
      expect(result.marker).toEqual(marker);

      // #137: writeMarkerAtomic uses tmp+rename. The rename must complete
      // (otherwise readMarker on next boot picks up a half-written file),
      // so no `bootstrap.json.tmp-*` should remain.
      const tmpLeftover = readdirSync(h.dir).filter((f) => f.startsWith("bootstrap.json.tmp-"));
      expect(tmpLeftover).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("persists CLAUDE_API_TOKEN + ANTHROPIC_API_KEY into <configDir>/.env", async () => {
    const h = harness();
    try {
      await bootstrap({
        env: { CLAUDE_API_TOKEN: "sk-test-token-xyz" },
        configDir: h.dir,
        log: () => {},
        installFn: async () => 0,
        now: FROZEN_NOW,
      });
      const envText = readFileSync(join(h.dir, ".env"), "utf8");
      expect(envText).toContain("CLAUDE_API_TOKEN=sk-test-token-xyz");
      expect(envText).toContain("ANTHROPIC_API_KEY=sk-test-token-xyz");
    } finally {
      h.cleanup();
    }
  });

  test("PARACHUTE_VAULT_NAME forwards to install() for the vault module", async () => {
    const h = harness();
    try {
      const seen: Record<string, string | undefined> = {};
      await bootstrap({
        env: {
          CLAUDE_API_TOKEN: "sk-test",
          PARACHUTE_VAULT_NAME: "aaron-personal",
        },
        configDir: h.dir,
        log: () => {},
        installFn: async (short, opts) => {
          seen[short] = opts.vaultName;
          return 0;
        },
        now: FROZEN_NOW,
      });
      expect(seen.vault).toBe("aaron-personal");
      expect(seen.notes).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("PARACHUTE_MODULES overrides the default list", async () => {
    const h = harness();
    try {
      const calls: string[] = [];
      const result = await bootstrap({
        env: {
          CLAUDE_API_TOKEN: "sk-test",
          PARACHUTE_MODULES: "vault,notes",
        },
        configDir: h.dir,
        log: () => {},
        installFn: async (short) => {
          calls.push(short);
          return 0;
        },
        now: FROZEN_NOW,
      });
      expect(result.exitCode).toBe(0);
      expect(calls).toEqual(["vault", "notes"]);
      expect(result.marker?.modules).toEqual(["vault", "notes"]);
    } finally {
      h.cleanup();
    }
  });

  test("PARACHUTE_SCRIBE_PROVIDER + KEY forward to install() for scribe", async () => {
    const h = harness();
    try {
      const seen: Record<string, { provider?: string; key?: string }> = {};
      await bootstrap({
        env: {
          CLAUDE_API_TOKEN: "sk-test",
          PARACHUTE_MODULES: "scribe",
          PARACHUTE_SCRIBE_PROVIDER: "deepgram",
          PARACHUTE_SCRIBE_KEY: "dg_secret_99",
        },
        configDir: h.dir,
        log: () => {},
        installFn: async (short, opts) => {
          seen[short] = { provider: opts.scribeProvider, key: opts.scribeKey };
          return 0;
        },
        now: FROZEN_NOW,
      });
      expect(seen.scribe).toEqual({ provider: "deepgram", key: "dg_secret_99" });
    } finally {
      h.cleanup();
    }
  });
});

describe("bootstrap — ephemeral-layer guard (#131)", () => {
  test("warns when PARACHUTE_HOME is unset and configDir resolves under homedir", async () => {
    const dir = mkdtempSync(join(homedir(), ".test-pcli-bootstrap-eph-"));
    try {
      const logs: string[] = [];
      await bootstrap({
        env: { CLAUDE_API_TOKEN: "sk-test" },
        configDir: dir,
        log: (l) => logs.push(l),
        installFn: async () => 0,
        now: FROZEN_NOW,
      });
      const warnLine = logs.find((l) => l.includes("PARACHUTE_HOME is not set"));
      expect(warnLine).toBeDefined();
      expect(logs.join("\n")).toContain("ephemeral image layer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not warn when PARACHUTE_HOME is set", async () => {
    const dir = mkdtempSync(join(homedir(), ".test-pcli-bootstrap-eph-"));
    try {
      const logs: string[] = [];
      await bootstrap({
        env: { CLAUDE_API_TOKEN: "sk-test", PARACHUTE_HOME: dir },
        configDir: dir,
        log: (l) => logs.push(l),
        installFn: async () => 0,
        now: FROZEN_NOW,
      });
      expect(logs.find((l) => l.includes("PARACHUTE_HOME is not set"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #136: heuristic keys off the env (what production would resolve to), not
  // the injected configDir. So even with configDir pointed at a tmpdir
  // outside homedir, the warn still fires when PARACHUTE_HOME is unset —
  // because in production, that same env would land at ~/.parachute.
  test("warns based on env, not the injected configDir (closes #136)", async () => {
    const h = harness();
    try {
      const logs: string[] = [];
      await bootstrap({
        env: { CLAUDE_API_TOKEN: "sk-test" },
        configDir: h.dir,
        log: (l) => logs.push(l),
        installFn: async () => 0,
        now: FROZEN_NOW,
      });
      expect(logs.find((l) => l.includes("PARACHUTE_HOME is not set"))).toBeDefined();
    } finally {
      h.cleanup();
    }
  });

  // Symmetric case: PARACHUTE_HOME pointing at a non-homedir mount (the
  // production shape on a Fly machine), configDir injected to a tmpdir
  // for the test. Heuristic must NOT warn — env is correct.
  test("does not warn when PARACHUTE_HOME points at a non-homedir mount", async () => {
    const h = harness();
    try {
      const logs: string[] = [];
      await bootstrap({
        env: { CLAUDE_API_TOKEN: "sk-test", PARACHUTE_HOME: "/data" },
        configDir: h.dir,
        log: (l) => logs.push(l),
        installFn: async () => 0,
        now: FROZEN_NOW,
      });
      expect(logs.find((l) => l.includes("PARACHUTE_HOME is not set"))).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

describe("bootstrap — idempotent re-run", () => {
  test("marker present → no install calls, returns 0 with alreadyBootstrapped=true", async () => {
    const h = harness();
    try {
      const existingMarker: BootstrapMarker = {
        bootstrapped_at: "2026-04-28T10:00:00.000Z",
        modules: ["vault", "scribe", "notes"],
        vault_name: "default",
        parachute_version: "0.4.0-rc.26",
      };
      writeFileSync(join(h.dir, "bootstrap.json"), `${JSON.stringify(existingMarker, null, 2)}\n`);

      let installCalled = false;
      const result = await bootstrap({
        env: { CLAUDE_API_TOKEN: "sk-test" },
        configDir: h.dir,
        log: () => {},
        installFn: async () => {
          installCalled = true;
          return 0;
        },
        now: FROZEN_NOW,
      });

      expect(result.exitCode).toBe(0);
      expect(result.alreadyBootstrapped).toBe(true);
      expect(result.marker).toEqual(existingMarker);
      expect(installCalled).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("malformed marker still short-circuits (alreadyBootstrapped=true, no marker)", async () => {
    const h = harness();
    try {
      writeFileSync(join(h.dir, "bootstrap.json"), "{ not valid json");
      let installCalled = false;
      const result = await bootstrap({
        env: { CLAUDE_API_TOKEN: "sk-test" },
        configDir: h.dir,
        log: () => {},
        installFn: async () => {
          installCalled = true;
          return 0;
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.alreadyBootstrapped).toBe(true);
      expect(result.marker).toBeUndefined();
      expect(installCalled).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});

describe("bootstrap — CLAUDE_API_TOKEN is optional (hub#133)", () => {
  test("missing token → exit 0, runs installs, no .env written", async () => {
    const h = harness();
    try {
      const calls: string[] = [];
      const result = await bootstrap({
        env: {},
        configDir: h.dir,
        log: () => {},
        installFn: async (short) => {
          calls.push(short);
          return 0;
        },
        now: FROZEN_NOW,
      });
      expect(result.exitCode).toBe(0);
      expect(result.marker).toBeDefined();
      expect(calls).toEqual([...DEFAULT_MODULES]);
      expect(existsSync(join(h.dir, ".env"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("blank token (whitespace-only) treated as missing — exit 0, no .env", async () => {
    const h = harness();
    try {
      const result = await bootstrap({
        env: { CLAUDE_API_TOKEN: "   " },
        configDir: h.dir,
        log: () => {},
        installFn: async () => 0,
        now: FROZEN_NOW,
      });
      expect(result.exitCode).toBe(0);
      expect(result.marker).toBeDefined();
      expect(existsSync(join(h.dir, ".env"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});

describe("bootstrap — error paths", () => {
  test("paraclaw in PARACHUTE_MODULES → exit 1 with Tier 2 message, no installs", async () => {
    const h = harness();
    try {
      const logs: string[] = [];
      let installCalled = false;
      const result = await bootstrap({
        env: {
          CLAUDE_API_TOKEN: "sk-test",
          PARACHUTE_MODULES: "vault,paraclaw",
        },
        configDir: h.dir,
        log: (l) => logs.push(l),
        installFn: async () => {
          installCalled = true;
          return 0;
        },
      });
      expect(result.exitCode).toBe(1);
      expect(installCalled).toBe(false);
      expect(existsSync(join(h.dir, "bootstrap.json"))).toBe(false);
      expect(logs.join("\n")).toMatch(/Tier 2/);
      expect(logs.join("\n")).toContain("paraclaw");
    } finally {
      h.cleanup();
    }
  });

  test("install failure aborts before marker is written", async () => {
    const h = harness();
    try {
      const calls: string[] = [];
      const result = await bootstrap({
        env: { CLAUDE_API_TOKEN: "sk-test" },
        configDir: h.dir,
        log: () => {},
        installFn: async (short) => {
          calls.push(short);
          return short === "scribe" ? 7 : 0;
        },
        now: FROZEN_NOW,
      });
      expect(result.exitCode).toBe(7);
      expect(result.marker).toBeUndefined();
      expect(existsSync(join(h.dir, "bootstrap.json"))).toBe(false);
      // vault ran, then scribe failed; notes was not attempted
      expect(calls).toEqual(["vault", "scribe"]);
    } finally {
      h.cleanup();
    }
  });

  test("install failure leaves CLAUDE_API_TOKEN persisted (so retry doesn't need re-paste)", async () => {
    const h = harness();
    try {
      await bootstrap({
        env: { CLAUDE_API_TOKEN: "sk-test-keep" },
        configDir: h.dir,
        log: () => {},
        installFn: async () => 1,
      });
      const envText = readFileSync(join(h.dir, ".env"), "utf8");
      expect(envText).toContain("CLAUDE_API_TOKEN=sk-test-keep");
    } finally {
      h.cleanup();
    }
  });
});
