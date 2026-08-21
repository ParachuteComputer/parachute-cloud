/**
 * The onboarding email drip (src/drip.ts): eligibility windows, the AI-activity
 * exclusion (incl. the parachute-console carve-out), the drip_sends idempotence
 * ledger, the per-run cap, unsubscribe (token validity/tamper/idempotence +
 * the RFC 8058 POST path), and the real worker wiring (scheduled + the
 * staging-only trigger's production 404).
 *
 * Same conventions as ops.test.ts: pure handlers driven with an injected
 * clock/sender against the real D1, plus passes through the REAL worker export.
 */
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import worker from "../src/index.ts";
import type { DripEmail, EmailSender, SendResult } from "../src/email.ts";
import {
  CONSOLE_CLIENT_ID,
  DRIP_REPLY_TO,
  DRIP_RUN_CAP,
  connectNudgeCopy,
  feedbackCopy,
  getOrMintUnsubToken,
  handleUnsubscribe,
  runDrip,
  unsubscribeByToken,
  welcomeCopy,
} from "../src/drip.ts";
import { DRIP_CRON } from "../src/ops.ts";
import { createUser } from "../src/users.ts";
import { CANONICAL_ORIGIN, ISSUER, seedVault } from "./helpers.ts";

const NOW = new Date("2026-07-10T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60 * 1000);
const at = { now: () => NOW };

/** Capturing drip sender; `result` simulates a failing email channel. */
function dripSender(result: SendResult = { ok: true }): EmailSender & { sent: DripEmail[] } {
  const sent: DripEmail[] = [];
  return {
    kind: "devlog",
    sent,
    async sendMagicLink(): Promise<SendResult> {
      return { ok: true };
    },
    async sendOps(): Promise<SendResult> {
      return { ok: true };
    },
    async sendDrip(msg: DripEmail): Promise<SendResult> {
      sent.push(msg);
      return result;
    },
  };
}

/** Silence the structured event= lines these paths intentionally emit. */
function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return fn().finally(() => {
    err.mockRestore();
    log.mockRestore();
  });
}

async function seedUserAt(email: string, createdAt: Date): Promise<{ id: string }> {
  const u = await createUser(env.DB, email, "", createdAt);
  return { id: u.id };
}

/** A minted-token row (the day-3 AI-activity signal). */
async function seedTokenRow(userId: string, clientId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO tokens (jti, user_id, client_id, scopes, expires_at, created_at) VALUES (?, ?, ?, 'vault:demo:read', ?, ?)",
  )
    .bind(crypto.randomUUID(), userId, clientId, daysAgo(-30).toISOString(), daysAgo(1).toISOString())
    .run();
}

/** A standing consent row (the other AI-activity signal). */
async function seedGrantRow(userId: string, clientId: string): Promise<void> {
  await env.DB.prepare("INSERT INTO grants (user_id, client_id, scopes, granted_at) VALUES (?, ?, 'vault:demo:read', ?)")
    .bind(userId, clientId, daysAgo(1).toISOString())
    .run();
}

async function ledgerRows(userId: string): Promise<string[]> {
  const res = await env.DB.prepare("SELECT email_kind FROM drip_sends WHERE user_id = ? ORDER BY email_kind")
    .bind(userId)
    .all<{ email_kind: string }>();
  return (res.results ?? []).map((r) => r.email_kind);
}

