import type { D1Database } from "@cloudflare/workers-types";

export interface UserRow {
  id: string;
  clerk_user_id: string;
  email: string;
  tier: string;
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
      "INSERT INTO users (id, clerk_user_id, email, tier, created_at) VALUES (?, ?, ?, 'free', ?)",
    )
    .bind(id, session.clerkUserId, session.email, now)
    .run();
  return { id, clerk_user_id: session.clerkUserId, email: session.email, tier: "free", created_at: now };
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return (
    (await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>()) ?? null
  );
}
