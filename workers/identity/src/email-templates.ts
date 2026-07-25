/**
 * The Parachute transactional-email templates — presentation only.
 *
 * Every email the identity worker sends to a PERSON (the magic-link/code email
 * and the three onboarding-drip emails) is composed here: subject + honest
 * plaintext part + brand-true HTML part, together, so copy and rendering can't
 * drift apart. The senders (email.ts) and the drip engine (drip.ts) import
 * these; nothing here touches the wire, the DB, or eligibility — changing this
 * file can change how an email LOOKS, never whether/where it is sent.
 *
 * Brand: the coral "vibrant" brand as ratified for the console (cloud#109) and
 * documented in parachute.computer/design/brand-tokens.md — warm paper grounds,
 * coral `#bf4a2a` buttons (white text, 4.97:1 AA), serif display over humanist
 * body, pill buttons, soft 18px cards. Voice stays the ratified drip voice:
 * plain, short, never marketing-brained.
 *
 * Email-client constraints (why this HTML looks the way it does):
 *   - table-based layout, single column, 560px max — no flex/grid;
 *   - every style INLINE (many clients strip <style>); the <style> block only
 *     carries dark-mode overrides (`!important` so they beat the inline light
 *     values in clients that honor prefers-color-scheme, e.g. Apple Mail);
 *   - system font stacks only (the brand's own stacks are system stacks —
 *     "Google Fonts retired" is stated brand intent), no webfonts, NO images —
 *     the wordmark is text, so nothing depends on remote assets or image loading;
 *   - bulletproof buttons: a padded table-cell + inline-block anchor with
 *     `mso-padding-alt` for Outlook (pill radius degrades to a rectangle there);
 *   - warm cream card on a slightly deeper cream ground (never pure white), so
 *     Gmail's forced dark-mode inversion lands somewhere tolerable;
 *   - the sign-in code is large, letter-spaced, real TEXT (selectable/copyable).
 */

// --- brand tokens (brand-tokens.md §1; dark values are that doc's §1 sketch) ----

const LIGHT = {
  ground: "#f7f1e6", // --pc-paper-2 — soft warm band
  card: "#fdfaf4", // --pc-paper — warm off-white (deliberately not #fff)
  ink: "#2a2521", // --pc-ink
  soft: "#6b6459", // --pc-ink-soft — 5.6:1 on paper
  line: "#ece5d8", // --pc-line
  line2: "#e2d9c8", // --pc-line-2
  coral: "#bf4a2a", // --pc-coral-btn — button bg / link text (AA both ways)
  panel: "#f5efe2", // --code-bg (console-minted, brand doc §5b)
} as const;

const DARK = {
  ground: "#1c1815",
  card: "#252019",
  ink: "#f0ebe1",
  soft: "#a89f8f",
  line: "#3a332a",
  panel: "#2e2820",
  coral: "#ec7a5c", // lightened coral that holds contrast on dark ground
} as const;

/** Display serif — the brand's exact `--font-serif` stack (all system fonts). */
const SERIF = `ui-serif,'New York','Iowan Old Style',Georgia,'Times New Roman',serif`;
/** Body — the brand's exact `--font-body` stack. */
const BODY = `-apple-system,system-ui,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;
/** Mono for the sign-in code — digits render distinctly and align. */
const MONO = `ui-monospace,'SF Mono',Menlo,Monaco,Consolas,'Courier New',monospace`;

/** Escape for HTML text AND double-quoted attribute contexts. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// --- building blocks (each returns a <tr> for the card's inner table) -----------

function heading(text: string): string {
  return `<tr><td class="ink" style="font-family:${SERIF};font-size:26px;line-height:1.2;font-weight:600;letter-spacing:-0.01em;color:${LIGHT.ink};padding:0 0 10px;">${escapeHtml(text)}</td></tr>`;
}

function para(html: string, opts: { tone?: "ink" | "soft"; size?: number; pad?: string } = {}): string {
  const tone = opts.tone ?? "soft";
  const color = tone === "ink" ? LIGHT.ink : LIGHT.soft;
  return `<tr><td class="${tone}" style="font-family:${BODY};font-size:${opts.size ?? 15}px;line-height:1.6;color:${color};padding:${opts.pad ?? "0 0 18px"};">${html}</td></tr>`;
}

/** Bulletproof pill button — padded td + inline-block anchor, mso-padding-alt for Outlook. */
function button(href: string, label: string, pad = "6px 0 28px"): string {
  return `<tr><td style="padding:${pad};">
