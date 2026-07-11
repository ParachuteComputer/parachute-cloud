/**
 * Outbound email, behind an interface so the magic-link flow is testable NOW and
 * the real sender drops in when the sending domain is onboarded (cloud#31).
 *
 * THE WIRE SHAPE (fixed 2026-07-03 — the launch-blocking lesson): the
 * `send_email` binding's contract is **EmailMessage** — an envelope
 * (`from`, `to`) plus a **raw RFC 5322 MIME message** — via
 * `new EmailMessage(from, to, raw)` from `cloudflare:email`. It is NOT a bare
 * `{ to, from, subject, html, text }` fields object: the deployed binding
 * ACCEPTED that object (send() resolved; `magic_link_events` counted 4
 * "sent") but the message had no parseable MIME behind it and silently never
 * arrived, while a `wrangler email sending send` REST-side test to the same
 * inbox WAS delivered. Miniflare's send_email mock had been saying exactly
 * this all along — "could not parse email: Cannot read properties of
 * undefined (reading 'value')" is PostalMime choking on the missing
 * `message[RAW_EMAIL]` — and we dismissed it as a mock rough edge. It was the
 * contract. (Current Email Sending docs allow "EmailMessage or
 * EmailMessageBuilder"; raw-MIME EmailMessage is the shape every runtime
 * generation accepts, so it's what we build.)
 *
 * The mock (a faithful port of the runtime's validation) additionally
 * enforces, and {@link buildRawEmail} therefore guarantees:
 *   - a `Message-ID` header is present ("invalid message-id" otherwise),
 *   - the `From:` header address EQUALS the envelope `from`,
 *   - no `Received:` header,
 * plus ordinary MIME hygiene: CRLF line endings, multipart/alternative for
 * text+html, base64 content-transfer-encoding (sidesteps every line-length /
 * 8-bit pitfall), RFC 2047 subject encoding when non-ASCII, and CR/LF
 * stripped out of header values (header-injection defense).
 *
 * Sender selection is unchanged: use the binding when it's bound; otherwise
 * dev-log. The "echo the link back" affordance is separately gated on
 * ENVIRONMENT !== "production" (see auth-handlers.ts), so a misconfigured prod
 * can't leak links even if the binding is somehow absent — and, symmetrically,
 * a NON-production deploy with the real binding bound sends the email AND
 * still echoes the header (the headless dev/smoke flow keeps working).
 */
import { EmailMessage } from "cloudflare:email";

/**
 * The subset of the Cloudflare `send_email` binding we use. Takes the real
 * `cloudflare:email` EmailMessage; newer runtimes resolve `{ messageId }`,
 * older ones resolve void — we depend on neither.
 */
export interface SendEmailBinding {
  send(message: EmailMessage): Promise<{ messageId?: string } | void>;
}

export type SendResult = { ok: true } | { ok: false; error: string };

/** A plain-text operational email (health alerts, the weekly ops digest). */
export interface OpsEmail {
  to: string;
  subject: string;
  text: string;
}

/**
 * A plain-text onboarding-drip email (drip.ts). Always carries the unsubscribe
 * URL — the binding sender turns it into RFC 8058 List-Unsubscribe headers in
 * addition to the footer link the copy already contains — and a Reply-To
 * pointed at a human.
 */
export interface DripEmail {
  to: string;
  subject: string;
  text: string;
  unsubscribeUrl: string;
  replyTo?: string;
}

export interface EmailSender {
  readonly kind: "binding" | "devlog";
  /** `newAccount` picks the email variant (G5): new-account vs returning copy. */
  sendMagicLink(to: string, link: string, newAccount: boolean): Promise<SendResult>;
  /** Generic operational send — plain text, no templating. Used by ops.ts. */
  sendOps(msg: OpsEmail): Promise<SendResult>;
  /** Onboarding-drip send — plain text + unsubscribe headers. Used by drip.ts. */
  sendDrip(msg: DripEmail): Promise<SendResult>;
}

const FROM_NAME = "Parachute Cloud";
const SUBJECT = "Your Parachute sign-in link";

