/**
 * Wire-shape pinning for outbound email (the 2026-07-03 launch blocker).
 *
 * The `send_email` binding's contract is EmailMessage — envelope + raw
 * RFC 5322 MIME (`new EmailMessage(from, to, raw)` from `cloudflare:email`).
 * The old `{ to, from, subject, html, text }` object was ACCEPTED by the
 * deployed binding (resolved, counted "sent") but never delivered; the
 * miniflare mock's "could not parse email: Cannot read properties of
 * undefined (reading 'value')" was PostalMime choking on the missing raw.
 *
 * These tests pin {@link buildRawEmail} with the SAME parser the runtime mock
 * uses (postal-mime) and replicate the mock's validation steps verbatim
 * (miniflare src/workers/email/send_email.worker.ts):
 *   1. PostalMime.parse(raw) succeeds,
 *   2. parsedEmail.messageId !== undefined      ("invalid message-id"),
 *   3. From: header address === envelope from   ("From: header does not match mail from"),
 *   4. no Received: header                      ("invalid headers set").
 * The full binding path (EmailMessage through the actual miniflare mock) is
 * additionally exercised by auth.test.ts's router tests, which send through
 * the REAL bound EMAIL mock — those passing with zero parse warnings is the
 * end-to-end confirmation.
 */
