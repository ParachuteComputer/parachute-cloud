#!/usr/bin/env bun
/**
 * operator-delete-account.ts — act on an EMAILED "please delete my account"
 * request (T-318). Drives the operator admin action (/admin/users/delete) with
 * YOUR operator session, so it runs the exact same path as the button in
 * /admin/users and as self-service deletion:
 *
 *   - the account closes now (signed out everywhere, vault tokens refused);
 *   - the account holder gets the deletion email with a 24-hour undo link;
 *   - after 24 hours the hourly sweep erases its vaults, notes, files,
 *     snapshots, exports and account rows;
 *   - the action is LOGGED server-side: an `account_audit` row naming your
 *     operator id (hashed target, no email stored) and an
 *     `event=admin_account_delete_requested` Workers Logs line.
 *
 * The admin page is the primary path; this CLI exists so the action can be
 * scripted from the support inbox. It never reads or prints secrets beyond the
 * session you pass in, and it refuses to act without the email typed twice.
 *
 *   OPERATOR_SESSION=<parachute_id_session cookie value> \
 *     bun scripts/operator-delete-account.ts --origin https://my.parachute.computer --email person@example.com --confirm person@example.com
 *
 * Get the session value from your browser's cookie for the origin while signed
 * in as an operator. Exit 0 on success, 1 on any refusal.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const origin = (arg("origin") ?? "").replace(/\/$/, "");
const email = (arg("email") ?? "").trim();
const confirm = (arg("confirm") ?? "").trim();
const session = process.env.OPERATOR_SESSION ?? "";

if (!origin || !email || !session) {
  console.error("usage: OPERATOR_SESSION=… bun scripts/operator-delete-account.ts --origin <url> --email <addr> --confirm <addr>");
  process.exit(1);
}
if (confirm.toLowerCase() !== email.toLowerCase()) {
  console.error("--confirm must repeat --email exactly (case-insensitive). Nothing was sent.");
  process.exit(1);
}

function setCookieValue(res: Response, name: string): string | null {
  for (const c of res.headers.getSetCookie()) {
    const m = new RegExp(`(?:^|; )${name}=([^;]+)`).exec(c);
    if (m) return m[1]!;
  }
  return null;
}

const page = await fetch(`${origin}/admin/users/delete?email=${encodeURIComponent(email)}`, {
  headers: { cookie: `parachute_id_session=${session}` },
  redirect: "manual",
});
if (page.status === 404) {
  console.error("404 — the session is not an operator session on this origin (or it expired).");
  process.exit(1);
}
if (page.status === 302) {
  console.error(`No account found for that email (${page.headers.get("location")}).`);
  process.exit(1);
}
const html = await page.text();
if (!html.includes('name="confirm_email"')) {
  console.error("The account is already scheduled for deletion, or the page was not the confirm form. Nothing was sent.");
  process.exit(1);
}
const userId = /name="user_id" value="([^"]+)"/.exec(html)?.[1];
const csrf = setCookieValue(page, "parachute_id_csrf") ?? /name="__csrf" value="([^"]+)"/.exec(html)?.[1];
if (!userId || !csrf) {
  console.error("Could not read the confirm form. Nothing was sent.");
  process.exit(1);
}

const res = await fetch(`${origin}/admin/users/delete`, {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin,
    cookie: `parachute_id_session=${session}; parachute_id_csrf=${csrf}`,
  },
  body: new URLSearchParams({ __csrf: csrf, user_id: userId, confirm_email: email }).toString(),
  redirect: "manual",
});
const where = res.headers.get("location") ?? "";
if (res.status === 302 && where.includes("notice=delete-requested")) {
  console.log("Deletion requested. The account is closed now; the holder was emailed a 24-hour undo link; it is erased after 24 hours. Logged as your operator action.");
  process.exit(0);
}
console.error(`Refused: status ${res.status} ${where}`);
process.exit(1);