// --- raw RFC 5322 building ---------------------------------------------------

const CRLF = "\r\n";

/** Strip CR/LF (and NUL) from a header value — header-injection defense. */
function headerSafe(value: string): string {
  return value.replace(/[\r\n\0]+/g, " ").trim();
}

/** UTF-8 → base64, chunked (String.fromCharCode spread overflows on big bodies). */
function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Base64 body wrapped at the RFC-friendly 76 columns. */
function base64Body(s: string): string {
  return base64Utf8(s).replace(/.{1,76}/g, (line) => line + CRLF).trimEnd();
}

/** RFC 2047-encode a header value when it isn't plain ASCII. */
function encodeHeaderText(value: string): string {
  const safe = headerSafe(value);
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(safe) ? safe : `=?utf-8?B?${base64Utf8(safe)}?=`;
}

/** `"Display Name" <addr>` with the name quoted (or 2047-encoded) as needed. */
function formatFrom(name: string, address: string): string {
  const encoded = encodeHeaderText(name);
  const display = encoded.startsWith("=?") ? encoded : `"${encoded.replace(/(["\\])/g, "\\$1")}"`;
  return `${display} <${headerSafe(address)}>`;
}

export interface RawEmailOpts {
  fromAddress: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  /** When present the message is multipart/alternative (text + html). */
  html?: string;
  /** When present, adds a Reply-To header (drip emails: replies reach a human). */
  replyTo?: string;
  /**
   * When present, adds `List-Unsubscribe: <url>` plus the RFC 8058 one-click
   * companion `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (mail
   * providers POST that body to the URL — the /unsubscribe route accepts both
   * GET and POST on the same token).
   */
  unsubscribeUrl?: string;
  /** Deterministic clock/id for tests. */
  now?: Date;
  messageId?: string;
}

/**
 * Build the full RFC 5322 message the EmailMessage envelope wraps. Exported
 * pure so the tests can pin the shape with the SAME parser the runtime mock
 * uses (postal-mime).
 */
