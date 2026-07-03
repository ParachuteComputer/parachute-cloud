/**
 * Outbound email, behind an interface so the magic-link flow is testable NOW and
 * the real sender drops in when the sending domain is onboarded (cloud#31).
 *
 * Cloudflare Email Sending (public beta, Workers Paid) exposes a `send_email`
 * Worker binding: `env.EMAIL.send({ to, from, subject, html, text })`. It needs
 * the FROM domain onboarded (a one-time dashboard/CLI step that adds SPF + DKIM
 * to the zone). Until that's done — or in any non-production environment — the
 * `devLogSender` writes the link to the worker log and the handler echoes it in a
 * response header, so the flow works end-to-end without real email.
 *
 * Selection: use the binding when it's bound; otherwise dev-log. The "echo the
 * link back" affordance is separately gated on ENVIRONMENT !== "production" (see
 * auth-handlers.ts), so a misconfigured prod can't leak links even if the binding
 * is somehow absent — and, symmetrically, a NON-production deploy with the real
 * binding bound sends the email AND still echoes the header (the headless dev/
 * smoke flow keeps working after the binding lands).
 */

/** The subset of the Cloudflare `send_email` binding we use. */
export interface SendEmailBinding {
  send(message: {
    to: string | string[];
    from: { email: string; name?: string } | string;
    subject: string;
    html?: string;
    text?: string;
  }): Promise<{ messageId?: string }>;
}

export type SendResult = { ok: true } | { ok: false; error: string };

/** A plain-text operational email (health alerts, the weekly ops digest). */
export interface OpsEmail {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  readonly kind: "binding" | "devlog";
  sendMagicLink(to: string, link: string): Promise<SendResult>;
  /** Generic operational send — plain text, no templating. Used by ops.ts. */
  sendOps(msg: OpsEmail): Promise<SendResult>;
}

const FROM_NAME = "Parachute Cloud";
const SUBJECT = "Your Parachute sign-in link";

function magicLinkBodies(link: string): { html: string; text: string } {
  const text = [
    "Sign in to Parachute Cloud",
    "",
    "Click the link below to sign in. It works once and expires in 10 minutes.",
    "",
    link,
    "",
    "If you didn't request this, you can safely ignore this email — no one can sign in without the link.",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f1">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f1;padding:2.5rem 1rem">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:32rem;background:#ffffff;border:1px solid #dde3d6;border-radius:14px;padding:2rem;font-family:'DM Sans',-apple-system,system-ui,sans-serif;color:#2b332a">
        <tr><td style="font-family:Georgia,serif;font-size:1.05rem;color:#4c6547;padding-bottom:1.25rem">Parachute</td></tr>
        <tr><td style="font-family:Georgia,serif;font-size:1.6rem;line-height:1.2;padding-bottom:.6rem">Sign in to Parachute Cloud</td></tr>
        <tr><td style="color:#6a7566;line-height:1.55;padding-bottom:1.4rem">Click the button below to sign in. It works once and expires in 10 minutes.</td></tr>
        <tr><td style="padding-bottom:1.4rem"><a href="${link}" style="display:inline-block;background:#5f7a57;color:#ffffff;text-decoration:none;padding:.7rem 1.4rem;border-radius:9px;font-weight:600">Sign in</a></td></tr>
        <tr><td style="color:#6a7566;font-size:.85rem;line-height:1.5;word-break:break-all">Or paste this link into your browser:<br><a href="${link}" style="color:#4c6547">${link}</a></td></tr>
        <tr><td style="color:#9aa693;font-size:.8rem;line-height:1.5;padding-top:1.4rem;border-top:1px solid #eef1ea;margin-top:1rem">If you didn't request this, you can safely ignore this email — no one can sign in without the link.</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { html, text };
}

/** Cloudflare `send_email` binding sender. */
export function bindingSender(binding: SendEmailBinding, fromAddress: string): EmailSender {
  async function send(message: Parameters<SendEmailBinding["send"]>[0]): Promise<SendResult> {
    try {
      await binding.send(message);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
  }
  return {
    kind: "binding",
    async sendMagicLink(to, link) {
      const { html, text } = magicLinkBodies(link);
      return send({ to, from: { email: fromAddress, name: FROM_NAME }, subject: SUBJECT, html, text });
    },
    async sendOps({ to, subject, text }) {
      return send({ to, from: { email: fromAddress, name: FROM_NAME }, subject, text });
    },
  };
}

/** Dev/test sender: logs the link (visible in `wrangler tail`), never sends. */
export function devLogSender(): EmailSender {
  return {
    kind: "devlog",
    async sendMagicLink(to, link) {
      console.log(`[magic-link] would email ${to}: ${link}`);
      return { ok: true };
    },
    async sendOps({ to, subject, text }) {
      // Staging's deterministic "alert": the full email lands in the worker log
      // (queryable now that [observability] is on) instead of an inbox.
      console.log(`[ops-email] would email ${to}: ${subject}\n${text}`);
      return { ok: true };
    },
  };
}