<table role="presentation" border="0" cellspacing="0" cellpadding="0"><tr>
<td class="btn" bgcolor="${LIGHT.coral}" style="background:${LIGHT.coral};border-radius:999px;mso-padding-alt:13px 30px;">
<a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;padding:13px 30px;font-family:${BODY};font-size:15px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(label)}</a>
</td></tr></table>
</td></tr>`;
}

/** The sign-in code panel: label + the code, huge, letter-spaced, selectable text. */
function codePanel(labelText: string, formattedCode: string): string {
  return `<tr><td style="padding:0 0 24px;">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tr>
<td class="panel" align="center" bgcolor="${LIGHT.panel}" style="background:${LIGHT.panel};border:1px solid ${LIGHT.line2};border-radius:14px;padding:20px 16px 22px;">
<div class="soft" style="font-family:${BODY};font-size:13px;line-height:1.5;color:${LIGHT.soft};padding:0 0 10px;">${escapeHtml(labelText)}</div>
<div class="ink code" style="font-family:${MONO};font-size:34px;line-height:1.2;font-weight:600;letter-spacing:0.14em;color:${LIGHT.ink};">${escapeHtml(formattedCode)}</div>
</td></tr></table>
</td></tr>`;
}

function divider(pad = "4px 0 22px"): string {
  return `<tr><td style="padding:${pad};"><div class="line" style="border-top:1px solid ${LIGHT.line};font-size:1px;line-height:1px;">&nbsp;</div></td></tr>`;
}

/** A door's serif subheading (the welcome email's three-doors rhythm). */
function doorTitle(text: string): string {
  return `<tr><td class="ink" style="font-family:${SERIF};font-size:17px;line-height:1.3;font-weight:600;color:${LIGHT.ink};padding:0 0 6px;">${escapeHtml(text)}</td></tr>`;
}

/** Coral text link on its own line. */
function linkLine(href: string, label: string, pad = "0 0 22px"): string {
  return `<tr><td style="font-family:${BODY};font-size:15px;line-height:1.6;padding:${pad};"><a class="link" href="${escapeHtml(href)}" target="_blank" style="color:${LIGHT.coral};font-weight:600;text-decoration:underline;">${escapeHtml(label)}</a></td></tr>`;
}

/** Small faint block for raw-URL fallbacks / security notes. */
function fine(html: string, opts: { border?: boolean; pad?: string } = {}): string {
  const border = opts.border ? `border-top:1px solid ${LIGHT.line};` : "";
  const cls = opts.border ? "soft line" : "soft"; // .line keeps the hairline dark-mode-correct
  return `<tr><td class="${cls}" style="${border}font-family:${BODY};font-size:12.5px;line-height:1.6;color:${LIGHT.soft};padding:${opts.pad ?? (opts.border ? "16px 0 0" : "0 0 16px")};word-break:break-word;">${html}</td></tr>`;
}

/** Serif italic closing line ("The vault is yours."). */
function closing(text: string): string {
  return `<tr><td class="ink" style="font-family:${SERIF};font-style:italic;font-size:16px;line-height:1.4;color:${LIGHT.ink};padding:4px 0 0;">${escapeHtml(text)}</td></tr>`;
}

/**
 * The shared shell: ground, text wordmark, 560px soft card, optional under-card
 * footer (the drip unsubscribe line). `preheader` is the hidden inbox-preview
 * snippet — it must front-load what the email is about.
 */
function shell(opts: { title: string; preheader: string; cardRows: string[]; footerHtml?: string }): string {
  const footer = opts.footerHtml
    ? `<tr><td class="soft" align="center" style="font-family:${BODY};font-size:12.5px;line-height:1.6;color:${LIGHT.soft};padding:22px 24px 0;">${opts.footerHtml}</td></tr>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(opts.title)}</title>
