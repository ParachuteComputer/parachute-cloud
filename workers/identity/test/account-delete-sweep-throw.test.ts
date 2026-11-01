/**
 * Review finding (T-318 day review 2, key b): #338 ordered the purge sweep by
 * `delete_purge_attempts` so accounts it keeps DEFERRING can't hold every
 * slot. An account whose pass THROWS is not deferred: the catch counts it as
 * `failed` and never touches the counter. So it stays at 0 attempts, sorts
 * ahead of everything, never pages the operator, and is never purged. A cap's
 * worth of those blocks every later deletion, the original starvation.
 *
 * A real deterministic throw in production: D1 refusing the vault cascade's
 * LIKE for a vault name of 42+ characters (vault-delete-like-cap.test.ts).
 * Here D1 (a platform, not our code) is wrapped to fail the owner's vault
 * listing for the wedged accounts, which throws at the same point.
 */
import { env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import {
  ACCOUNT_DELETE_SWEEP_CAP,
  ACCOUNT_PURGE_ALERT_AFTER_ATTEMPTS,
  DELETE_UNDO_WINDOW_MS,
  runAccountDeleteSweep,
} from "../src/account-delete.ts";
import type { EmailSender, OpsEmail, SendResult } from "../src/email.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import { createUser, getUserById } from "../src/users.ts";
import { db, deps, seedVault } from "./helpers.ts";

type VaultFetch = NonNullable<OAuthDeps["vaultFetch"]>;
const okVault: VaultFetch = async (input, init) => {
  const req = new Request(input, init);
  if (new URL(req.url).pathname.endsWith("/api/internal/destroy")) {
    return Response.json({ destroyed: true, r2_objects_deleted: 0 });
  }
  return Response.json({ ok: true });
};

/** env.DB, except the vault listing for a `throws-` account fails as a D1 error. */
function d1FailingFor(real: D1Database): D1Database {
  return new Proxy(real, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.startsWith("SELECT * FROM vaults WHERE owner_user_id = ?")) return stmt;
          return new Proxy(stmt, {
            get(s, k) {
              if (k === "bind") {
                return (...args: unknown[]) => {
                  const bound = s.bind(...args);
                  if (!String(args[0]).startsWith("throws-")) return bound;
                  return new Proxy(bound, {
                    get(b, m) {
                      if (m === "all") return async () => {
                        throw new Error("D1_ERROR: simulated deterministic failure");
                      };
                      const v = Reflect.get(b, m, b);
                      return typeof v === "function" ? v.bind(b) : v;
                    },
                  });
                };
              }
              const v = Reflect.get(s, k, s);
              return typeof v === "function" ? v.bind(s) : v;
            },
          });
        };
      }
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** `attempts` null = never deferred: the column has no default (migration
 *  0024), so that is what a real never-counted account holds. */
async function throwers(count: number, from: number, attempts: number | null = null): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch(
    Array.from({ length: count }, (_, i) =>
      env.DB
        .prepare(
          `INSERT INTO users (id, email, password_hash, created_at, deleted_at, delete_undo_hash, delete_purge_attempts)
           VALUES (?, ?, '', ?, ?, ?, ?)`,
        )
        .bind(`throws-${i}`, `throws-${i}@example.com`, now, new Date(from + i * 1000).toISOString(), `h-t${i}`, attempts),
    ),
  );
}

function recordingSender(): { sender: EmailSender; ops: OpsEmail[] } {
  const ops: OpsEmail[] = [];
  const ok = async (): Promise<SendResult> => ({ ok: true });
  const sender: EmailSender = {
    kind: "devlog",
    sendMagicLink: ok,
    async sendOps(msg: OpsEmail): Promise<SendResult> {
      ops.push(msg);
      return { ok: true };
    },
    sendDrip: ok,
  };
  return { sender, ops };
}

describe("the purge sweep counts an account whose pass throws", () => {
  test(`${ACCOUNT_DELETE_SWEEP_CAP} accounts that throw every pass do not block a later account`, async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const longAgo = Date.now() - 3 * DELETE_UNDO_WINDOW_MS;
    await throwers(ACCOUNT_DELETE_SWEEP_CAP, longAgo);
    const { id: healthy } = await createUser(env.DB, "throw-healthy@example.com", "", new Date(), { emailVerified: true });
    await env.DB
      .prepare("UPDATE users SET deleted_at = ?, delete_undo_hash = 'h' WHERE id = ?")
      .bind(new Date(longAgo + 3600_000).toISOString(), healthy)
      .run();
    await seedVault("throw-healthy-vault", healthy);

    const sweepEnv = { ...env, DB: d1FailingFor(env.DB) };
    for (let pass = 0; pass < 2; pass++) {
      await runAccountDeleteSweep(sweepEnv, { ...deps(), vaultFetch: okVault }, new Date(Date.now() + pass * 3600_000));
    }
    expect(await getUserById(db(), healthy), "healthy account still present after 2 passes").toBeNull();
  }, 120_000);

  test("an account that keeps throwing pages the operator like one that keeps deferring", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await throwers(1, Date.now() - 3 * DELETE_UNDO_WINDOW_MS, ACCOUNT_PURGE_ALERT_AFTER_ATTEMPTS - 1);
    const { sender, ops } = recordingSender();
    const summary = await runAccountDeleteSweep(
      { ...env, DB: d1FailingFor(env.DB), OPERATOR_ALERT_EMAIL: "ops@example.com" },
      { ...deps(), vaultFetch: okVault },
      new Date(),
      { sender },
    );
    expect(summary.failed).toBe(1);
    expect((await getUserById(db(), "throws-0"))?.deletePurgeAttempts).toBe(ACCOUNT_PURGE_ALERT_AFTER_ATTEMPTS);
    expect(ops.map((o) => o.subject)).toEqual([expect.stringContaining("account deletion stuck")]);
    expect(ops[0]!.text).toContain("throws-0");
  });
});
