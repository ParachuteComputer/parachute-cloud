import { SELF, env } from "cloudflare:test";
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

  // The ASYNC batch (transactionAsync) still can't map to the sync-only
  // ctx.storage.transactionSync, so mid-batch rollback remains pending a core
  // port of the async seam (core defers it too). The SYNC seam IS wired — see
  // the "transaction seam" block below.
  it.todo("POST batch is atomic — async transactionAsync → transactionSync port pending (core follow-up)");
});

describe("transaction seam (vault#521 / DoSqliteStore)", () => {
  it("Store.transaction rolls back on a mid-block throw (real transactionSync, not a no-op)", async () => {
    const v = freshVault();
    // Declare an indexed integer field `priority` on `meeting` → creates the
    // meta_priority generated column (INTEGER) + index.
    const a = await op(v, "/api/tags/meeting", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { priority: { type: "integer", indexed: true } } }),
    });
    expect(a.status).toBe(200);

    // Now declare the SAME field as a string on `standup`. upsertTagRecord
    // writes standup's schema row, THEN declareField throws (cross-tag type
    // mismatch: priority is already INTEGER). Under a real transaction the whole
    // write rolls back; under the old no-op interception the schema row would
    // have persisted.
    const b = await op(v, "/api/tags/standup", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { priority: { type: "string", indexed: true } } }),
    });
    expect(b.status).toBe(400);
    expect((await b.json() as any).error_type).toBe("invalid_indexed_field");

    // Rollback proof: standup's schema row must NOT have been persisted.
    // Post-cloud#113/#157 a name with no identity row and no notes answers
    // with a structured 404 rather than an all-null 200 — a STRONGER rollback
    // proof than `fields === null` was (that shape could not distinguish
    // "declared with no fields" from "never declared").
    const check = await op(v, "/api/tags/standup");
    expect(check.status).toBe(404);
    expect(((await check.json()) as any).error_type).toBe("tag_not_found");
  });

  it("GLOBAL 0 raw-BEGIN interceptions — boot + every free-transaction() op is DO-atomic (vault#523)", async () => {
    const v = freshVault();
    const stub = env.VAULT.get(env.VAULT.idFromName(v));
    // Post-vault#523 the shim exposes transactionSync, which core's free
    // transaction() duck-type-prefers — so the boot migrations run as REAL DO
    // transactions, not the no-op BEGIN interception. A freshly-booted DO reads 0.
    expect(await stub.debugTxnInterceptCount()).toBe(0);

    // Exercise every free-transaction() site through the wire (single-note ops
    // only — the async BATCH path is the deferred residual, tested below):
    // create → update → rename tag → merge tags → Store.transaction indexed
    // field → delete.
    const post = (body: unknown) =>
      op(v, "/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const na = (await (await post({ content: "a", tags: ["t1"] })).json()) as any;
    await op(v, `/api/notes/${na.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "a2", if_updated_at: na.updatedAt ?? na.createdAt }),
    });
    await op(v, "/api/tags/t1/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: "t2" }),
    });
    await post({ content: "s", tags: ["s1"] });
    await post({ content: "s", tags: ["s2"] });
    await op(v, "/api/tags/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: ["s1", "s2"], target: "comb" }),
    });
    await op(v, "/api/tags/proj", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { rank: { type: "integer", indexed: true } } }),
    });
    await op(v, `/api/notes/${na.id}`, { method: "DELETE" });

    // No raw BEGIN reached the shim across boot + all of the above. A nonzero
    // count = a free-transaction() site regressed off the transactionSync path.
    expect(await stub.debugTxnInterceptCount()).toBe(0);
  });

  it("the async batch path is the SOLE residual — transactionAsync still BEGINs (deferred core port)", async () => {
    const v = freshVault();
    const stub = env.VAULT.get(env.VAULT.idFromName(v));
    expect(await stub.debugTxnInterceptCount()).toBe(0); // boot is clean now

    // A multi-note POST wraps N creates in transactionAsync — the one path the
    // sync-only transactionSync can't absorb (its body awaits the Store facade
    // between writes). BEGIN IMMEDIATE + COMMIT are both intercepted → exactly 2.
    const res = await op(v, "/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: [{ content: "a" }, { content: "b" }] }),
    });
    expect(res.status).toBe(201);
    expect(await stub.debugTxnInterceptCount()).toBe(2);
  });
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

  // C1.2 — bun's handleVault ALWAYS attaches `map` (the front-door structural
  // orientation: total note count, tags with membership counts, path buckets,
  // unfiled count). Cloud has no tag-scoped tokens, so the unscoped
  // getVaultMap() call is always the right one to mirror. Deltas (not
  // absolute counts) since a fresh vault materializes cloud's welcome/
  // getting-started seed pack — see console note-seeding.
  it("GET /api/vault carries `map` — {total_notes, tags, path_buckets, unfiled_notes}", async () => {
    const v = freshVault();
    const before = (await (await op(v, "/api/vault")).json()) as any;
    expect(before.map).toBeTruthy();
    const baseTotal = before.map.total_notes;
    const baseUnfiled = before.map.unfiled_notes;

    await createNote(v, { content: "in a folder", path: "folder/note", tags: ["mapped"] });
    await createNote(v, { content: "unfiled" });

    const apiVault = (await (await op(v, "/api/vault")).json()) as any;
    expect(apiVault.map.total_notes).toBe(baseTotal + 2);
    expect(apiVault.map.tags.some((t: any) => t.name === "mapped" && t.count === 1)).toBe(true);
    expect(apiVault.map.path_buckets.some((b: any) => b.name === "folder" && b.count === 1)).toBe(true);
    expect(apiVault.map.unfiled_notes).toBe(baseUnfiled + 1);
  });

  // Cross-door capability parity — self-host declares `transcription` on BOTH
  // the landing and /api/vault (routes.ts handleVault); cloud must match so
  // notes-ui's /api/vault probe works without its landing-fallback workaround.
  it("GET /api/vault carries the transcription capability, shape-equal to the landing's (voice off)", async () => {
    const v = freshVault();
    const apiVault = (await (await op(v, "/api/vault")).json()) as any;
    const landing = (await (await op(v, "")).json()) as any;
    expect(apiVault.transcription).toEqual({ enabled: false, minutes_remaining: 0 });
    expect(apiVault.transcription).toEqual(landing.transcription);
  });

  it("GET /api/vault mirrors the landing's transcription after a voice-entitlement push (voice on)", async () => {
    const v = freshVault();
    // Operator bearer passes the internal-config gate (the control-plane seam).
    const push = await op(v, "/api/internal/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcription: { enabled: true, minutes_limit: 600 } }),
    });
    expect(push.status).toBe(200);

    const apiVault = (await (await op(v, "/api/vault")).json()) as any;
    const landing = (await (await op(v, "")).json()) as any;
    expect(apiVault.transcription).toEqual({ enabled: true, minutes_remaining: 600 });
    expect(apiVault.transcription).toEqual(landing.transcription);
  });

  // Cross-door capability parity for semantic search (C2, EXPERIMENTAL) —
  // self-host declares `embeddings` on BOTH the landing and /api/vault
  // (routes.ts handleVault via capability.ts's resolveEmbeddingCapability);
  // cloud mirrors the same shape + placement. No provider is injected in
  // this suite's default test env (see vault-do.ts's `resolveEmbeddingProvider`
  // doc — it deliberately avoids a live, uncredentialed Workers AI call),
  // so `enabled: false` here is the honest "not available" reading, byte-
  // shaped identically to self-host's off/not-configured posture.
  it("GET /api/vault carries the embeddings capability, shape-equal to the landing's", async () => {
    const v = freshVault();
    const apiVault = (await (await op(v, "/api/vault")).json()) as any;
    const landing = (await (await op(v, "")).json()) as any;
    expect(apiVault.embeddings).toEqual({ enabled: false });
    expect(apiVault.embeddings).toEqual(landing.embeddings);
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

/**
 * The write/admin scope split (cloud#134 A.1) — the tag-schema/taxonomy
 * mutation carve-out, mirroring bun routing.ts's `isTagSchemaMutation` (the
 * vault 0.7.1 re-tier). Before this, cloud's REST gate collapsed write and
 * admin into `permission: "full"`, so a `vault:<name>:write` token could
 * rename/merge/delete/update tag schemas. The four admin-only REST operations
 * are pinned INDIVIDUALLY (a write token is refused on each, and the mutation
 * must not land), and the write tier is pinned to keep every genuine write —
 * the split must never break a limited write token's legitimate work.
 */
describe("write/admin scope split — tag-schema mutations require vault:admin", () => {
  const WRITE = (v: string) => mintToken({ vault: v, scopes: `vault:${v}:write vault:${v}:read` });
  // Admin-only mint (no explicit write/read) — the scope ladder (admin ⊇ write
  // ⊇ read) must carry the lower tiers, pinning "a higher-tier credential
  // still works" alongside "a lower-tier credential never escalates".
  const ADMIN = (v: string) => mintToken({ vault: v, scopes: `vault:${v}:admin` });

  function asToken(token: string, method: string, body?: unknown): RequestInit {
    return {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
  }

  async function expectAdminRefused(res: Response, grantedContains: string) {
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error_type).toBe("insufficient_scope");
    expect(body.required_scope).toBe("vault:admin");
    expect(body.granted_scopes).toContain(grantedContains);
  }

  it("write token: PUT /api/tags/:name → 403 vault:admin, schema NOT persisted", async () => {
    const v = freshVault();
    const token = await WRITE(v);
    const res = await SELF.fetch(
      `${base(v)}/api/tags/project`,
      asToken(token, "PUT", { description: "by write token", fields: { status: { type: "string" } } }),
    );
    await expectAdminRefused(res, `vault:${v}:write`);
    // The refusal happened at the gate — nothing landed. Post-cloud#113/#157
    // "nothing landed" reads as a structured 404 (no identity row, no notes)
    // instead of an all-null 200.
    const tag = await op(v, "/api/tags/project");
    expect(tag.status).toBe(404);
    expect(((await tag.json()) as any).error_type).toBe("tag_not_found");
  });

  it("write token: DELETE /api/tags/:name → 403 vault:admin, tag survives", async () => {
    const v = freshVault();
    await createNote(v, { content: "x", tags: ["keepme"] });
    const res = await SELF.fetch(`${base(v)}/api/tags/keepme`, asToken(await WRITE(v), "DELETE"));
    await expectAdminRefused(res, `vault:${v}:write`);
    const tags = await (await op(v, "/api/tags")).json() as any[];
    expect(tags.some((t) => t.name === "keepme")).toBe(true);
  });

  it("write token: POST /api/tags/merge → 403 vault:admin, sources survive", async () => {
    const v = freshVault();
    await createNote(v, { content: "x", tags: ["m1"] });
    await createNote(v, { content: "y", tags: ["m2"] });
    const res = await SELF.fetch(
      `${base(v)}/api/tags/merge`,
      asToken(await WRITE(v), "POST", { sources: ["m1", "m2"], target: "merged" }),
    );
    await expectAdminRefused(res, `vault:${v}:write`);
    const tags = await (await op(v, "/api/tags")).json() as any[];
    expect(tags.some((t) => t.name === "m1")).toBe(true);
    expect(tags.some((t) => t.name === "merged")).toBe(false);
  });

  it("write token: POST /api/tags/:name/rename → 403 vault:admin, name unchanged", async () => {
    const v = freshVault();
    await createNote(v, { content: "x", tags: ["oldname"] });
    const res = await SELF.fetch(
      `${base(v)}/api/tags/oldname/rename`,
      asToken(await WRITE(v), "POST", { new_name: "newname" }),
    );
    await expectAdminRefused(res, `vault:${v}:write`);
    const tags = await (await op(v, "/api/tags")).json() as any[];
    expect(tags.some((t) => t.name === "oldname")).toBe(true);
    expect(tags.some((t) => t.name === "newname")).toBe(false);
  });

  it("admin token: all four tag-schema mutations succeed (admin ⊇ write ⊇ read)", async () => {
    const v = freshVault();
    await createNote(v, { content: "x", tags: ["t1"] });
    await createNote(v, { content: "y", tags: ["t2"] });
    await createNote(v, { content: "z", tags: ["victim"] });
    const admin = await ADMIN(v);

    const put = await SELF.fetch(
      `${base(v)}/api/tags/t1`,
      asToken(admin, "PUT", { description: "curated", fields: { status: { type: "string" } } }),
    );
    expect(put.status).toBe(200);

    const rename = await SELF.fetch(
      `${base(v)}/api/tags/t1/rename`,
      asToken(admin, "POST", { new_name: "t1r" }),
    );
    expect(rename.status).toBe(200);

    const merge = await SELF.fetch(
      `${base(v)}/api/tags/merge`,
      asToken(admin, "POST", { sources: ["t1r"], target: "t2" }),
    );
    expect(merge.status).toBe(200);

    const del = await SELF.fetch(`${base(v)}/api/tags/victim`, asToken(admin, "DELETE"));
    expect(del.status).toBe(200);
  });

  it("write token keeps every genuine write-tier operation (no breaking change)", async () => {
    const v = freshVault();
    const token = await WRITE(v);

    // Note create / update / delete — the write tier's actual job.
    const created = await SELF.fetch(
      `${base(v)}/api/notes`,
      asToken(token, "POST", { content: "write tier lives #wt" }),
    );
    expect(created.status).toBe(201);
    const note = await created.json() as any;
    const patched = await SELF.fetch(
      `${base(v)}/api/notes/${note.id}`,
      asToken(token, "PATCH", { content: "edited", if_updated_at: note.updatedAt ?? note.createdAt }),
    );
    expect(patched.status).toBe(200);

    // Tag READS stay read-tier — the carve-out matches mutations only. The
    // tag has to actually exist for a 200 to mean anything: before
    // cloud#113/#157 an unknown name 200'd too, so this assertion passed
    // whether or not `wt` was ever created.
    await createNote(v, { content: "carries the tag", tags: ["wt"] });
    const list = await SELF.fetch(`${base(v)}/api/tags`, asToken(token, "GET"));
    expect(list.status).toBe(200);
    const detail = await SELF.fetch(`${base(v)}/api/tags/wt`, asToken(token, "GET"));
    expect(detail.status).toBe(200);

    // POST /tags/:name/conformance (2 path segments) is deliberately NOT in
    // the admin enumeration — a schema-tightening preview stays available to
    // a write token (bun even allows it at read tier).
    const conf = await SELF.fetch(
      `${base(v)}/api/tags/wt/conformance`,
      asToken(token, "POST", { fields: { status: { type: "string" } } }),
    );
    expect(conf.status).toBe(200);

    const del = await SELF.fetch(`${base(v)}/api/notes/${note.id}`, asToken(token, "DELETE"));
    expect(del.status).toBe(200);
  });

  /**
   * POST /api/packs/:name — a write-tier SIDE DOOR onto the same tag-schema
   * mutation `PUT /api/tags/:name` is admin-gated for (cloud#134 A.1
   * adversarial-review finding, closed by `isPackApply` in auth.ts).
   * `handleApplyPack` (vault-do.ts) reaches core's `applySeedPack`, which
   * calls the SAME `upsertTagRecord(name, {fields, parent_names,
   * description})` for every tag a pack declares — and `upsertTagRecord`
   * REPLACES `fields` wholesale when a pack passes any (tag-schemas.ts:
   * `fields = patch.fields === undefined ? existing : patch.fields` — no
   * per-key merge). Core's own `starter-ontology` pack declares a `view` meta
   * tag with a real schema, so re-POSTing it is a live path to clobber an
   * owner's curated `view` fields. Before the fix, POST /packs dispatched at
   * plain `write` (verbForMethod's default), so a `vault:<name>:write` token
   * could reach this; the fix requires the SAME `vault:admin` the front door
   * (`PUT /api/tags/:name`) already requires.
   */
  it("write token: POST /api/packs/:name → 403 vault:admin, curated tag schema NOT overwritten", async () => {
    const v = freshVault();
    // The owner curates `view`'s schema themselves (admin-equivalent operator
    // token) BEFORE a write-tier token ever touches the vault.
    const curate = await op(v, "/api/tags/view", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "owner's own curated view tag — not the pack's",
        fields: { custom_field: { type: "string" } },
      }),
    });
    expect(curate.status).toBe(200);

    // `starter-ontology` declares `view` WITH fields (kind/query/lane_by/
    // date_field) — the exact shape that would land if this door were still
    // write-gated.
    const res = await SELF.fetch(`${base(v)}/api/packs/starter-ontology`, asToken(await WRITE(v), "POST"));
    await expectAdminRefused(res, `vault:${v}:write`);

    // Read back with the operator (admin-equivalent) token — proves nothing
    // landed: the owner's curated `fields` survive byte-for-byte, and the
    // pack's own tags/notes never got created.
    const tag = (await (await op(v, "/api/tags/view")).json()) as any;
    expect(tag.fields).toEqual({ custom_field: { type: "string" } });
    expect(tag.description).toBe("owner's own curated view tag — not the pack's");
    const notes = (await (await op(v, "/api/notes?include_content=true")).json()) as any[];
    expect(notes.some((n) => n.path === "Views/All notes")).toBe(false);
  });

  it("admin token: POST /api/packs/:name applies the pack (admin ⊇ write, no breaking change for the console's own mint)", async () => {
    const v = freshVault();
    const res = await SELF.fetch(`${base(v)}/api/packs/surface-starter`, asToken(await ADMIN(v), "POST"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.pack).toBe("surface-starter");
    expect(body.applied.length).toBeGreaterThan(0);
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

  it("orphan attachment delete frees the storage meter (cap 413 clears)", async () => {
    const v = freshVault();
    // Upload a ~1.5MB object, attach it to a note, then delete the attachment.
    // The orphan-delete must decrement the meter — otherwise a second ~1.5MB
    // upload would push the (phantom) total over the 2MB cap.
    const oneAndHalf = new Uint8Array(Math.floor(1.5 * 1024 * 1024));
    const form1 = new FormData();
    form1.set("file", new File([oneAndHalf], "a.pdf", { type: "application/pdf" }));
    const up1 = (await (await op(v, "/api/storage/upload", { method: "POST", body: form1 })).json()) as any;

    const note = await createNote(v, { content: "carries an attachment" });
    const attRes = await op(v, `/api/notes/${note.id}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: up1.path, mimeType: "application/pdf" }),
    });
    expect(attRes.status).toBe(201);
    const att = (await attRes.json()) as any;

    const del = await op(v, `/api/notes/${note.id}/attachments/${att.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);

    // Meter should be back near baseline → a second 1.5MB upload succeeds.
    const form2 = new FormData();
    form2.set("file", new File([oneAndHalf], "b.pdf", { type: "application/pdf" }));
    const up2 = await op(v, "/api/storage/upload", { method: "POST", body: form2 });
    expect(up2.status).toBe(201);
  });
});

describe("delete paths", () => {
  it("DELETE /api/notes/{id} → { deleted:true, id }", async () => {
    const v = freshVault();
    const n = await createNote(v, { content: "to delete" });
    const res = await op(v, `/api/notes/${n.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({ deleted: true, id: n.id });
    const check = await op(v, `/api/notes/${n.id}`);
    expect(check.status).toBe(404);
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

/**
 * Cross-door parity pins (contracts-brief C1.4) — verifies the vault-core
 * `file:` dep bump (V1, parachute-vault#599) reaches cloud through BOTH REST
 * (forked runtime code, mirrored by hand in rest/*.ts) AND MCP (core-driven —
 * `generateMcpTools(store)`, so these fixes are inherited automatically with
 * zero cloud src changes; the MCP cases here pin that inheritance actually
 * held). Ground truth: parachute-vault/core/src/notes.ts (rowToNote),
 * core/src/query-warnings.ts, core/src/mcp.ts query-notes.
 */
describe("contracts-brief C1.4 — cross-door parity pins", () => {
  const BOTH_ACCEPT = "application/json, text/event-stream";

  /** tools/call query-notes → the parsed tool output (JSON.parse of the sole
   *  text content block), matching mcp.test.ts's mcpPost convention. */
  async function queryNotesViaMcp(vault: string, args: Record<string, unknown>): Promise<any> {
    const res = await SELF.fetch(`${base(vault)}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OP}`, Accept: BOTH_ACCEPT, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "query-notes", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBeFalsy();
    return JSON.parse(body.result.content[0].text);
  }

  describe("metadata always-present (V1.1, core-level)", () => {
    it("GET /api/notes/{id} (default path) → metadata: {} on a metadata-less note", async () => {
      const v = freshVault();
      const n = await createNote(v, { content: "no metadata" });
      const note = (await (await op(v, `/api/notes/${n.id}`)).json()) as any;
      expect(note.metadata).toEqual({});
    });

    it("GET /api/notes list (default path) → metadata: {} present on metadata-less notes", async () => {
      const v = freshVault();
      await createNote(v, { content: "no metadata", tags: ["nometa"] });
      const list = (await (await op(v, "/api/notes?tag=nometa&include_content=true")).json()) as any[];
      expect(list[0].metadata).toEqual({});
    });

    it("GET /api/notes?search= (default path) → metadata: {} present on metadata-less notes", async () => {
      const v = freshVault();
      await createNote(v, { content: "searchable xylophone body" });
      const list = (await (await op(v, "/api/notes?search=xylophone&include_content=true")).json()) as any[];
      expect(list.length).toBeGreaterThan(0);
      expect(list[0].metadata).toEqual({});
    });

    it("MCP query-notes (single by id) → metadata: {} on a metadata-less note", async () => {
      const v = freshVault();
      const n = await createNote(v, { content: "no metadata via mcp" });
      const note = await queryNotesViaMcp(v, { id: n.id });
      expect(note.metadata).toEqual({});
    });

    it("MCP query-notes (list) → metadata: {} present on metadata-less notes", async () => {
      const v = freshVault();
      await createNote(v, { content: "no metadata via mcp list", tags: ["mcpnometa"] });
      const out = await queryNotesViaMcp(v, { tag: "mcpnometa", include_content: true });
      const list = Array.isArray(out) ? out : out.notes;
      expect(list[0].metadata).toEqual({});
    });
  });

  describe("slashed note-id path — %2F whole-encode is the contract", () => {
    it("%2F-encoded path resolves; the raw-slash form 404s", async () => {
      const v = freshVault();
      const n = await createNote(v, { content: "nested", path: "folder/nested-note" });
      const encoded = await op(v, `/api/notes/${encodeURIComponent("folder/nested-note")}`);
      expect(encoded.status).toBe(200);
      expect((await encoded.json() as any).id).toBe(n.id);

      const rawSlash = await op(v, "/api/notes/folder/nested-note");
      expect(rawSlash.status).toBe(404);
    });
  });

  describe("search × offset → ignored_param warning (V1.2/C1.3)", () => {
    it("?search=x&offset=5 → 200, results unchanged, X-Parachute-Warnings names `offset`", async () => {
      const v = freshVault();
      await createNote(v, { content: "warnme offsettest" });
      const withOffset = await op(v, "/api/notes?search=offsettest&offset=5");
      const withoutOffset = await op(v, "/api/notes?search=offsettest");
      expect(withOffset.status).toBe(200);
      const a = (await withOffset.json()) as any[];
      const b = (await withoutOffset.json()) as any[];
      expect(a.map((n) => n.id)).toEqual(b.map((n) => n.id));
      const raw = withOffset.headers.get("X-Parachute-Warnings");
      expect(raw).toBeTruthy();
      const warnings = JSON.parse(decodeURIComponent(raw!));
      expect(warnings.some((w: any) => w.code === "ignored_param" && w.param === "offset")).toBe(true);
    });

    it("?search=x&search_mode=advanced&sort=desc → unsupported_param warnings, results unaffected (C1.5)", async () => {
      const v = freshVault();
      await createNote(v, { content: "warnme modetest" });
      const res = await op(v, "/api/notes?search=modetest&search_mode=advanced&sort=desc");
      expect(res.status).toBe(200);
      const raw = res.headers.get("X-Parachute-Warnings");
      expect(raw).toBeTruthy();
      const warnings = JSON.parse(decodeURIComponent(raw!));
      expect(warnings.some((w: any) => w.code === "unsupported_param" && w.param === "search_mode")).toBe(true);
      expect(warnings.some((w: any) => w.code === "unsupported_param" && w.param === "sort")).toBe(true);
    });

    it("structured-query offset is UNAFFECTED (still honored, no warning)", async () => {
      const v = freshVault();
      await createNote(v, { content: "s1", tags: ["structoffset"] });
      await createNote(v, { content: "s2", tags: ["structoffset"] });
      const res = await op(v, "/api/notes?tag=structoffset&offset=1");
      expect(res.status).toBe(200);
      const list = (await res.json()) as any[];
      expect(list).toHaveLength(1);
      expect(res.headers.get("X-Parachute-Warnings")).toBeNull();
    });
  });

  describe("default ordering — created_at ASC, limit 50 (pinned AS-IS; a flip to desc is AARON-GATE)", () => {
    it("bare GET /api/notes returns oldest-first by default", async () => {
      const v = freshVault();
      const a = await createNote(v, { content: "first" });
      const b = await createNote(v, { content: "second" });
      const c = await createNote(v, { content: "third" });
      const list = (await (await op(v, "/api/notes")).json()) as any[];
      const ids = list.map((n) => n.id);
      expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
      expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(c.id));
    });
  });

  describe("transcription capability `enabled` — parity (already pinned above; re-asserted here as a C1.4 checklist item)", () => {
    it("GET /api/vault carries transcription.enabled (boolean) on a fresh vault", async () => {
      const v = freshVault();
      const apiVault = (await (await op(v, "/api/vault")).json()) as any;
      expect(typeof apiVault.transcription.enabled).toBe("boolean");
    });
  });

  describe("MCP truncation-honesty warning (V1.3, core-level — inherited via generateMcpTools)", () => {
    it("query-notes with limit === result count (no cursor) → `truncated` warning in the envelope", async () => {
      const v = freshVault();
      await createNote(v, { content: "t1", tags: ["trunc"] });
      await createNote(v, { content: "t2", tags: ["trunc"] });
      const out = await queryNotesViaMcp(v, { tag: "trunc", limit: 1 });
      expect(Array.isArray(out)).toBe(false);
      expect(out.notes).toHaveLength(1);
      expect(out.warnings?.some((w: any) => w.code === "truncated")).toBe(true);
    });

    it("query-notes under the limit (no cursor) → no truncated warning", async () => {
      const v = freshVault();
      await createNote(v, { content: "u1", tags: ["notrunc"] });
      const out = await queryNotesViaMcp(v, { tag: "notrunc", limit: 50 });
      expect(Array.isArray(out)).toBe(true);
    });
  });
});

/**
 * Parity residue — cloud#112 (cursor bootstrap + live-subscription cursor
 * guard, porting parachute-vault#559), cloud#113/#157 (honest tag-not-found
 * answers: `tag_not_found` + `did_you_mean` + `expanded_count`, porting
 * vault#550), cloud#115 (the `error_type` taxonomy residue in rest/notes.ts,
 * porting vault#554).
 *
 * The invariant these pin is "one contract, two doors": a client must not be
 * able to tell the hosted door from the self-hosted one by the shape of an
 * answer. Ground truth for every case below is
 * parachute-vault/src/routes.ts + core/src/notes.ts at the pinned vault-core
 * ref (scripts/vault-source.env).
 */
describe("parity residue — cloud#112 / #113 / #115 / #157", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function patch(vault: string, id: string, body: Record<string, unknown>): Promise<Response> {
    return op(vault, `/api/notes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  describe("cursor bootstrap engages keyset ordering (cloud#112 / vault#559)", () => {
    /**
     * The bug: `?cursor=` (present, empty) was normalized to
     * `cursor: undefined` before reaching core, and core keys cursor mode on
     * `cursor !== undefined`. So page 1 of a bootstrap walk ran under the
     * DEFAULT `ORDER BY created_at ASC` while still minting a
     * `(updated_at_ms, id)` watermark from whatever that page happened to
     * contain — every note excluded from page 1 whose `updated_at` fell below
     * that watermark was silently skipped for the rest of the walk.
     *
     * The fixture makes created_at order and updated_at order disagree:
     * `created_at` descends as update time ascends, so a buggy page 1 holds
     * the two most-recently-updated notes and the watermark it mints jumps
     * clean past the third. A correct page 1 is keyset-ordered, so the walk
     * sees all three.
     */
    it("?cursor= walk with limit=2 returns EVERY note (no silent skip)", async () => {
      const v = freshVault();
      // `?tag=walk` fences the walk off from the seeded welcome notes a fresh
      // vault ships with — the tag is part of the query hash, so it is stable
      // across every page of the cursor walk.
      const mk = (c: string, at: string) => createNote(v, { content: c, created_at: at, tags: ["walk"] });
      const n1 = await mk("a", "2024-03-01T00:00:00.000Z");
      const n2 = await mk("b", "2024-02-01T00:00:00.000Z");
      const n3 = await mk("c", "2024-01-01T00:00:00.000Z");
      // Touch in created_at-DESCENDING order, spaced so `updated_at_ms` is
      // strictly increasing: updated_at ASC == n1 < n2 < n3, created_at ASC
      // == n3 < n2 < n1.
      for (const n of [n1, n2, n3]) {
        await sleep(4);
        const res = await patch(v, n.id, { metadata: { touched: n.id }, force: true });
        expect(res.status).toBe(200);
      }

      const seen: string[] = [];
      let cursor = "";
      for (let page = 0; page < 6; page++) {
        const res = await op(v, `/api/notes?tag=walk&limit=2&cursor=${encodeURIComponent(cursor)}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(Array.isArray(body.notes)).toBe(true);
        if (body.notes.length === 0) break;
        for (const n of body.notes) seen.push(n.id);
        expect(typeof body.next_cursor).toBe("string");
        cursor = body.next_cursor;
      }
      expect([...new Set(seen)].sort()).toEqual([n1.id, n2.id, n3.id].sort());
    });

    it("bootstrap page 1 is ordered by updated_at, not created_at", async () => {
      const v = freshVault();
      const mk = (c: string, at: string) => createNote(v, { content: c, created_at: at, tags: ["ord"] });
      const n1 = await mk("a", "2024-03-01T00:00:00.000Z");
      const n2 = await mk("b", "2024-01-01T00:00:00.000Z");
      for (const n of [n1, n2]) {
        await sleep(4);
        expect((await patch(v, n.id, { metadata: { t: 1 }, force: true })).status).toBe(200);
      }
      const body = (await (await op(v, "/api/notes?tag=ord&cursor=")).json()) as any;
      // updated_at ASC → n1 first. created_at ASC (the buggy order) → n2 first.
      expect(body.notes.map((n: any) => n.id)).toEqual([n1.id, n2.id]);
    });
  });

  describe("live-subscription cursor guard is presence-based (cloud#112 / vault#559)", () => {
    it("GET /api/subscribe?cursor= → 400 UNSUPPORTED_SUBSCRIPTION_QUERY", async () => {
      const v = freshVault();
      const res = await op(v, "/api/subscribe?cursor=");
      expect(res.status).toBe(400);
      const err = (await res.json()) as any;
      expect(err.code).toBe("UNSUPPORTED_SUBSCRIPTION_QUERY");
      expect(err.error).toMatch(/cursor/i);
    });

    it("GET /api/subscribe?cursor=abc → 400 (non-empty cursor still rejected)", async () => {
      const v = freshVault();
      const res = await op(v, "/api/subscribe?cursor=abc");
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).code).toBe("UNSUPPORTED_SUBSCRIPTION_QUERY");
    });
  });

  describe("honest tag-not-found answers (cloud#113 / #157 / vault#550)", () => {
    it("GET /api/tags?tag={unknown} → 404 tag_not_found + did_you_mean", async () => {
      const v = freshVault();
      await createNote(v, { content: "x", tags: ["project"] });
      const res = await op(v, "/api/tags?tag=projet");
      expect(res.status).toBe(404);
      const err = (await res.json()) as any;
      expect(err.error_type).toBe("tag_not_found");
      expect(err.tag).toBe("projet");
      expect(err.did_you_mean).toBe("project");
    });

    it("GET /api/tags/{unknown} → 404 tag_not_found + did_you_mean", async () => {
      const v = freshVault();
      await createNote(v, { content: "x", tags: ["project"] });
      const res = await op(v, "/api/tags/projet");
      expect(res.status).toBe(404);
      const err = (await res.json()) as any;
      expect(err.error_type).toBe("tag_not_found");
      expect(err.tag).toBe("projet");
      expect(err.did_you_mean).toBe("project");
    });

    it("a tag with an identity row but zero notes still 200s (legitimately empty)", async () => {
      const v = freshVault();
      const put = await op(v, "/api/tags/empty-but-real", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "declared, unused" }),
      });
      expect(put.status).toBe(200);
      const res = await op(v, "/api/tags/empty-but-real");
      expect(res.status).toBe(200);
      const tag = (await res.json()) as any;
      expect(tag.count).toBe(0);
      expect(tag.expanded_count).toBe(0);
    });

    it("single-tag reads carry expanded_count (both forms)", async () => {
      const v = freshVault();
      await createNote(v, { content: "x", tags: ["alpha"] });
      const byQuery = (await (await op(v, "/api/tags?tag=alpha")).json()) as any;
      expect(byQuery.count).toBe(1);
      expect(byQuery.expanded_count).toBe(1);
      const byPath = (await (await op(v, "/api/tags/alpha")).json()) as any;
      expect(byPath.count).toBe(1);
      expect(byPath.expanded_count).toBe(1);
    });

    it("expanded_count rolls up the subtypes axis (parent counts its children's notes)", async () => {
      const v = freshVault();
      const declare = (name: string, body: Record<string, unknown>) =>
        op(v, `/api/tags/${name}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      expect((await declare("parent", { description: "rollup label" })).status).toBe(200);
      expect((await declare("child", { parent_names: ["parent"] })).status).toBe(200);
      await createNote(v, { content: "c", tags: ["child"] });
      const parent = (await (await op(v, "/api/tags/parent")).json()) as any;
      // `count` alone reads as "this tag is dead"; expanded_count is the
      // honest rollup — the whole point of the vault#550 field.
      expect(parent.count).toBe(0);
      expect(parent.expanded_count).toBe(1);
    });

    // NOT tested end-to-end, deliberately: bun restricts `did_you_mean`
    // candidates to a tag-scoped token's allowlist so a suggestion can't leak
    // an out-of-scope tag's existence. Cloud v1 has no tag-scoped tokens at
    // all — every handler is wired with `NO_TAG_SCOPE` (see
    // src/rest/tag-scope.ts), so that branch is unreachable from the wire
    // here. The scope-restricted candidate list IS ported in rest/tags.ts so
    // the door is scope-safe on the day cloud grows scoped tokens; there is
    // just no request that can exercise it yet.
  });

  describe("error_type taxonomy residue in rest/notes.ts (cloud#115 / vault#554)", () => {
    it("PATCH content + content_edit → 400 mutually_exclusive", async () => {
      const v = freshVault();
      const n = await createNote(v, { content: "hello" });
      const res = await patch(v, n.id, {
        content: "a",
        content_edit: { old_text: "hello", new_text: "bye" },
        force: true,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error_type).toBe("mutually_exclusive");
    });

    it("PATCH malformed content_edit → 400 invalid_content_edit", async () => {
      const v = freshVault();
      const n = await createNote(v, { content: "hello" });
      const res = await patch(v, n.id, { content_edit: { old_text: 5 }, force: true });
      expect(res.status).toBe(400);
      const err = (await res.json()) as any;
      expect(err.error_type).toBe("invalid_content_edit");
      expect(err.field).toBe("content_edit");
      expect(typeof err.hint).toBe("string");
    });

    it("PATCH content_edit old_text absent → 422 content_edit_not_found", async () => {
      const v = freshVault();
      const n = await createNote(v, { content: "hello" });
      const res = await patch(v, n.id, {
        content_edit: { old_text: "nowhere", new_text: "x" },
        force: true,
      });
      expect(res.status).toBe(422);
      const err = (await res.json()) as any;
      expect(err.error_type).toBe("content_edit_not_found");
      expect(err.field).toBe("content_edit.old_text");
      expect(typeof err.hint).toBe("string");
    });

    it("PATCH content_edit old_text ambiguous → 409 content_edit_ambiguous", async () => {
      const v = freshVault();
      const n = await createNote(v, { content: "dup dup" });
      const res = await patch(v, n.id, {
        content_edit: { old_text: "dup", new_text: "x" },
        force: true,
      });
      expect(res.status).toBe(409);
      const err = (await res.json()) as any;
      expect(err.error_type).toBe("content_edit_ambiguous");
      expect(err.field).toBe("content_edit.old_text");
      expect(typeof err.hint).toBe("string");
    });

    it("PATCH state_transition.field non-string → 400 invalid_state_transition", async () => {
      const v = freshVault();
      const n = await createNote(v, { content: "hello" });
      const res = await patch(v, n.id, {
        state_transition: { field: 7, from: "a", to: "b" },
        force: true,
      });
      expect(res.status).toBe(400);
      const err = (await res.json()) as any;
      expect(err.error_type).toBe("invalid_state_transition");
      expect(err.field).toBe("state_transition.field");
      expect(typeof err.hint).toBe("string");
    });

    it("PATCH an absent note (no if_missing) → 404 not_found", async () => {
      const v = freshVault();
      const res = await patch(v, "no-such-note", { content: "x", force: true });
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).error_type).toBe("not_found");
    });
  });
});
