import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { SignJWT, importJWK } from "jose";
import { TEST_PRIVATE_JWK, TEST_KID } from "./test-keys.ts";

/**
 * Wire-contract conformance for the Vault DO + edge router. Targets the
 * response-shape facts the notes PWA + REST clients depend on (ground truth:
 * parachute-vault/src/routes.ts + docs/HTTP_API.md) — camelCase/snake_case,
 * error_type discriminators, 409/428 OC bodies, 413 caps, X-Next-Cursor, CORS —
 * plus the auth matrix, R2 round-trip, and storage caps. Drives the worker
 * (router → DO) via SELF.fetch, so it exercises the real routing + auth path.
 */

const ISSUER = "https://id.test.example";
const OP = "test-operator-token";

/** A unique vault name per test → a fresh DO (idFromName), no cross-test state. */
let seq = 0;
function freshVault(prefix = "v"): string {
  return `${prefix}${Date.now().toString(36)}${seq++}`;
}

function base(vault: string): string {
  return `https://vault.test/vault/${vault}`;
}

async function mintToken(opts: {
  vault: string;
  scopes: string;
  sub?: string;
  aud?: string;
  iss?: string;
  jti?: string;
  vaultScope?: string[];
  expiresIn?: string;
  kid?: string;
}): Promise<string> {
  const key = await importJWK(TEST_PRIVATE_JWK as any, "RS256");
  const jwt = new SignJWT({
    scope: opts.scopes,
    ...(opts.vaultScope ? { vault_scope: opts.vaultScope } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? TEST_KID })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? `vault.${opts.vault}`)
    .setSubject(opts.sub ?? "user-1")
    .setJti(opts.jti ?? `jti-${Math.random().toString(36).slice(2)}`)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "15m");
  return jwt.sign(key);
}

/** Operator-token request helper (shape/R2/caps tests). */
function op(vault: string, path: string, init: any = {}): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${OP}`, ...(init.headers ?? {}) };
  return SELF.fetch(`${base(vault)}${path}`, { ...init, headers });
}

async function createNote(vault: string, body: Record<string, unknown>): Promise<any> {
  const res = await op(vault, "/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return res.json() as any;
}

describe("conventions + note shapes", () => {
  it("POST /api/notes → 201, camelCase createdAt, no envelope", async () => {
    const v = freshVault();
    const res = await op(v, "/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello #greeting", tags: ["greeting"] }),
    });
    expect(res.status).toBe(201);
    const note = await res.json() as any;
    expect(note.id).toBeTruthy();
    expect(note.content).toBe("hello #greeting");
    expect(typeof note.createdAt).toBe("string"); // camelCase, not created_at
    expect(note).not.toHaveProperty("created_at");
    expect(note).not.toHaveProperty("data"); // no envelope
    expect(note.tags).toContain("greeting");
  });

  it("GET /api/notes defaults to lean NoteIndex (byteSize + preview, no content)", async () => {
    const v = freshVault();
    await createNote(v, { content: "a body here", tags: ["x"] });
    const res = await op(v, "/api/notes?tag=x");
    expect(res.status).toBe(200);
    const list = await res.json() as any;
    expect(Array.isArray(list)).toBe(true);
    expect(list[0]).toHaveProperty("byteSize");
    expect(list[0]).toHaveProperty("preview");
    expect(list[0]).not.toHaveProperty("content");
  });

  it("GET /api/notes?include_content=true returns full Note", async () => {
    const v = freshVault();
    await createNote(v, { content: "full body", tags: ["x"] });
    const res = await op(v, "/api/notes?tag=x&include_content=true");
    const list = await res.json() as any;
    expect(list[0].content).toBe("full body");
  });

  it("GET /api/notes/{id} point read defaults to full content", async () => {
    const v = freshVault();
    const n = await createNote(v, { content: "point body" });
    const res = await op(v, `/api/notes/${n.id}`);
    expect(res.status).toBe(200);
    const note = await res.json() as any;
    expect(note.content).toBe("point body");
  });
});

describe("cursor pagination", () => {
  it("?cursor= → {notes, next_cursor} body + X-Next-Cursor header", async () => {
    const v = freshVault();
    await createNote(v, { content: "n1" });
    const res = await op(v, "/api/notes?cursor=");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toHaveProperty("notes");
    expect(body).toHaveProperty("next_cursor");
    expect(typeof body.next_cursor).toBe("string");
    expect(res.headers.get("X-Next-Cursor")).toBe(body.next_cursor);
  });

  it("cursor + search → 400 INVALID_QUERY", async () => {
    const v = freshVault();
    const res = await op(v, "/api/notes?search=foo&cursor=abc");
    expect(res.status).toBe(400);
    const err = await res.json() as any;
    expect(err.code).toBe("INVALID_QUERY");
  });
});

describe("optimistic concurrency + error discriminators", () => {
  it("PATCH without if_updated_at/force → 428 precondition_required", async () => {
    const v = freshVault();
    const n = await createNote(v, { content: "v1" });
    const res = await op(v, `/api/notes/${n.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "v2" }),
    });
    expect(res.status).toBe(428);
    const err = await res.json() as any;
    expect(err.error_type).toBe("precondition_required");
    expect(err.note_id).toBe(n.id);
  });

  it("PATCH with stale if_updated_at → 409 conflict body", async () => {
    const v = freshVault();
    const n = await createNote(v, { content: "v1" });
    const res = await op(v, `/api/notes/${n.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "v2", if_updated_at: "2000-01-01T00:00:00.000Z" }),
    });
    expect(res.status).toBe(409);
    const err = await res.json() as any;
    expect(err.error_type).toBe("conflict");
    expect(err).toHaveProperty("current_updated_at");
    expect(err).toHaveProperty("your_updated_at");
  });

  it("PATCH with correct if_updated_at → 200, created:false", async () => {
    const v = freshVault();
    const n = await createNote(v, { content: "v1" });
    const res = await op(v, `/api/notes/${n.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "v2", if_updated_at: n.updatedAt ?? n.createdAt }),
    });
    expect(res.status).toBe(200);
    const note = await res.json() as any;
    expect(note.content).toBe("v2");
    expect(note.created).toBe(false);
  });

  it("PATCH if_missing:create on absent note → 200 created:true", async () => {
    const v = freshVault();
    const res = await op(v, "/api/notes/brand-new", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "made", if_missing: "create", force: true }),
    });
    expect(res.status).toBe(200);
    const note = await res.json() as any;
    expect(note.created).toBe(true);
  });
});

