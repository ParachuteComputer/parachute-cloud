/**
 * Clerk session verification + dev bypass.
 *
 * Gates admin actions (dashboard, signup, billing). Vault MCP/API access
 * uses scoped tokens from @openparachute/core, not Clerk sessions.
 *
 * Dev mode: if `env.ENVIRONMENT !== "production"` and the request has
 * `X-Dev-User: <clerk-id>:<email>`, we synthesize a session. Never runs
 * in production because the header is ignored there.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../env.js";
import { createOrGetUser, type UserRow } from "../db/users.js";

export interface SessionUser {
  clerkUserId: string;
  email: string;
}

export type AuthedContext = Context<{
  Bindings: Env;
  Variables: { session: SessionUser; user: UserRow };
}>;

async function verifyClerkSession(
  request: Request,
  env: Env,
): Promise<SessionUser | null> {
  if (!env.CLERK_SECRET_KEY) return null;
  const auth = request.headers.get("Authorization");
  const token = auth?.startsWith("Bearer ")
    ? auth.slice(7)
    : parseCookie(request.headers.get("Cookie"), "__session");
  if (!token) return null;

  try {
    const { verifyToken } = await import("@clerk/backend");
    const payload = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
    const sub = (payload as { sub?: string }).sub;
    const email =
      (payload as { email?: string }).email ??
      (payload as { primary_email_address?: string }).primary_email_address ??
      `${sub}@clerk.invalid`;
    if (!sub) return null;
    return { clerkUserId: sub, email };
  } catch {
    return null;
  }
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export function clerkMiddleware(): MiddlewareHandler<{ Bindings: Env; Variables: { session: SessionUser; user: UserRow } }> {
  return async (c, next) => {
    const env = c.env;
    let session = await verifyClerkSession(c.req.raw, env);

    if (!session && env.ENVIRONMENT !== "production") {
      const dev = c.req.header("X-Dev-User");
      if (dev) {
        const [clerkUserId, email] = dev.split(":");
        if (clerkUserId) {
          session = { clerkUserId, email: email ?? `${clerkUserId}@dev.local` };
        }
      }
    }

    if (!session) return c.text("unauthorized", 401);

    const user = await createOrGetUser(env.ACCOUNTS_DB, session);
    c.set("session", session);
    c.set("user", user);
    return next();
  };
}
