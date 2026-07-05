/**
 * Internal config seam — PUT/GET /vault/<name>/api/internal/config, the
 * platform-owned per-vault config endpoint the Identity Worker pushes plan
 * storage caps through (Wave 4 entitlements).
 *
 * The authorization matrix is the point of this suite: a vault OWNER can mint
 * `vault:<name>:admin` through the public OAuth flow, so the endpoint gates on
 * the FIRST-PARTY `client_id` claim (issuer-internal mints only; DCR ids are
 * server-generated UUIDs so no tenant client can carry it) — plus the
 * pre-existing VAULT_AUTH_TOKEN operator bearer. Also pinned here:
 *   - the pushed cap is ENFORCED (413 storage_cap_exceeded on note writes),
 *   - a cap RAISE lands even when the vault is already over cap (the endpoint
 *     dispatches before the cap gate — a plan upgrade must always work),
 *   - the resolved cap surfaces on the read-scoped vault landing (cap_bytes),
 *   - validation + persistence of the override.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { OP, base, createNote, freshVault, mintToken, op } from "./helpers.ts";

/** First-party admin token — exactly what identity's pushVaultCap mints. */
async function firstPartyToken(vault: string): Promise<string> {
  return mintToken({
    vault,
    scopes: `vault:${vault}:admin`,
    vaultScope: [vault],
    clientId: FIRST_PARTY_CLIENT_ID,
  });
}

function putConfig(vault: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${base(vault)}/api/internal/config`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Upload a file of `size` bytes via the operator (full-permission) token. */
function upload(vault: string, size: number, name = "clip.bin"): Promise<Response> {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(size)], name, { type: "application/octet-stream" }));
  return op(vault, "/api/storage/upload", { method: "POST", body: fd });
}

/** POST a note via the operator token (returns the raw Response, not JSON). */
function postNote(vault: string, content: string): Promise<Response> {
  return op(vault, "/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

describe("internal config — authorization matrix", () => {
  it("first-party admin token (issuer mint shape) sets cap_bytes", async () => {
    const v = freshVault("ic");
    const res = await putConfig(v, await firstPartyToken(v), { cap_bytes: 104_857_600 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe(v);
    expect(body.cap_bytes).toBe(104_857_600);
    expect(body.resolved_cap_bytes).toBe(104_857_600);
    expect(typeof body.used_bytes).toBe("number");
  });

  it("operator bearer (VAULT_AUTH_TOKEN) sets cap_bytes — the control-plane seam", async () => {
    const v = freshVault("ic");
    const res = await putConfig(v, OP, { cap_bytes: 5_000_000 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).cap_bytes).toBe(5_000_000);
  });

  it("a TENANT-minted vault:<name>:admin token (no first-party client_id) is REFUSED", async () => {
    const v = freshVault("ic");
    // The exact shape a vault owner can obtain through the public OAuth flow:
    // admin verb, correct aud, correct vault_scope — but a DCR client_id.
    const tenantAdmin = await mintToken({
      vault: v,
      scopes: `vault:${v}:admin`,
      vaultScope: [v],
      clientId: "3f6a2e9b-1111-4222-8333-444455556666",
    });
    const res = await putConfig(v, tenantAdmin, { cap_bytes: 999_999_999_999 });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error_type).toBe("internal_config_forbidden");
  });

  it("an admin token with NO client_id claim is refused too", async () => {
    const v = freshVault("ic");
    const bare = await mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v] });
    const res = await putConfig(v, bare, { cap_bytes: 1 });
    expect(res.status).toBe(403);
  });

  it("a first-party WRITE-verb token is refused (admin verb required)", async () => {
    const v = freshVault("ic");
    const writeOnly = await mintToken({
      vault: v,
      scopes: `vault:${v}:write`,
      vaultScope: [v],
      clientId: FIRST_PARTY_CLIENT_ID,
    });
    const res = await putConfig(v, writeOnly, { cap_bytes: 1_000_000 });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error_type).toBe("internal_config_forbidden");
  });

  it("GET reports the usage split — db_bytes + r2_bytes = used_bytes (the daily rollup's read)", async () => {
    const v = freshVault("ic");
    // Materialize with real content so the SQLite size is nonzero.
    await createNote(v, { content: "some bytes so the database has a size" });
    const res = await SELF.fetch(`${base(v)}/api/internal/config`, {
      headers: { authorization: `Bearer ${await firstPartyToken(v)}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(typeof body.db_bytes).toBe("number");
    expect(body.db_bytes).toBeGreaterThan(0);
    // No attachments uploaded → the R2 meter is zero.
    expect(body.r2_bytes).toBe(0);
    expect(body.used_bytes).toBe(body.db_bytes + body.r2_bytes);
  });

  it("GET is gated the same way: first-party reads it, a tenant read token cannot", async () => {
    const v = freshVault("ic");
    await putConfig(v, await firstPartyToken(v), { cap_bytes: 7_000_000 });

    const fp = await SELF.fetch(`${base(v)}/api/internal/config`, {
      headers: { authorization: `Bearer ${await firstPartyToken(v)}` },
    });
    expect(fp.status).toBe(200);
    expect(((await fp.json()) as any).cap_bytes).toBe(7_000_000);

    const tenantRead = await mintToken({ vault: v, scopes: `vault:${v}:read`, vaultScope: [v] });
    const denied = await SELF.fetch(`${base(v)}/api/internal/config`, {
      headers: { authorization: `Bearer ${tenantRead}` },
    });
    expect(denied.status).toBe(403);
  });
});