describe("batch cap", () => {
  it("POST {notes:[501]} → 413 batch_too_large", async () => {
    const v = freshVault();
    const notes = Array.from({ length: 501 }, (_, i) => ({ content: `n${i}` }));
    const res = await op(v, "/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    expect(res.status).toBe(413);
    const err = await res.json() as any;
    expect(err.error_type).toBe("batch_too_large");
    expect(err.limit).toBe(500);
  });

  it("POST {notes:[2]} batch → 201 array of Note", async () => {
    const v = freshVault();
    const res = await op(v, "/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: [{ content: "a" }, { content: "b" }] }),
    });
    expect(res.status).toBe(201);
    const arr = await res.json() as any;
    expect(arr).toHaveLength(2);
  });

  // Atomicity is a COUNTED NO-OP until vault#521's store.transaction lands (the
  // shim intercepts BEGIN/COMMIT). This pins the gap; flip to a real assertion
  // in the follow-up integration commit.
  it.todo("POST batch is atomic — mid-batch failure rolls back prior inserts (blocked on vault#521)");
});

describe("tags", () => {
  it("PUT then GET /api/tags/{name} round-trips the identity row", async () => {
    const v = freshVault();
    const put = await op(v, "/api/tags/project", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "a project tag" }),
    });
    expect(put.status).toBe(200);
    const get = await op(v, "/api/tags/project");
    const tag = await get.json() as any;
    expect(tag.name).toBe("project");
    expect(tag.description).toBe("a project tag");
  });

  it("GET /api/tags → [{name,count}]", async () => {
    const v = freshVault();
    await createNote(v, { content: "x", tags: ["alpha"] });
    const res = await op(v, "/api/tags");
    const tags = await res.json() as any;
    expect(tags.some((t: any) => t.name === "alpha" && typeof t.count === "number")).toBe(true);
  });

  it("POST /api/tags/{name}/rename → { renamed }", async () => {
    const v = freshVault();
    await createNote(v, { content: "x", tags: ["oldtag"] });
    const res = await op(v, "/api/tags/oldtag/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: "newtag" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toHaveProperty("renamed");
  });

  it("POST /api/tags/merge → { merged, target }", async () => {
    const v = freshVault();
    await createNote(v, { content: "x", tags: ["s1"] });
    await createNote(v, { content: "y", tags: ["s2"] });
    const res = await op(v, "/api/tags/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: ["s1", "s2"], target: "combined" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.target).toBe("combined");
    expect(body).toHaveProperty("merged");
  });
});

describe("vault landing + config", () => {
  it("GET /vault/{name} → name, description, createdAt, stats", async () => {
    const v = freshVault();
    await createNote(v, { content: "x" });
    const res = await op(v, "");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.name).toBe(v);
    expect(body).toHaveProperty("createdAt");
    expect(body.stats).toHaveProperty("totalNotes");
  });

  it("PATCH /api/vault persists description + audio_retention validation", async () => {
    const v = freshVault();
    await op(v, "/api/vault", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "my vault", config: { audio_retention: "keep" } }),
    });
    const get = await (await op(v, "/api/vault")).json() as any;
    expect(get.description).toBe("my vault");
    expect(get.config.audio_retention).toBe("keep");

    const bad = await op(v, "/api/vault", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { audio_retention: "bogus" } }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json() as any).error).toBe("invalid_audio_retention");
  });
});