async function dripEventCount(event: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM drip_events WHERE event = ?")
    .bind(event)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// --- day-0 welcome ------------------------------------------------------------

describe("day-0 welcome", () => {
  test("a fresh signup with a vault gets the three-doors welcome, within the window", async () => {
    const u = await seedUserAt("fresh@example.com", minutesAgo(10));
    await seedVault("freshvault", u.id);
    const sender = dripSender();
    const summary = await quietly(() => runDrip(env, sender, at));

    expect(summary.sent.welcome).toBe(1);
    expect(sender.sent).toHaveLength(1);
    const mail = sender.sent[0]!;
    expect(mail.to).toBe("fresh@example.com");
    expect(mail.subject).toBe("Welcome to Parachute");
    expect(mail.replyTo).toBe(DRIP_REPLY_TO);
    // The three doors: the app (the user's real vault), the app's Connect-AI
    // surface, reply-to-a-human. The vault door uses the configured APP_ORIGIN
    // (wrangler default my.parachute.computer, my.-canonical Phase 1; #116); the
    // connect door does too.
    expect(mail.text).toContain("https://my.parachute.computer/?add=");
    // The vault door advertises the PUBLIC origin (VAULT_PUBLIC_ORIGIN — my.
    // in the committed prod config), not the machine VAULT_ORIGIN (A3 URL
    // coherence); reading the env var keeps this test config-driven either way.
    expect(mail.text).toContain(encodeURIComponent(`${env.VAULT_PUBLIC_ORIGIN ?? env.VAULT_ORIGIN}/vault/freshvault`));
    expect(mail.text).toContain("https://my.parachute.computer/connect");
    expect(mail.text).not.toContain(`${ISSUER}/console`);
    expect(mail.text).toContain("Reply to this email. A person reads it.");
    // The HTML part (multipart/alternative) mirrors the text part's doors —
    // same canonical my. links, same unsubscribe.
    expect(mail.html).toContain("https://my.parachute.computer/?add=");
    expect(mail.html).toContain("https://my.parachute.computer/connect");
    expect(mail.html).toContain(mail.unsubscribeUrl);
    // The unsubscribe link rides the footer AND the header field, and is built
    // from the advertised human FRONT DOOR (my. in the committed prod config),
    // not the issuer — the legacy cloud./unsubscribe keeps serving old emails'
    // links (MUST-NEVER-REDIRECT pin, canonical-redirect.test.ts).
    expect(mail.text).toContain(mail.unsubscribeUrl);
    expect(mail.unsubscribeUrl).toContain(`${CANONICAL_ORIGIN}/unsubscribe?t=`);
    expect(mail.unsubscribeUrl).not.toContain(`${ISSUER}/unsubscribe`);
    // Ledger row written.
    expect(await ledgerRows(u.id)).toEqual(["welcome"]);
    expect(await dripEventCount("welcome:sent")).toBe(1);
  });

  test("APP_ORIGIN unset ⇒ the welcome link falls back to the legacy Notes PWA (#116)", async () => {
    const u = await seedUserAt("appwelcome@example.com", minutesAgo(10));
    await seedVault("appwelcomevault", u.id);
    const sender = dripSender();
    // Clearing the wrangler-configured APP_ORIGIN proves the drip link is
    // env-driven (resolveAppOrigin) and degrades gracefully, not hardcoded.
    await quietly(() => runDrip({ ...env, APP_ORIGIN: undefined }, sender, at));
    expect(sender.sent).toHaveLength(1);
    const mail = sender.sent[0]!;
    expect(mail.text).toContain("https://notes.parachute.computer/?add=");
    expect(mail.text).not.toContain("app.parachute.computer");
  });

  test("a fresh signup without a vault gets the name-your-vault variant", async () => {
    await seedUserAt("novault@example.com", minutesAgo(30));
    const sender = dripSender();
    await quietly(() => runDrip(env, sender, at));
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.text).toContain("name your vault");
    expect(sender.sent[0]!.text).not.toContain("notes.parachute.computer");
    // The console door is the advertised human front door (my.), NOT the issuer.
    expect(sender.sent[0]!.text).toContain(`${CANONICAL_ORIGIN}/console`);
    expect(sender.sent[0]!.text).not.toContain(`${ISSUER}/console`);
  });

  test("window edges: older than the welcome window → never welcomed retroactively", async () => {
    await seedUserAt("old@example.com", daysAgo(1.1)); // outside the 24h window
    const sender = dripSender();
    const summary = await quietly(() => runDrip(env, sender, at));
    expect(summary.sent.welcome).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });

  test("unsubscribed users are excluded from every kind, welcome included", async () => {
    const u = await seedUserAt("optedout@example.com", minutesAgo(5));
    await env.DB.prepare("UPDATE users SET drip_unsubscribed = ? WHERE id = ?").bind(NOW.toISOString(), u.id).run();
    const sender = dripSender();
    const summary = await quietly(() => runDrip(env, sender, at));
    expect(summary.sent.welcome).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });

  test("idempotence: the ledger prevents resends across runs", async () => {
    await seedUserAt("once@example.com", minutesAgo(10));
    const sender = dripSender();
    const first = await quietly(() => runDrip(env, sender, at));
    expect(first.sent.welcome).toBe(1);
    // Same hour, next run (or a retriggered one): nothing new.
    const second = await quietly(() => runDrip(env, sender, at));
    expect(second.sent.welcome).toBe(0);
    expect(sender.sent).toHaveLength(1);
  });

  test("a failed send leaves NO ledger row and is retried next run; failures are counted", async () => {
    const u = await seedUserAt("retry@example.com", minutesAgo(10));
    const broken = dripSender({ ok: false, error: "SendError: quota exceeded" });
    const first = await quietly(() => runDrip(env, broken, at));
    expect(first.sent.welcome).toBe(0);
    expect(first.failed).toBe(1);
    expect(await ledgerRows(u.id)).toEqual([]);
    expect(await dripEventCount("welcome:failed")).toBe(1);

    const working = dripSender();
    const second = await quietly(() => runDrip(env, working, at));
    expect(second.sent.welcome).toBe(1);
    expect(await ledgerRows(u.id)).toEqual(["welcome"]);
  });

  // A-1 (migration 0023): a tombstoned account inside the welcome window must
  // never be emailed — the predicate this test would fail without.
  test("a DELETED account inside the welcome window does NOT get welcomed", async () => {
    const u = await seedUserAt("del-welcome@example.com", minutesAgo(10));
    await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(NOW.toISOString(), u.id).run();
    const sender = dripSender();
    const summary = await quietly(() => runDrip(env, sender, at));
    expect(summary.sent.welcome).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });
});