describe("internal config — validation", () => {
  it("rejects a non-number, non-integer, zero, and negative cap_bytes", async () => {
    const v = freshVault("ic");
    const token = await firstPartyToken(v);
    for (const bad of ["100", 1.5, 0, -1, null]) {
      const res = await putConfig(v, token, { cap_bytes: bad });
      expect(res.status).toBe(400);
    }
    // Malformed JSON body.
    const raw = await SELF.fetch(`${base(v)}/api/internal/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "not json",
    });
    expect(raw.status).toBe(400);
  });
});

describe("internal config — the cap is real", () => {
  it("a pushed tiny cap 413s note writes; a raise clears it — even from OVER-cap", async () => {
    const v = freshVault("ic");
    // Materialize + baseline content, then push a cap below the current DB
    // size: the vault is instantly OVER cap.
    await createNote(v, { content: "baseline content before the cap lands" });
    const tiny = await putConfig(v, await firstPartyToken(v), { cap_bytes: 1024 });
    expect(tiny.status).toBe(200);

    // Byte-growing write → the documented 413 shape.
    const blocked = await op(v, "/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "no room at the inn" }),
    });
    expect(blocked.status).toBe(413);
    const err = (await blocked.json()) as any;
    expect(err.error_type).toBe("storage_cap_exceeded");
    expect(err.cap_bytes).toBe(1024);

    // THE PLAN-UPGRADE PATH: the vault is over cap, yet the cap raise itself
    // must land (internal config dispatches before the cap gate).
    const raise = await putConfig(v, await firstPartyToken(v), { cap_bytes: 100 * 1024 * 1024 });
    expect(raise.status).toBe(200);
    expect(((await raise.json()) as any).resolved_cap_bytes).toBe(100 * 1024 * 1024);

    const unblocked = await op(v, "/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "room again after the upgrade" }),
    });
    expect(unblocked.status).toBe(201);
  });

  it("the override persists in DO config and the landing surfaces the RESOLVED cap", async () => {
    const v = freshVault("ic");
    // Before any override: the landing resolves to the env default (2MB in
    // the test bindings).
    const before = await op(v, "");
    expect(((await before.json()) as any).cap_bytes).toBe(2_000_000);

    await putConfig(v, await firstPartyToken(v), { cap_bytes: 104_857_600 });

    // Read-scoped tenant view: GET /vault/<name> carries the effective quota.
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read`, vaultScope: [v] });
    const landing = await SELF.fetch(`${base(v)}`, { headers: { authorization: `Bearer ${token}` } });
    expect(landing.status).toBe(200);
    expect(((await landing.json()) as any).cap_bytes).toBe(104_857_600);
  });
});