<style>
  @media (prefers-color-scheme: dark) {
    .bg { background: ${DARK.ground} !important; }
    .card { background: ${DARK.card} !important; border-color: ${DARK.line} !important; }
    .panel { background: ${DARK.panel} !important; border-color: ${DARK.line} !important; }
    .ink { color: ${DARK.ink} !important; }
    .soft { color: ${DARK.soft} !important; }
    .line { border-color: ${DARK.line} !important; }
    .link, .wordmark { color: ${DARK.coral} !important; }
    .footer-link { color: ${DARK.soft} !important; }
  }
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${LIGHT.ground};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(opts.preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" class="bg" style="background:${LIGHT.ground};">
<tr><td align="center" style="padding:36px 16px 44px;">
<table role="presentation" width="560" border="0" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px;">
<tr><td class="wordmark" align="center" style="font-family:${SERIF};font-size:20px;font-weight:600;letter-spacing:0.01em;color:${LIGHT.coral};padding:0 0 20px;">Parachute&nbsp;&#x1FA82;</td></tr>
<tr><td class="card" style="background:${LIGHT.card};border:1px solid ${LIGHT.line};border-radius:18px;padding:36px 40px 32px;">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
${opts.cardRows.join("\n")}
</table>
</td></tr>
${footer}
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The drip emails' under-card footer: wordmark line + the unsubscribe link. */
function dripFooter(unsubscribeUrl: string): string {
  return `Parachute&nbsp;&nbsp;&middot;&nbsp;&nbsp;<a class="footer-link" href="${escapeHtml(unsubscribeUrl)}" target="_blank" style="color:${LIGHT.soft};text-decoration:underline;">Stop these emails</a>`;
}

// --- the templates --------------------------------------------------------------

/** A composed email: subject + honest plaintext part + branded HTML part. */
export interface EmailBodies {
  subject: string;
  text: string;
  html: string;
}

/** "481227" → "481 227" — a readable grouping for a lock-screen notification. */
export function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/**
 * The two magic-link variants (G5), chosen at send time on user-exists — the
 * earliest honest moment to tell new-vs-returning, and enumeration-safe because
 * only the address owner ever reads it (the on-page copy stays neutral). `to` is
 * the recipient (a validated email — safe to embed) so the returning copy can
 * say "as X". `code` (auth redesign §2) is the SAME single-use token's 6-digit
 * short-form spelling — the subject carries it so it's readable from a
 * lock-screen notification on a DIFFERENT device than the one signing in.
 */
export function magicLinkEmail(link: string, code: string, newAccount: boolean, to: string): EmailBodies {
  const formatted = formatCode(code);
  const subject = newAccount ? `Welcome to Parachute — your code: ${formatted}` : `Your Parachute code: ${formatted}`;
  const headingText = newAccount ? "Welcome to Parachute" : "Welcome back";
  const intro = newAccount
    ? "This link signs you in and creates a brand-new account — nothing is created unless you click it. You'll make your first vault right after."
    : `This link signs you in as ${to}. Your vault is where you left it.`;
  const buttonLabel = newAccount ? "Create my account & sign in" : "Sign me in";
  const codeLine = `Or, from another device, enter this code where you're signing in: ${formatted}`;
  const footerNote = newAccount
    ? "If you didn't request this, you can safely ignore this email — nothing is created and no one can sign in without the link or code."
    : "If you didn't request this, you can safely ignore this email — no one can sign in without the link or code.";
  const text = [headingText, "", intro, "", "It works once and expires in 10 minutes.", "", link, "", codeLine, "", footerNote].join(
    "\n",
  );
  const html = shell({
    title: subject,
    preheader: `Your code: ${formatted} — the link works once and expires in 10 minutes.`,
    cardRows: [
      heading(headingText),
      para(`${escapeHtml(intro)} It works once and expires in 10 minutes.`, { pad: "0 0 22px" }),
      button(link, buttonLabel, "0 0 26px"),
      codePanel("Signing in on another device? Enter this code instead:", formatted),
      fine(
        `Or paste this link into your browser:<br><a class="link" href="${escapeHtml(link)}" target="_blank" style="color:${LIGHT.coral};word-break:break-all;">${escapeHtml(link)}</a>`,
      ),
      fine(escapeHtml(footerNote), { border: true }),
    ],
  });
  return { subject, text, html };
}

// --- the drip copy (ratified voice: plain, short, human) --------------------------

export type DripCopy = EmailBodies;

function textFooter(unsubscribeUrl: string): string {
  return ["", "Parachute", `Stop these emails: ${unsubscribeUrl}`].join("\n");
}

/**
 * Day-0 welcome: the vault's three doors. `notesUrl` is the user's first
 * vault's app door when they already have a vault; a user who signed up but
 * hasn't named a vault yet gets the name-your-vault variant instead.
 * `connectUrl` is the app's Connect-your-AI surface (post-cutover; vault
 * creation itself still lives in the console, hence `consoleUrl` stays for
 * the no-vault variant).
 */
export function welcomeCopy(opts: {
  notesUrl: string | null;
  consoleUrl: string;
  connectUrl: string;
  unsubscribeUrl: string;
}): DripCopy {
  const subject = "Welcome to Parachute";
  if (opts.notesUrl === null) {
    return {
      subject,
      text: [
        "Your account is ready. First step: name your vault.",
        "",
        opts.consoleUrl,
        "",
        "Once it exists you get three doors: your notes in the browser, your AI over MCP, and this email address. Reply any time. A person reads it.",
        textFooter(opts.unsubscribeUrl),
      ].join("\n"),
      html: shell({
        title: subject,
        preheader: "Your account is ready. First step: name your vault.",
        cardRows: [
          heading("Your account is ready."),
          para("First step: name your vault.", { pad: "0 0 22px" }),
          button(opts.consoleUrl, "Name your vault", "0 0 26px"),
          para(
            "Once it exists you get three doors: your notes in the browser, your AI over MCP, and this email address. Reply any time. A person reads it.",
            { pad: "0" },
          ),
        ],
        footerHtml: dripFooter(opts.unsubscribeUrl),
      }),
    };
  }
  return {
    subject,
    text: [
      "Your vault is ready. It has three doors.",
      "",
      "Open your notes:",
      opts.notesUrl,
      "That's your vault in the browser. Write anything.",
      "",
      "Connect your AI:",
      opts.connectUrl,
      "Your vault speaks MCP. Open Connect your AI in the app for your MCP URL and a copy-paste command for Claude.",
      "",
      "Talk to a human:",
      "Reply to this email. A person reads it.",
      "",
      "The vault is yours.",
      textFooter(opts.unsubscribeUrl),
    ].join("\n"),
    html: shell({
      title: subject,
      preheader: "Your vault is ready. It has three doors.",
      cardRows: [
        heading("Your vault is ready."),
        para("It has three doors.", { pad: "0 0 24px" }),
        doorTitle("Open your notes"),
        para("That's your vault in the browser. Write anything."),
        button(opts.notesUrl, "Open your notes", "0 0 26px"),
        divider("0 0 22px"),
        doorTitle("Connect your AI"),
        para("Your vault speaks MCP. Open Connect your AI in the app for your MCP URL and a copy-paste command for Claude.", {
          pad: "0 0 10px",
        }),
        linkLine(opts.connectUrl, "Connect your AI"),
        divider("0 0 22px"),
        doorTitle("Talk to a human"),
        para("Reply to this email. A person reads it.", { pad: "0 0 8px" }),
        closing("The vault is yours."),
      ],
      footerHtml: dripFooter(opts.unsubscribeUrl),
    }),
  };
}

/** Day-3 connect nudge — only reaches accounts with no AI activity. */
export function connectNudgeCopy(opts: { connectUrl: string; unsubscribeUrl: string }): DripCopy {
  const subject = "Connect your AI to your vault";
  return {
    subject,
    text: [
      "You signed up for Parachute a few days ago. Your vault hasn't met your AI yet.",
      "",
      "Your vault speaks MCP. Point Claude, or any assistant that speaks it, at your vault and it can read and write your notes. You approve what it can touch.",
      "",
      "The connection URL and a copy-paste command are in the app's Connect your AI:",
      opts.connectUrl,
      "",
      "If you just want a notes app, ignore this. The vault works fine without an AI.",
      textFooter(opts.unsubscribeUrl),
    ].join("\n"),
    html: shell({
      title: subject,
      preheader: "Point Claude — or any assistant that speaks MCP — at your vault.",
      cardRows: [
        heading("Your vault hasn't met your AI yet."),
        para("You signed up for Parachute a few days ago. Your vault speaks MCP: point Claude, or any assistant that speaks it, at your vault and it can read and write your notes. You approve what it can touch.", {
          pad: "0 0 8px",
        }),
        para("The connection URL and a copy-paste command are in the app's Connect your AI.", { pad: "0 0 22px" }),
        button(opts.connectUrl, "Connect your AI", "0 0 26px"),
        fine("If you just want a notes app, ignore this. The vault works fine without an AI.", { border: true }),
      ],
      footerHtml: dripFooter(opts.unsubscribeUrl),
    }),
  };
}

/** Day-14 feedback ask. */
export function feedbackCopy(opts: { unsubscribeUrl: string }): DripCopy {
  const subject = "How's your vault?";
  return {
    subject,
    text: [
      "You've had your Parachute vault for two weeks.",
      "",
      "How is it going? Reply and tell us one thing: what you wanted it to do that it didn't, or what surprised you. A human reads every reply.",
      textFooter(opts.unsubscribeUrl),
    ].join("\n"),
    html: shell({
      title: subject,
      preheader: "Reply and tell us one thing. A human reads every reply.",
      cardRows: [
        heading("How's your vault?"),
        para("You've had your Parachute vault for two weeks.", { pad: "0 0 8px" }),
        para(
          "How is it going? Reply and tell us one thing: <span class=\"ink\" style=\"color:" +
            LIGHT.ink +
            ";font-weight:600;\">what you wanted it to do that it didn't</span>, or what surprised you.",
          { pad: "0 0 8px" },
        ),
        closing("A human reads every reply."),
      ],
      footerHtml: dripFooter(opts.unsubscribeUrl),
    }),
  };
}
