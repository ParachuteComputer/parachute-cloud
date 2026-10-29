/**
 * The password sign-up's browser binding (T-318 night, migration 0028).
 *
 * POST /signup no longer creates an account; it mints an ordinary magic link
 * and stores the chosen password's verifier on that link row. The password
 * must only be applied when the link (or its code) is used by the SAME browser
 * that asked, otherwise anyone could sign up with a stranger's address, wait
 * for the stranger to click "Create my account", and then sign in with the
 * password they chose. So the sign-up response sets a short-lived HttpOnly
 * cookie holding a random nonce; the link row holds only its sha256. Opened
 * anywhere else, the link still works like a plain magic link (a passwordless
 * account; a password can be set later on /console/security).
 */
import { randomBase64url, sha256Hex, timingSafeEqualString } from "./crypto.ts";
import { MAGIC_LINK_TTL_MS } from "./magic-links.ts";

export const SIGNUP_BINDING_COOKIE = "parachute_id_signup";

/** A fresh nonce for the cookie, and the hash that goes on the link row. */
export async function newSignupBinding(): Promise<{ nonce: string; hash: string }> {
  const nonce = randomBase64url(32);
  return { nonce, hash: await sha256Hex(nonce) };
}

/** Lives exactly as long as the link it pairs with. Path=/ so both /auth/verify and /auth/code see it. */
export function buildSignupBindingCookie(nonce: string): string {
  return `${SIGNUP_BINDING_COOKIE}=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(MAGIC_LINK_TTL_MS / 1000)}`;
}

export function clearSignupBindingCookie(): string {
  return `${SIGNUP_BINDING_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function parseSignupBindingCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SIGNUP_BINDING_COOKIE) {
      const v = rest.join("=");
      return v || null;
    }
  }
  return null;
}

/** True when `req` carries the cookie whose nonce hashes to `bindingHash`. */
export async function requestHoldsBinding(req: Request, bindingHash: string): Promise<boolean> {
  const nonce = parseSignupBindingCookie(req.headers.get("cookie"));
  if (!nonce) return false;
  return timingSafeEqualString(await sha256Hex(nonce), bindingHash);
}
