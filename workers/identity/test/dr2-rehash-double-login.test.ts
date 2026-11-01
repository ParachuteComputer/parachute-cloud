/**
 * T-318 day review 2 (reviewer a): #347 made the legacy-hash upgrade write
 * conditional on the verifier the sign-in matched, and the session insert
 * conditional on the row still holding the verifier the upgrade returned. Two
 * correct sign-ins of the same legacy-hash account that overlap (a double
 * submit, two tabs, an app retry) both match the old verifier; the first
 * upgrade lands, the second misses, keeps the OLD verifier as its proof, and
 * the session insert then refuses a correct password: the owner is bounced to
 * /login. Before #347 both sign-ins got a session.
 */
import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import app from "../src/index.ts";
import { CSRF, ISSUER, seedUser } from "./helpers.ts";

function sessionCookie(res: Response): string | null {
  for (const c of (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie()) {
    const m = /^parachute_id_session=([^;]+)/.exec(c);
    if (m) return m[1]!;
  }
  return null;
}
function login(email: string, password: string, ip: string): Request {
  return new Request(`${ISSUER}/login`, {
    method: "POST",
    body: new URLSearchParams({ __csrf: CSRF, email, password }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ISSUER,
      "cf-connecting-ip": ip,
      cookie: `parachute_id_csrf=${CSRF}`,
    },
  });
}

/** A DB that runs `during` once, just before the first statement whose SQL contains `trigger`. */
function raceDb(trigger: string, during: () => Promise<void>): D1Database {
  let fired = false;
  return new Proxy(env.DB, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.includes(trigger)) return stmt;
          const once = async () => {
            if (fired) return;
            fired = true;
            await during();
          };
          return {
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return {
                run: async () => (await once(), bound.run()),
                first: async (col?: string) => (await once(), col ? bound.first(col) : bound.first()),
                all: async () => (await once(), bound.all()),
              };
            },
          };
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** A LEGACY (pre-sha512) verifier, the way users.ts used to write them. */
async function legacySha256Verifier(password: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 100_000, hash: "SHA-256" },
    km,
    256,
  );
  const b64u = (b: Uint8Array) =>
    btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `pbkdf2$sha256$100000$${b64u(salt)}$${b64u(new Uint8Array(bits))}`;
}

test("two overlapping correct sign-ins of a legacy-hash account both get a session", async () => {
  const email = "dr2-rehash-double@example.com";
  const { id } = await seedUser(email, "right password 1");
  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .bind(await legacySha256Verifier("right password 1"), id)
    .run();

  // Sign-in A has matched the legacy verifier; sign-in B runs whole before A's upgrade write.
  let b: Response | null = null;
  const db = raceDb("UPDATE users SET password_hash", async () => {
    b = await app.fetch(login(email, "right password 1", "10.96.0.2"), env);
  });
  const a = await app.fetch(login(email, "right password 1", "10.96.0.1"), { ...env, DB: db });
  expect(b).not.toBeNull();
  expect(
    { a: [a.headers.get("location"), sessionCookie(a) !== null], b: [b!.headers.get("location"), sessionCookie(b!) !== null] },
    "a correct password was refused because another sign-in upgraded the hash first",
  ).toEqual({ a: ["/console", true], b: ["/console", true] });
}, 30_000);