// --- day-3 connect nudge --------------------------------------------------------

describe("day-3 connect nudge", () => {
  test("a 3–4 day old account with no AI activity gets the nudge; younger/older don't", async () => {
    await seedUserAt("due@example.com", daysAgo(3.5));
    await seedUserAt("tooyoung@example.com", daysAgo(2.9));
    await seedUserAt("toolate@example.com", daysAgo(4.1));
    const sender = dripSender();
    const summary = await quietly(() => runDrip(env, sender, at));
    expect(summary.sent["connect-nudge"]).toBe(1);
    expect(sender.sent.map((m) => m.to)).toEqual(["due@example.com"]);
    const mail = sender.sent[0]!;
    expect(mail.subject).toBe("Connect your AI to your vault");
    expect(mail.text).toContain("https://my.parachute.computer/connect");
    expect(mail.text).not.toContain(`${ISSUER}/console`);
    expect(mail.text).toContain(mail.unsubscribeUrl);
    // The HTML part carries the same canonical connect door + unsubscribe.
    expect(mail.html).toContain("https://my.parachute.computer/connect");
    expect(mail.html).toContain(mail.unsubscribeUrl);
  });

  test("AI activity suppresses the nudge: a minted token for a non-console client", async () => {
    const u = await seedUserAt("active@example.com", daysAgo(3.5));
    await seedTokenRow(u.id, "some-mcp-client");
    const sender = dripSender();
    const summary = await quietly(() => runDrip(env, sender, at));
    expect(summary.sent["connect-nudge"]).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });

  test("AI activity suppresses the nudge: a standing consent grant for a non-console client", async () => {
    const u = await seedUserAt("consented@example.com", daysAgo(3.5));
    await seedGrantRow(u.id, "some-mcp-client");
    const sender = dripSender();
    const summary = await quietly(() => runDrip(env, sender, at));
    expect(summary.sent["connect-nudge"]).toBe(0);
  });

  test("the console's own internal mints do NOT count as AI activity", async () => {
    // The product talking to itself (pack apply, first-note write) must not
    // suppress the nudge — only a real external connection does.
    const u = await seedUserAt("console-only@example.com", daysAgo(3.5));
    await seedTokenRow(u.id, CONSOLE_CLIENT_ID);
    await seedGrantRow(u.id, CONSOLE_CLIENT_ID);
    const sender = dripSender();
    const summary = await quietly(() => runDrip(env, sender, at));
    expect(summary.sent["connect-nudge"]).toBe(1);
    expect(sender.sent[0]!.to).toBe("console-only@example.com");
  });

  test("unsubscribed and already-sent are excluded", async () => {
    const unsub = await seedUserAt("nudge-optout@example.com", daysAgo(3.5));
    await env.DB.prepare("UPDATE users SET drip_unsubscribed = ? WHERE id = ?").bind(NOW.toISOString(), unsub.id).run();
    const sender = dripSender();
    const first = await quietly(() => runDrip(env, sender, at));
    expect(first.sent["connect-nudge"]).toBe(0);

    const due = await seedUserAt("nudge-once@example.com", daysAgo(3.5));
    const second = await quietly(() => runDrip(env, sender, at));
    expect(second.sent["connect-nudge"]).toBe(1);
    expect(await ledgerRows(due.id)).toEqual(["connect-nudge"]);
    const third = await quietly(() => runDrip(env, sender, at));
    expect(third.sent["connect-nudge"]).toBe(0);
  });

  // A-1 (migration 0023): a tombstoned account 3-4 days old, with no AI
  // activity, must still never get the nudge.
  test("a DELETED account due for the nudge does NOT get it", async () => {
    const u = await seedUserAt("del-nudge@example.com", daysAgo(3.5));
    await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(NOW.toISOString(), u.id).run();
    const sender = dripSender();
    const summary = await quietly(() => runDrip(env, sender, at));
    expect(summary.sent["connect-nudge"]).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });
});

