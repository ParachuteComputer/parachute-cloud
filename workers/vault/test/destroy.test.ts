/**
 * Vault destroy — POST /api/internal/destroy (PR-1 of the vault-delete
 * train, cloud#226). The vault worker's half of tenant-initiated deletion:
 * closes live WS sockets, purges every R2 object under the vault's prefix
 * (attachments/ + snapshots/ + exports/ in ONE pass), wipes DO storage
 * (alarms first, `deleteAll()` doesn't clear them), and flags the warm
 * instance so nothing on it can re-persist before the next eviction.
 *
 * Authorization is the PRE-EXISTING platform-vs-tenant gate
 * (`internalForbidden`, same as every other `/api/internal/*` seam) — this
 * suite pins the confirm-body defense-in-depth on top of it, plus the
 * destructive sequence itself: the prefix-boundary pin (a missing trailing
 * slash would over-delete a sibling vault), the warm-instance 410 with NO
 * storage write landing, and idempotency (the identity-side cascade retries
 * this call).
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { base, createNote, freshVault, mintToken, op, OP } from "./helpers.ts";

function firstPartyToken(vault: string): Promise<string> {
  return mintToken({ vault, scopes: `vault:${vault}:admin`, vaultScope: [vault], clientId: FIRST_PARTY_CLIENT_ID });
}

function destroyReq(vault: string, token: string, confirm: unknown): Promise<Response> {
  return SELF.fetch(`${base(vault)}/api/internal/destroy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ confirm }),
  });
}

function doStub(vault: string): DurableObjectStub {
  return env.VAULT.get(env.VAULT.idFromName(vault)) as unknown as DurableObjectStub;
}

/** Upload a file via the operator token — mirrors internal-config.test.ts. */
function upload(vault: string, size: number, name = "clip.bin"): Promise<Response> {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(size)], name, { type: "application/octet-stream" }));
  return op(vault, "/api/storage/upload", { method: "POST", body: fd });
}

function snapshotReq(vault: string): Promise<Response> {
  return SELF.fetch(`${base(vault)}/api/internal/snapshot`, {
    method: "POST",
    headers: { authorization: `Bearer ${OP}`, "content-type": "application/json" },
    body: JSON.stringify({ retention: { daily: 14, weekly: 8, monthly: 12 } }),
  });
}

/** Seed a vault with a note, an attachment, a snapshot, AND an export — one
 *  object under each of the three R2 families the destroy purge must cover. */
async function seedAllThreeFamilies(v: string): Promise<void> {
  await createNote(v, { content: "destroy me" });
  expect((await upload(v, 128)).status).toBe(201);
  expect((await snapshotReq(v)).status).toBe(200);
  const exp = await op(v, "/api/export");
  expect(exp.status).toBe(200);
  await exp.arrayBuffer(); // drain the stream so the R2 write below it settles
}

async function keysUnder(prefix: string): Promise<string[]> {
  const page = await env.ATTACHMENTS.list({ prefix });
  return page.objects.map((o) => o.key);
}

describe("POST /api/internal/destroy — the erasure sequence", () => {
  it("purges attachments/ + snapshots/ + exports/ in one pass and reports the count", async () => {
    const v = freshVault("dx");
    await seedAllThreeFamilies(v);
    const before = await keysUnder(`vault-${v}/`);
    // attachment + snapshot tarball + snapshot manifest + export tarball, at least.
    expect(before.length).toBeGreaterThanOrEqual(4);
    expect(before.some((k) => k.startsWith(`vault-${v}/attachments/`))).toBe(true);
    expect(before.some((k) => k.startsWith(`vault-${v}/snapshots/`))).toBe(true);
    expect(before.some((k) => k.startsWith(`vault-${v}/exports/`))).toBe(true);

    const res = await destroyReq(v, await firstPartyToken(v), v);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({ destroyed: true, r2_objects_deleted: before.length });

    expect(await keysUnder(`vault-${v}/`)).toEqual([]);
  });

  it("prefix boundary: an object under vault-<name>x/ SURVIVES (the trailing slash is load-bearing)", async () => {
    const v = freshVault("dx");
    await createNote(v, { content: "just a note, nothing fancy" });
    // A sibling vault whose name happens to be this vault's name plus a
    // suffix — `vault-<name>/` must not also match `vault-<name>x/`.
    const neighborKey = `vault-${v}x/attachments/2026-01-01/neighbor.bin`;
    await env.ATTACHMENTS.put(neighborKey, new Uint8Array([1, 2, 3]));

    const res = await destroyReq(v, await firstPartyToken(v), v);
    expect(res.status).toBe(200);

    expect(await keysUnder(`vault-${v}x/`)).toEqual([neighborKey]);
    await env.ATTACHMENTS.delete(neighborKey); // tidy the shared bucket for later tests
  });

  it("warm-instance follow-up request → 410, and NO storage write lands", async () => {
    const v = freshVault("dx");
    await createNote(v, { content: "written before destroy" });
    expect((await destroyReq(v, await firstPartyToken(v), v)).status).toBe(200);

    // Read-shaped follow-up: also 410, no exemption for reads.
    const landing = await SELF.fetch(base(v));
    expect(landing.status).toBe(410);
    expect(((await landing.json()) as any).error_type).toBe("vault_destroyed");

    // Write-shaped follow-up: 410, and it must not land.
    const write = await SELF.fetch(`${base(v)}/api/notes`, {
      method: "POST",
      headers: { authorization: `Bearer ${OP}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "should never exist" }),
    });
    expect(write.status).toBe(410);

    // Ground truth: DO storage is empty and no alarm got re-armed — proves
    // ensureState() never ran on either follow-up (the 410 short-circuit is
    // what stops maybeArmEmbeddingBackfill from re-persisting/re-arming).
    await runInDurableObject<DurableObject, void>(doStub(v), async (inst: any) => {
      const keys = [...(await inst.ctx.storage.list()).keys()];
      expect(keys).toEqual([]);
      expect(await inst.ctx.storage.getAlarm()).toBeNull();
    });
  });

  it("a tenant-shaped OAuth admin token (non-first-party client_id) is refused — the existing platform gate", async () => {
    const v = freshVault("dx");
    await createNote(v, { content: "still here" });
    const tenantAdmin = await mintToken({
      vault: v,
      scopes: `vault:${v}:admin`,
      vaultScope: [v],
      clientId: "3f6a2e9b-1111-4222-8333-444455556666",
    });
    const res = await destroyReq(v, tenantAdmin, v);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error_type).toBe("internal_config_forbidden");

    // Untouched — the refused call did nothing.
    const landing = await op(v, "");
    expect(landing.status).toBe(200);
  });

  it("a confirm mismatch (or missing confirm) is refused with 400 — defense-in-depth, not the primary guard", async () => {
    const v = freshVault("dx");
    const token = await firstPartyToken(v);

    const mismatch = await destroyReq(v, token, "not-the-vault-name");
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as any).error_type).toBe("destroy_confirm_mismatch");

    const missing = await SELF.fetch(`${base(v)}/api/internal/destroy`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    // Untouched — neither refused call did anything.
    expect((await op(v, "")).status).toBe(200);
  });

  it("a second destroy is a 200 no-op — idempotent for the identity-side cascade's retry", async () => {
    const v = freshVault("dx");
    await createNote(v, { content: "one and done" });
    const token = await firstPartyToken(v);

    const first = await destroyReq(v, token, v);
    expect(first.status).toBe(200);

    const second = await destroyReq(v, token, v);
    expect(second.status).toBe(200);
    expect((await second.json()) as any).toEqual({ destroyed: true, r2_objects_deleted: 0 });
  });
});
