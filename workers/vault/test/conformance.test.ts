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
    const check = await (await op(v, "/api/tags/standup")).json() as any;
    expect(check.fields).toBeNull();
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