// --- day-14 feedback --------------------------------------------------------------

describe("day-14 feedback", () => {
  test("a 14–15 day old account gets the ask; younger/older don't; ledger prevents resend", async () => {
    const due = await seedUserAt("twoweeks@example.com", daysAgo(14.5));
    await seedUserAt("thirteen@example.com", daysAgo(13.9));
    await seedUserAt("fifteenplus@example.com", daysAgo(15.1));
    const sender = dripSender();
    const summary = await quietly(() => runDrip(env, sender, at));
    expect(summary.sent.feedback).toBe(1);
    const mail = sender.sent[0]!;
    expect(mail.to).toBe("twoweeks@example.com");
    expect(mail.subject).toBe("How's your vault?");
    expect(mail.replyTo).toBe(DRIP_REPLY_TO);
    expect(mail.text).toContain("A human reads every reply.");
    // The HTML part exists and carries the unsubscribe link too.
    expect(mail.html).toContain(mail.unsubscribeUrl);
    expect(await ledgerRows(due.id)).toEqual(["feedback"]);

    const again = await quietly(() => runDrip(env, sender, at));
    expect(again.sent.feedback).toBe(0);
  });

  test("unsubscribed users don't get the feedback ask", async () => {
    const u = await seedUserAt("fb-optout@example.com", daysAgo(14.5));
    await env.DB.prepare("UPDATE users SET drip_unsubscribed = ? WHERE id = ?").bind(NOW.toISOString(), u.id).run();
    const sender = dripSender();
    const summary = await quietly(() => runDrip(env, sender, at));
    expect(summary.sent.feedback).toBe(0);
  });

  // A-1 (migration 0023): a tombstoned account 14-15 days old must not get
  // the feedback ask either.
  test("a DELETED account due for feedback does NOT get it", async () => {
    const u = await seedUserAt("del-fb@example.com", daysAgo(14.5));
    await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(NOW.toISOString(), u.id).run();
    const sender = dripSender();
    const summary = await quietly(() => runDrip(env, sender, at));
    expect(summary.sent.feedback).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });
});

// --- the per-run cap ---------------------------------------------------------------