describe("two-meter caps — the pricing model", () => {
  it("pushes { caps } and the landing surfaces the split + summed cap_bytes", async () => {
    const v = freshVault("ic");
    const res = await putConfig(v, await firstPartyToken(v), {
      caps: { notes_bytes: 50 * 1024 * 1024, attachment_bytes: 2 * 1024 * 1024 * 1024 },
      transcription: { enabled: true, minutes_limit: 60 },
      frozen: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.caps).toEqual({ notes_bytes: 50 * 1024 * 1024, attachment_bytes: 2 * 1024 * 1024 * 1024 });
    expect(body.frozen).toBe(false);
    // resolved_cap_bytes = the two-meter budgets summed.
    expect(body.resolved_cap_bytes).toBe(50 * 1024 * 1024 + 2 * 1024 * 1024 * 1024);

    // Read-scoped landing: cap_bytes = sum + the additive caps object.
    const token = await mintToken({ vault: v, scopes: `vault:${v}:read`, vaultScope: [v] });
    const landing = await SELF.fetch(`${base(v)}`, { headers: { authorization: `Bearer ${token}` } });
    const l = (await landing.json()) as any;
    expect(l.cap_bytes).toBe(50 * 1024 * 1024 + 2 * 1024 * 1024 * 1024);
    expect(l.caps).toEqual({
      notes_bytes: 50 * 1024 * 1024,
      attachment_bytes: 2 * 1024 * 1024 * 1024,
      attachments_enabled: true,
    });
  });

  it("the NOTES meter gates note writes (413 meter=notes); the attachment meter is INDEPENDENT", async () => {
    const v = freshVault("ic");
    await createNote(v, { content: "baseline so the SQLite db has a real size" });
    // Notes budget below the current db size → instantly over; attachments generous.
    await putConfig(v, await firstPartyToken(v), {
      caps: { notes_bytes: 1024, attachment_bytes: 10 * 1024 * 1024 },
    });

    const blockedNote = await postNote(v, "no room in the notes budget");
    expect(blockedNote.status).toBe(413);
    const err = (await blockedNote.json()) as any;
    expect(err.error_type).toBe("storage_cap_exceeded");
    expect(err.meter).toBe("notes");
    expect(err.cap_bytes).toBe(1024);

    // The attachment meter is a SEPARATE budget — a small upload still lands
    // even though the notes budget is blown.
    const okUpload = await upload(v, 4096);
    expect(okUpload.status).toBe(201);
  });

  it("attachment_bytes:0 → the storage upload 403s attachments_not_included (before cap math)", async () => {
    const v = freshVault("ic");
    // Notes-only tier (Entry): generous notes budget, ZERO attachment budget.
    await putConfig(v, await firstPartyToken(v), {
      caps: { notes_bytes: 100 * 1024 * 1024, attachment_bytes: 0 },
    });
    const blocked = await upload(v, 8);
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as any).error_type).toBe("attachments_not_included");

    // Notes writes are unaffected — the meters are independent.
    const note = await postNote(v, "notes still work on a notes-only plan");
    expect(note.status).toBe(201);
  });

  it("the ATTACHMENT meter gates uploads (413 meter=attachments)", async () => {
    const v = freshVault("ic");
    await putConfig(v, await firstPartyToken(v), {
      caps: { notes_bytes: 100 * 1024 * 1024, attachment_bytes: 1024 },
    });
    // A file larger than the 1 KiB attachment budget.
    const blocked = await upload(v, 4096);
    expect(blocked.status).toBe(413);
    const err = (await blocked.json()) as any;
    expect(err.error_type).toBe("storage_cap_exceeded");
    expect(err.meter).toBe("attachments");
    expect(err.cap_bytes).toBe(1024);
  });
});

describe("frozen — the expired floor (402 plan_required)", () => {
  it("frozen blocks writes with 402; reads + DELETE untouched; un-freeze restores writes", async () => {
    const v = freshVault("ic");
    const note = await createNote(v, { content: "written before the freeze" });
    await putConfig(v, await firstPartyToken(v), {
      caps: { notes_bytes: 100 * 1024 * 1024, attachment_bytes: 8 * 1024 * 1024 },
      frozen: true,
    });

    // WRITE → 402 plan_required (before any cap math).
    const blockedNote = await postNote(v, "frozen — no writes");
    expect(blockedNote.status).toBe(402);
    expect(((await blockedNote.json()) as any).error_type).toBe("plan_required");

    // Attachment upload → 402 too.
    const blockedUpload = await upload(v, 16);
    expect(blockedUpload.status).toBe(402);
    expect(((await blockedUpload.json()) as any).error_type).toBe("plan_required");

    // READ (landing) is untouched, and the landing advertises frozen:true.
    const readTok = await mintToken({ vault: v, scopes: `vault:${v}:read`, vaultScope: [v] });
    const landing = await SELF.fetch(`${base(v)}`, { headers: { authorization: `Bearer ${readTok}` } });
    expect(landing.status).toBe(200);
    expect(((await landing.json()) as any).frozen).toBe(true);

    // DELETE is exempt — a frozen tenant can still delete their way down.
    const del = await op(v, `/api/notes/${note.id}`, { method: "DELETE" });
    expect([200, 204]).toContain(del.status);

    // Un-freeze → writes work again (the upgrade-out-of-expired path).
    await putConfig(v, await firstPartyToken(v), { frozen: false });
    const unblocked = await postNote(v, "writing again after picking a plan");
    expect(unblocked.status).toBe(201);
  });
});

describe("two-meter validation", () => {
  it("rejects malformed caps (missing/negative notes, non-integer, non-object)", async () => {
    const v = freshVault("ic");
    const token = await firstPartyToken(v);
    for (const bad of [
      { notes_bytes: 0, attachment_bytes: 10 }, // notes must be > 0
      { notes_bytes: 100, attachment_bytes: -1 }, // attachment must be >= 0
      { notes_bytes: 1.5, attachment_bytes: 10 }, // integer
      { attachment_bytes: 10 }, // missing notes
      "nope",
    ]) {
      const res = await putConfig(v, token, { caps: bad });
      expect(res.status).toBe(400);
    }
    // attachment_bytes:0 IS legal (the notes-only tier).
    const ok = await putConfig(v, token, { caps: { notes_bytes: 100, attachment_bytes: 0 } });
    expect(ok.status).toBe(200);
  });

  it("frozen must be a boolean", async () => {
    const v = freshVault("ic");
    const res = await putConfig(v, await firstPartyToken(v), { frozen: "yes" });
    expect(res.status).toBe(400);
  });
});
