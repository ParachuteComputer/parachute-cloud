import type { D1Database } from "@cloudflare/workers-types";

export interface UserRow {
  id: string;
  clerk_user_id: string;
  email: string;
  hostname: string | null;
  created_at: number;
}

export async function createOrGetUser(
  db: D1Database,
  session: { clerkUserId: string; email: string },
): Promise<UserRow> {
  const existing = await db
    .prepare("SELECT * FROM users WHERE clerk_user_id = ?")
    .bind(session.clerkUserId)
    .first<UserRow>();
  if (existing) return existing;

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT INTO users (id, clerk_user_id, email, hostname, created_at) VALUES (?, ?, ?, NULL, ?)",
    )
    .bind(id, session.clerkUserId, session.email, now)
    .run();
  return {
    id,
    clerk_user_id: session.clerkUserId,
    email: session.email,
    hostname: null,
    created_at: now,
  };
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return (
    (await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>()) ?? null
  );
}

export async function getUserByHostname(
  db: D1Database,
  hostname: string,
): Promise<UserRow | null> {
  return (
    (await db.prepare("SELECT * FROM users WHERE hostname = ?").bind(hostname).first<UserRow>()) ??
    null
  );
}

export async function setUserHostname(
  db: D1Database,
  userId: string,
  hostname: string,
): Promise<void> {
  await db
    .prepare("UPDATE users SET hostname = ? WHERE id = ?")
    .bind(hostname, userId)
    .run();
}