describe("per-run cap", () => {
  test("a backlog drains at the run cap, finishing on later runs", async () => {
    // The production cap is 50; pinning the mechanism at 50 means seeding 60
    // users sequentially then running two sweeps — ~267ms locally, over the
    // 5s vitest budget on a loaded CI runner (cloud#188, cloud#233). The
    // invariant is "stops at N, remainder drains next run", which does not
    // depend on N=50. Inject a small cap; keep the production constant
    // pinned separately so a silent raise/drop still fails a test.
    expect(DRIP_RUN_CAP).toBe(50);
    const cap = 3;
    const remainder = 2;
    const total = cap + remainder;
    for (let i = 0; i < total; i++) await seedUserAt(`bulk-${i}@example.com`, minutesAgo(30));
    const sender = dripSender();
    const deps = { ...at, runCap: cap };

    const first = await quietly(() => runDrip(env, sender, deps));
    expect(first.sent.welcome).toBe(cap);
    expect(first.capped).toBe(true);

    const second = await quietly(() => runDrip(env, sender, deps));
    expect(second.sent.welcome).toBe(remainder);
    expect(second.capped).toBe(false);
    expect(sender.sent).toHaveLength(total);
    // No duplicates across the two runs.
    expect(new Set(sender.sent.map((m) => m.to)).size).toBe(total);
  });
});

// --- unsubscribe --------------------------------------------------------------------