export function buildRawEmail(opts: RawEmailOpts): string {
  const domain = opts.fromAddress.split("@")[1] ?? "parachute.computer";
  const messageId = opts.messageId ?? `${crypto.randomUUID()}@${domain}`;
  const date = (opts.now ?? new Date()).toUTCString().replace(/GMT$/, "+0000");
  const headers = [
    `From: ${formatFrom(opts.fromName, opts.fromAddress)}`,
    `To: <${headerSafe(opts.to)}>`,
    ...(opts.replyTo ? [`Reply-To: <${headerSafe(opts.replyTo)}>`] : []),
    `Subject: ${encodeHeaderText(opts.subject)}`,
    `Message-ID: <${headerSafe(messageId)}>`,
    `Date: ${date}`,
    ...(opts.unsubscribeUrl
      ? [
          `List-Unsubscribe: <${headerSafe(opts.unsubscribeUrl)}>`,
          "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
        ]
      : []),
    "MIME-Version: 1.0",
  ];

  if (opts.html === undefined) {
    return [
      ...headers,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Body(opts.text),
      "",
    ].join(CRLF);
  }

  // multipart/alternative: text first (lowest fidelity), html last (preferred).
  const boundary = `=_pc_${crypto.randomUUID().replace(/-/g, "")}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(opts.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(opts.html),
    `--${boundary}--`,
    "",
  ].join(CRLF);
}

// --- message bodies ------------------------------------------------------------

/**
 * The two magic-link variants (G5), chosen at send time on user-exists — the
 * earliest honest moment to tell new-vs-returning, and enumeration-safe because
 * only the address owner ever reads it (the on-page copy stays neutral). `to` is
 * the recipient (a validated email — safe to embed) so the returning copy can
 * say "as X".
 */
function magicLinkBodies(
  link: string,
  newAccount: boolean,
  to: string,
): { subject: string; html: string; text: string } {
  const subject = newAccount ? "Welcome to Parachute — your sign-in link" : SUBJECT;
  const heading = newAccount ? "Welcome to Parachute" : "Welcome back";
  const intro = newAccount
    ? "This link signs you in and creates a brand-new account — nothing is created unless you click it. You'll make your first vault right after."
    : `This link signs you in as ${to}. Your vault is where you left it.`;
  const buttonLabel = newAccount ? "Create my account & sign in" : "Sign me in";
  const footer = newAccount
    ? "If you didn't request this, you can safely ignore this email — nothing is created and no one can sign in without the link."
    : "If you didn't request this, you can safely ignore this email — no one can sign in without the link.";
  const text = [heading, "", intro, "", "It works once and expires in 10 minutes.", "", link, "", footer].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f1">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f1;padding:2.5rem 1rem">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:32rem;background:#ffffff;border:1px solid #dde3d6;border-radius:14px;padding:2rem;font-family:'DM Sans',-apple-system,system-ui,sans-serif;color:#2b332a">
        <tr><td style="font-family:Georgia,serif;font-size:1.05rem;color:#4c6547;padding-bottom:1.25rem">Parachute</td></tr>
        <tr><td style="font-family:Georgia,serif;font-size:1.6rem;line-height:1.2;padding-bottom:.6rem">${heading}</td></tr>
        <tr><td style="color:#6a7566;line-height:1.55;padding-bottom:1.4rem">${intro} It works once and expires in 10 minutes.</td></tr>
        <tr><td style="padding-bottom:1.4rem"><a href="${link}" style="display:inline-block;background:#5f7a57;color:#ffffff;text-decoration:none;padding:.7rem 1.4rem;border-radius:9px;font-weight:600">${buttonLabel}</a></td></tr>
        <tr><td style="color:#6a7566;font-size:.85rem;line-height:1.5;word-break:break-all">Or paste this link into your browser:<br><a href="${link}" style="color:#4c6547">${link}</a></td></tr>
        <tr><td style="color:#9aa693;font-size:.8rem;line-height:1.5;padding-top:1.4rem;border-top:1px solid #eef1ea;margin-top:1rem">${footer}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { subject, html, text };
}

// --- senders -------------------------------------------------------------------

/**
 * Cloudflare `send_email` binding sender — builds the raw MIME + envelope
 * (see the module note: EmailMessage is the contract) and sends.
 */
export function bindingSender(binding: SendEmailBinding, fromAddress: string): EmailSender {
  async function send(opts: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    replyTo?: string;
    unsubscribeUrl?: string;
  }): Promise<SendResult> {
    try {
      const raw = buildRawEmail({ fromAddress, fromName: FROM_NAME, ...opts });
      await binding.send(new EmailMessage(fromAddress, opts.to, raw));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
  }
  return {
    kind: "binding",
    async sendMagicLink(to, link, newAccount) {
      const { subject, html, text } = magicLinkBodies(link, newAccount, to);
      return send({ to, subject, html, text });
    },
    async sendOps({ to, subject, text }) {
      return send({ to, subject, text });
    },
    async sendDrip({ to, subject, text, unsubscribeUrl, replyTo }) {
      return send({ to, subject, text, unsubscribeUrl, replyTo });
    },
  };
}

/** Dev/test sender: logs the link (visible in `wrangler tail`), never sends. */
export function devLogSender(): EmailSender {
  return {
    kind: "devlog",
    async sendMagicLink(to, link, newAccount) {
      console.log(`[magic-link] would email ${to} (${newAccount ? "new" : "returning"}): ${link}`);
      return { ok: true };
    },
    async sendOps({ to, subject, text }) {
      // Staging's deterministic "alert": the full email lands in the worker log
      // (queryable now that [observability] is on) instead of an inbox.
      console.log(`[ops-email] would email ${to}: ${subject}\n${text}`);
      return { ok: true };
    },
    async sendDrip({ to, subject, text }) {
      // Same posture as sendOps: staging's deterministic drip "send" is a log
      // line (the address is fine here — this sender never runs in production).
      console.log(`[drip-email] would email ${to}: ${subject}\n${text}`);
      return { ok: true };
    },
  };
}