import { env } from "cloudflare:test";
import PostalMime from "postal-mime";
import { describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { type SendEmailBinding, bindingSender, buildRawEmail } from "../src/email.ts";
import type { EmailMessage } from "cloudflare:email";

const FROM = "noreply@parachute.computer";

/**
 * Raw MIME out of an EmailMessage. Miniflare's `cloudflare:email` shim returns
 * a plain `{ from, to, ["EmailMessage::raw"]: raw }` from the constructor (the
 * mock's send() reads exactly that key); real workerd keeps it internal. Cover
 * the shim key first, `.raw` as the fallback.
 */
function rawOf(msg: EmailMessage): string {
  const rec = msg as unknown as Record<string, unknown>;
  return String(rec["EmailMessage::raw"] ?? rec.raw ?? "");
}

async function parseAndValidate(raw: string, envelopeFrom: string) {
  // Step 1: the exact parser the mock runs.
  const parsed = await PostalMime.parse(raw);
  // Step 2: the mock refuses a message without a Message-ID.
  expect(parsed.messageId).toBeDefined();
  // Step 3: the mock refuses when the From: header ≠ envelope from.
  expect(parsed.from?.address).toBe(envelopeFrom);
  // Step 4: the mock refuses any Received: header.
  expect(parsed.headers.some((h) => h.key.toLowerCase() === "received")).toBe(false);
  return parsed;
}

describe("buildRawEmail — RFC 5322 shape (the runtime-mock contract)", () => {
  test("multipart text+html round-trips through postal-mime with all mock validations green", async () => {
    const raw = buildRawEmail({
      fromAddress: FROM,
      fromName: "Parachute Cloud",
      to: "someone@example.com",
      subject: "Your Parachute sign-in link",
      text: "Sign in: https://cloud.parachute.computer/auth/verify?token=abc",
      html: "<p>Sign in: <a href='https://cloud.parachute.computer/auth/verify?token=abc'>here</a></p>",
    });
    const parsed = await parseAndValidate(raw, FROM);
    expect(parsed.from?.name).toBe("Parachute Cloud");
    expect(parsed.to?.[0]?.address).toBe("someone@example.com");
    expect(parsed.subject).toBe("Your Parachute sign-in link");
    // Both alternatives survive the base64 transfer encoding byte-true.
    expect(parsed.text?.trim()).toBe("Sign in: https://cloud.parachute.computer/auth/verify?token=abc");
    expect(parsed.html).toContain("auth/verify?token=abc");
    // CRLF line endings throughout (RFC 5322) — no bare LF anywhere.
    expect(raw).not.toMatch(/[^\r]\n/);
  });

  test("text-only (ops emails) parses as a simple text/plain message", async () => {
    const raw = buildRawEmail({
      fromAddress: FROM,
      fromName: "Parachute Cloud",
      to: "ops@example.com",
      subject: "Health check failed",
      text: "identity D1 self-check failed at 04:00Z",
    });
    const parsed = await parseAndValidate(raw, FROM);
    expect(parsed.text?.trim()).toBe("identity D1 self-check failed at 04:00Z");
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
  });

  test("non-ASCII subject + body survive (RFC 2047 subject, base64 utf-8 bodies)", async () => {
    const raw = buildRawEmail({
      fromAddress: FROM,
      fromName: "Parachute Cloud",
      to: "uni@example.com",
      subject: "Welcome to your vault 🪂",
      text: "Ünïcode body — 🪂 works",
    });
    const parsed = await parseAndValidate(raw, FROM);
    expect(parsed.subject).toBe("Welcome to your vault 🪂");
    expect(parsed.text?.trim()).toBe("Ünïcode body — 🪂 works");
  });

  test("header-injection defense: CR/LF in header inputs cannot smuggle headers", async () => {
    const raw = buildRawEmail({
      fromAddress: FROM,
      fromName: "Parachute Cloud",
      to: "victim@example.com\r\nBcc: sneaky@evil.example",
      subject: "hi\r\nX-Injected: yes",
      text: "body",
    });
    const parsed = await PostalMime.parse(raw);
    expect(parsed.headers.some((h) => h.key.toLowerCase() === "bcc")).toBe(false);
    expect(parsed.headers.some((h) => h.key.toLowerCase() === "x-injected")).toBe(false);
  });

  test("drip options add Reply-To + RFC 8058 List-Unsubscribe headers, and only then", async () => {
    const unsubscribeUrl = "https://cloud.parachute.computer/unsubscribe?t=t0k";
    const raw = buildRawEmail({
      fromAddress: FROM,
      fromName: "Parachute Cloud",
      to: "drip@example.com",
      subject: "Welcome to Parachute",
      text: `Your vault is ready.\n\nStop these emails: ${unsubscribeUrl}`,
      replyTo: "hello@parachute.computer",
      unsubscribeUrl,
    });
    const parsed = await parseAndValidate(raw, FROM);
    expect(parsed.replyTo?.[0]?.address).toBe("hello@parachute.computer");
    const header = (key: string) => parsed.headers.find((h) => h.key.toLowerCase() === key)?.value;
    expect(header("list-unsubscribe")).toBe(`<${unsubscribeUrl}>`);
    expect(header("list-unsubscribe-post")).toBe("List-Unsubscribe=One-Click");

    // ...and a non-drip email (no replyTo/unsubscribeUrl) carries none of them.
    const plain = buildRawEmail({ fromAddress: FROM, fromName: "Parachute Cloud", to: "a@example.com", subject: "s", text: "t" });
    expect(plain.toLowerCase()).not.toContain("list-unsubscribe");
    expect(plain.toLowerCase()).not.toContain("reply-to");
  });

  test("deterministic inputs pin the exact header lines", () => {
    const raw = buildRawEmail({
      fromAddress: FROM,
      fromName: "Parachute Cloud",
      to: "pin@example.com",
      subject: "Pinned",
      text: "pinned",
      now: new Date("2026-07-03T05:00:00Z"),
      messageId: "fixed-id@parachute.computer",
    });
    expect(raw).toContain(`From: "Parachute Cloud" <${FROM}>\r\n`);
    expect(raw).toContain("To: <pin@example.com>\r\n");
    expect(raw).toContain("Subject: Pinned\r\n");
    expect(raw).toContain("Message-ID: <fixed-id@parachute.computer>\r\n");
    expect(raw).toContain("Date: Fri, 03 Jul 2026 05:00:00 +0000\r\n");
    expect(raw).toContain("MIME-Version: 1.0\r\n");
  });
});

describe("bindingSender — envelope + raw through the EmailMessage contract", () => {
  function captureBinding(): { binding: SendEmailBinding; sent: EmailMessage[] } {
    const sent: EmailMessage[] = [];
    return {
      binding: {
        async send(message: EmailMessage) {
          sent.push(message);
          return { messageId: "mock-id" };
        },
      },
      sent,
    };
  }

  test("sendMagicLink sends ONE EmailMessage whose envelope matches its parsed MIME", async () => {
    const { binding, sent } = captureBinding();
    const sender = bindingSender(binding, FROM);
    const res = await sender.sendMagicLink(
      "user@example.com",
      "https://cloud.parachute.computer/auth/verify?token=t0k",
      "482913",
      false,
    );
    expect(res).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    const msg = sent[0]!;
    // A real cloudflare:email EmailMessage: envelope from/to + the raw MIME
    // under the key the runtime mock's send() actually reads.
    expect(msg.from).toBe(FROM);
    expect(msg.to).toBe("user@example.com");
    const parsed = await parseAndValidate(rawOf(msg), FROM);
    expect(parsed.subject).toBe("Your Parachute code: 482 913");
    expect(parsed.text).toContain("https://cloud.parachute.computer/auth/verify?token=t0k");
    expect(parsed.html).toContain("https://cloud.parachute.computer/auth/verify?token=t0k");
    // The code (auth redesign §2) rides the body too, readable without the link.
    expect(parsed.text).toContain("482 913");
    expect(parsed.html).toContain("482 913");
  });

  test("G5: new-account vs returning variants differ in subject + copy (enumeration-safe — only the owner reads it)", async () => {
    const { binding: nb, sent: newSent } = captureBinding();
    await bindingSender(nb, FROM).sendMagicLink(
      "newbie@example.com",
      "https://cloud.parachute.computer/auth/verify?token=n",
      "111222",
      true,
    );
    const newMail = await parseAndValidate(rawOf(newSent[0]!), FROM);
    expect(newMail.subject).toBe("Welcome to Parachute — your code: 111 222");
    expect(newMail.html).toContain("Create my account");
    expect(newMail.text).toContain("creates a brand-new account");

    const { binding: rb, sent: retSent } = captureBinding();
    await bindingSender(rb, FROM).sendMagicLink(
      "back@example.com",
      "https://cloud.parachute.computer/auth/verify?token=r",
      "333444",
      false,
    );
    const retMail = await parseAndValidate(rawOf(retSent[0]!), FROM);
    expect(retMail.subject).toBe("Your Parachute code: 333 444");
    expect(retMail.html).toContain("Sign me in");
    expect(retMail.text).toContain("signs you in as back@example.com");
  });

  test("sendOps sends a text/plain EmailMessage", async () => {
    const { binding, sent } = captureBinding();
    const sender = bindingSender(binding, FROM);
    const res = await sender.sendOps({ to: "ops@example.com", subject: "Weekly digest", text: "users=3 vaults=4" });
    expect(res).toEqual({ ok: true });
    const parsed = await parseAndValidate(rawOf(sent[0]!), FROM);
    expect(parsed.subject).toBe("Weekly digest");
    expect(parsed.text?.trim()).toBe("users=3 vaults=4");
  });

  test("a throwing binding surfaces as { ok: false } (the neutral-200 log path upstream)", async () => {
    const sender = bindingSender(
      {
        async send() {
          throw Object.assign(new Error("sender not verified"), { code: "E_SENDER_NOT_VERIFIED" });
        },
      },
      FROM,
    );
    const res = await sender.sendMagicLink("user@example.com", "https://x.example/link", "555666", false);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("sender not verified");
  });
});

describe("end-to-end through the REAL bound miniflare mock", () => {
  test("POST /auth/magic sends through env.EMAIL and is counted SENT, not failed", async () => {
    // The wrangler.toml [[send_email]] binding is live in this suite, so this
    // request goes through miniflare's actual send_email mock — the strict
    // validator (PostalMime parse + Message-ID + From-match + no-Received)
    // that used to warn "could not parse email" on the old object shape. The
    // mock THROWS on an invalid message, which bindingSender records as a
    // failure and bumpMagicLinkEvent counts as "failed" — so `sent=1 failed=0`
    // in magic_link_events is the proof the mock now parses our MIME cleanly.
    const csrf = "test-csrf-token";
    const res = await app.fetch(
      new Request(`${env.ISSUER}/auth/magic`, {
        method: "POST",
        body: new URLSearchParams({ __csrf: csrf, email: "mock-proof@example.com" }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: env.ISSUER,
          cookie: `parachute_id_csrf=${csrf}`,
          "cf-connecting-ip": "10.44.44.44",
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const day = new Date().toISOString().slice(0, 10);
    const rows = await env.DB.prepare("SELECT event, count FROM magic_link_events WHERE day = ?")
      .bind(day)
      .all<{ event: string; count: number }>();
    const byEvent = new Map((rows.results ?? []).map((r) => [r.event, r.count]));
    expect(byEvent.get("sent") ?? 0).toBeGreaterThanOrEqual(1);
    expect(byEvent.get("failed") ?? 0).toBe(0);
  });
});