describe("unsubscribe", () => {
  test("the token is minted once and stays stable (links in old emails keep working)", async () => {
    const u = await seedUserAt("stable@example.com", minutesAgo(5));
    const t1 = await getOrMintUnsubToken(env.DB, u.id);
    const t2 = await getOrMintUnsubToken(env.DB, u.id);
    expect(t1).toBeTruthy();
    expect(t2).toBe(t1);
  });

  test("GET /unsubscribe?t=<valid> unsubscribes, confirms, and is idempotent", async () => {
    const u = await seedUserAt("bye@example.com", minutesAgo(5));
    const token = (await getOrMintUnsubToken(env.DB, u.id))!;

    const res = await quietly(async () =>
      worker.fetch(new Request(`${ISSUER}/unsubscribe?t=${encodeURIComponent(token)}`), env),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You're unsubscribed");
    const row = await env.DB.prepare("SELECT drip_unsubscribed AS ts FROM users WHERE id = ?")
      .bind(u.id)
      .first<{ ts: string | null }>();
    expect(row?.ts).toBeTruthy();

    // Second visit: same confirmation, timestamp NOT overwritten, counter not re-bumped.
    const before = await dripEventCount("unsubscribed");
    const again = await quietly(async () =>
      worker.fetch(new Request(`${ISSUER}/unsubscribe?t=${encodeURIComponent(token)}`), env),
    );
    expect(again.status).toBe(200);
    const rowAfter = await env.DB.prepare("SELECT drip_unsubscribed AS ts FROM users WHERE id = ?")
      .bind(u.id)
      .first<{ ts: string | null }>();
    expect(rowAfter?.ts).toBe(row?.ts);
    expect(await dripEventCount("unsubscribed")).toBe(before);
  });

  test("POST /unsubscribe (RFC 8058 one-click) lands on the same idempotent logic", async () => {
    const u = await seedUserAt("oneclick@example.com", minutesAgo(5));
    const token = (await getOrMintUnsubToken(env.DB, u.id))!;
    const res = await quietly(async () =>
      worker.fetch(
        new Request(`${ISSUER}/unsubscribe?t=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        }),
        env,
      ),
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT drip_unsubscribed AS ts FROM users WHERE id = ?")
      .bind(u.id)
      .first<{ ts: string | null }>();
    expect(row?.ts).toBeTruthy();
  });

  test("tampered/unknown/missing tokens change nothing and render the invalid page", async () => {
    const u = await seedUserAt("safe@example.com", minutesAgo(5));
    const token = (await getOrMintUnsubToken(env.DB, u.id))!;
    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");

    for (const t of [tampered, "not-a-token", ""]) {
      const res = await handleUnsubscribe(env.DB, new Request(`${ISSUER}/unsubscribe?t=${encodeURIComponent(t)}`));
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("isn't valid");
    }
    const noParam = await handleUnsubscribe(env.DB, new Request(`${ISSUER}/unsubscribe`));
    expect(noParam.status).toBe(404);

    const row = await env.DB.prepare("SELECT drip_unsubscribed AS ts FROM users WHERE id = ?")
      .bind(u.id)
      .first<{ ts: string | null }>();
    expect(row?.ts).toBeNull();
  });

  test("after unsubscribing, the drip run skips the user (direct predicate check)", async () => {
    const u = await seedUserAt("skipme@example.com", minutesAgo(5));
    const token = (await getOrMintUnsubToken(env.DB, u.id))!;
    await quietly(async () => unsubscribeByToken(env.DB, token, NOW));
    const sender = dripSender();
    const summary = await quietly(() => runDrip(env, sender, at));
    expect(summary.sent.welcome).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });
});

// --- copy shape (pinned verbatim-ish: flat, short, no marketing) ---------------------

describe("copy", () => {
  const unsubscribeUrl = "https://cloud.example/unsubscribe?t=x";
  const allCopies = () => [
    welcomeCopy({
      notesUrl: "https://notes.example/?add=y",
      consoleUrl: "https://cloud.example/console",
      connectUrl: "https://app.example/connect",
      unsubscribeUrl,
    }),
    welcomeCopy({
      notesUrl: null,
      consoleUrl: "https://cloud.example/console",
      connectUrl: "https://app.example/connect",
      unsubscribeUrl,
    }),
    connectNudgeCopy({ connectUrl: "https://app.example/connect", unsubscribeUrl }),
    feedbackCopy({ unsubscribeUrl }),
  ];

  test("every email footer carries the unsubscribe link; the PLAINTEXT part stays plain", () => {
    for (const c of allCopies()) {
      expect(c.text).toContain(`Stop these emails: ${unsubscribeUrl}`);
      expect(c.text).not.toContain("<"); // the text part is honest plain text, no markup
    }
  });

  test("every template's HTML part carries the unsubscribe link + its door link", () => {
    const [withVault, noVault, nudge, feedback] = allCopies();
    for (const c of allCopies()) {
      expect(c.html).toContain("<!doctype html>");
      expect(c.html).toContain(unsubscribeUrl); // footer "Stop these emails" link
      expect(c.html).toContain("Parachute"); // the text wordmark — no image assets
      expect(c.html).not.toContain("<img"); // nothing depends on remote assets
    }
    expect(withVault!.html).toContain("https://notes.example/?add=y");
    expect(withVault!.html).toContain("https://app.example/connect");
    expect(noVault!.html).toContain("https://cloud.example/console");
    expect(nudge!.html).toContain("https://app.example/connect");
    expect(feedback!.html).toContain("A human reads every reply.");
  });
});

// --- the real worker export ------------------------------------------------------------

describe("worker wiring", () => {
  test("the deployed drip cron sends through the real export (ledger row lands)", async () => {
    const liveNow = new Date();
    const u = await seedUserAt("wired@example.com", new Date(liveNow.getTime() - 10 * 60 * 1000));
    const ctrl = createScheduledController({ scheduledTime: liveNow, cron: DRIP_CRON });
    const ctx = createExecutionContext();
    await quietly(async () => {
      await worker.scheduled(ctrl, env, ctx);
      await waitOnExecutionContext(ctx);
    });
    expect(await ledgerRows(u.id)).toEqual(["welcome"]);
  });

  test("the staging drip trigger exists off-production and 404s ON production", async () => {
    await seedUserAt("trigger@example.com", new Date(Date.now() - 10 * 60 * 1000));
    const req = () => new Request(`${ISSUER}/__test/drip-run`, { method: "POST" });

    const staging = await quietly(async () => worker.fetch(req(), env));
    expect(staging.status).toBe(200);
    const summary = (await staging.json()) as { sent: { welcome: number } };
    expect(summary.sent.welcome).toBeGreaterThanOrEqual(1);

    const prod = await worker.fetch(req(), { ...env, ENVIRONMENT: "production" });
    expect(prod.status).toBe(404);
  });
});