describe("CORS", () => {
  it("OPTIONS → 204 with wildcard ACAO", async () => {
    const res = await SELF.fetch(`${base("any")}/api/notes`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("API responses carry ACAO *", async () => {
    const v = freshVault();
    const res = await op(v, "/api/health");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await res.json() as any).status).toBe("ok");
  });
});

describe("auth matrix", () => {
  it("no token → 401", async () => {
    const v = freshVault();
    const res = await SELF.fetch(`${base(v)}/api/notes`);
    expect(res.status).toBe(401);
  });

  it("valid write JWT → 201", async () => {
    const v = freshVault();
    const token = await mintToken({ vault: v, scopes: `vault:${v}:write vault:${v}:read` });
    const res = await SELF.fetch(`${base(v)}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: "via jwt" }),
    });
    expect(res.status).toBe(201);
  });

  it("wrong audience → 401", async () => {
    const v = freshVault();
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read`, aud: "vault.someone-else" });
    const res = await SELF.fetch(`${base(v)}/api/notes`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it("read-scope token doing a write → 403 insufficient_scope", async () => {
    const v = freshVault();
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const res = await SELF.fetch(`${base(v)}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: "nope" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error_type).toBe("insufficient_scope");
  });

  it("read-scope token reading → 200", async () => {
    const v = freshVault();
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const res = await SELF.fetch(`${base(v)}/api/notes`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it("broad vault:read scope on a hub-style JWT → 401", async () => {
    const v = freshVault();
    const token = await mintToken({ vault: v, scopes: "vault:read vault:write" });
    const res = await SELF.fetch(`${base(v)}/api/notes`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it("vault_scope pin mismatch → 403 vault_scope_mismatch", async () => {
    const v = freshVault();
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read`, vaultScope: ["someone-else"] });
    const res = await SELF.fetch(`${base(v)}/api/notes`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error_type).toBe("vault_scope_mismatch");
  });
});

describe("storage — R2 round-trip + caps", () => {
  it("upload → serve round-trips the bytes with nosniff", async () => {
    const v = freshVault();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const form = new FormData();
    form.set("file", new File([bytes], "clip.png", { type: "image/png" }));
    const up = await op(v, "/api/storage/upload", { method: "POST", body: form });
    expect(up.status).toBe(201);
    const meta = await up.json() as any;
    expect(meta.mimeType).toBe("image/png");
    expect(meta.size).toBe(8);

    const get = await op(v, `/api/storage/${meta.path}`);
    expect(get.status).toBe(200);
    expect(get.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const served = new Uint8Array(await get.arrayBuffer());
    expect([...served]).toEqual([...bytes]);
  });

  it("disallowed active-content extension (.svg) → 400", async () => {
    const v = freshVault();
    const form = new FormData();
    form.set("file", new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }));
    const res = await op(v, "/api/storage/upload", { method: "POST", body: form });
    expect(res.status).toBe(400);
  });

  it("upload over cap → 413 storage_cap_exceeded", async () => {
    const v = freshVault();
    // CAP_BYTES=2_000_000 in the test env; a 3MB file blows the cap regardless
    // of the (small) baseline DB size.
    const big = new Uint8Array(3 * 1024 * 1024);
    const form = new FormData();
    form.set("file", new File([big], "big.pdf", { type: "application/pdf" }));
    const res = await op(v, "/api/storage/upload", { method: "POST", body: form });
    expect(res.status).toBe(413);
    expect((await res.json() as any).error_type).toBe("storage_cap_exceeded");
  });
});

describe("routing", () => {
  it("subdomain host routes to the same DO as the path form", async () => {
    const v = freshVault("sub");
    await createNote(v, { content: "on subdomain vault" });
    // Bare path on the tenant subdomain resolves the vault from the hostname.
    const res = await SELF.fetch(`https://${v}.u.parachute.computer/api/notes?include_content=true`, {
      headers: { Authorization: `Bearer ${OP}` },
    });
    expect(res.status).toBe(200);
    const list = await res.json() as any;
    expect(list.some((n: any) => n.content === "on subdomain vault")).toBe(true);
  });

  it("GET /health (server-level) → {status:ok}", async () => {
    const res = await SELF.fetch("https://vault.test/health");
    expect(res.status).toBe(200);
    expect((await res.json() as any).status).toBe("ok");
  });

  it("GET /auth/status → cloud auth-discovery shape", async () => {
    const res = await SELF.fetch("https://vault.test/auth/status");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toHaveProperty("hasOwnerPassword");
    expect(body.authServer).toBe(ISSUER);
  });
});
