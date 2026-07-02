/**
 * Resolve the logged-in user for a cookie-bearing request. Shared by the console
 * (`console.ts`) and the security/auth handlers (`auth-handlers.ts`) — its own
 * module so neither has to import the other.
 */
import { findActiveSession, parseSessionCookie } from "./sessions.ts";
import type { OAuthDeps } from "./oauth-shared.ts";
import { getUserById, type User } from "./users.ts";

export async function sessionUser(db: D1Database, req: Request, deps: OAuthDeps): Promise<User | null> {
  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  if (!sessionId) return null;
  const session = await findActiveSession(db, sessionId, deps.now?.() ?? new Date());
  if (!session) return null;
  return getUserById(db, session.userId);
}
