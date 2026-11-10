/**
 * The account door's import (T-431, account-import.ts): an owner brings a vault in with the account credential,
 * against real miniflare D1. The vault worker is the one system faked here (a separate Worker; its side of import and
 * import-file is pinned in workers/vault/test/import*.test.ts, and the whole path runs against real local workers in
 * parachute-core's door contracts).
 *
 *   - the gate is vault create's: no credential 401, a read credential 403;
 *   - an import only ever makes a NEW vault: a name that holds anything is taken, mine or anyone's;
 *   - a failed import keeps the name for its owner, and the same call again converges;
 *   - the plan's vault count applies;
 *   - a file reaches only the caller's own vault.
 */
import { describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { env } from "cloudflare:test";
import { ACCOUNT_TOKEN_AUDIENCE } from "../src/account-auth.ts";
import { handleAccountVaultImport, handleAccountVaultImportCheck, handleAccountVaultImportFile } from "../src/account-import.ts";
import { ACCOUNT_TOKEN_CLIENT_ID } from "../src/account-token.ts";
import { MAX_IMPORT_BYTES } from "../src/import-limit.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import { PLAN_SPECS } from "../src/plans.ts";
import { signAccessToken } from "../src/tokens.ts";
import { getVault, isImportPending } from "../src/vaults.ts";
import { ISSUER, db, deps, seedUser, seedVault } from "./helpers.ts";

type VaultFetch = NonNullable<OAuthDeps["vaultFetch"]>;
const TAR = new Uint8Array([1, 2, 3, 4]);
const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/** A vault worker that records what it was asked and answers as a healthy one would, unless told otherwise. */
function fakeVault(script: { import?: () => Response; missing?: number } = {}) {
  const calls: Array<{ vault: string; path: string; method: string; body?: unknown }> = [];
  let importId = "";
  const vaultFetch: VaultFetch = async (input, init) => {
    const req = new Request(input, init);
    // The vault is named in the path (`/vault/<name>/…`) or, on the subdomain form, by the host's first label.
    const url = new URL(req.url);
    const m = /^\/vault\/([^/]+)(.*)$/.exec(url.pathname);
    const call = { vault: m ? m[1]! : url.hostname.split(".")[0]!, path: m ? m[2]! : url.pathname, method: req.method, body: undefined as unknown };
    calls.push(call);
    if (call.path === "/api/internal/import") {
      importId = req.headers.get("x-parachute-import-id") ?? "";
      call.body = new Uint8Array(await req.arrayBuffer());
      return script.import ? script.import() : j({ imported: true, notes: 7, stats: { skipped_attachments: 0 } });
    }
    if (call.path === "/api/internal/import-status") return j({ state: "idle", import_id: importId });
    if (call.path === "/api/internal/import-check") return j({ notes: 7, attachments: 2, files_stored: 2 - (script.missing ?? 0), missing_files: script.missing ?? 0, written_since_import: false });
    if (call.path === "/api/internal/import-file") {
      const form = await req.formData();
      call.body = { path: form.get("path"), sha256: form.get("sha256"), size: (form.get("file") as unknown as File).size };
      return j({ stored: true }, 201);
    }
    return j({ ok: true });
  };
  return { vaultFetch, calls, paths: () => calls.map((c) => `${c.vault}${c.path}`) };
}

async function accountToken(userId: string, verb: "admin" | "read" = "admin"): Promise<string> {
  return (await signAccessToken(db(), { sub: userId, scopes: [`account:${userId}:${verb}`], audience: ACCOUNT_TOKEN_AUDIENCE, clientId: ACCOUNT_TOKEN_CLIENT_ID, issuer: ISSUER, vaultScope: [], ttlSeconds: 600 })).token;
}

function importReq(token: string | null, name: string | undefined, tar: Uint8Array | null = TAR): Request {
  const f = new FormData();
  if (name !== undefined) f.set("vault_name", name);
  if (tar) f.set("tarball", new File([tar], "export.tar", { type: "application/x-tar" }));
  return new Request(`${ISSUER}/account/vaults/import`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: f });
}
const withVault = (v: ReturnType<typeof fakeVault>): OAuthDeps => ({ ...deps(), vaultFetch: v.vaultFetch });

describe("POST /account/vaults/import", () => {
  test("an owner's import makes a new vault of theirs, sends the tar to it, and says what landed", async () => {
    const u = await seedUser("mover@example.com");
    const v = fakeVault({ missing: 2 });
    const res = await handleAccountVaultImport(db(), importReq(await accountToken(u.id), "Moved-In"), withVault(v));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ name: "moved-in", notes: 7, skipped_attachments: 0, missing_files: 2 });
    expect(String(body.url)).toMatch(/moved-in/);
    const row = await getVault(db(), "moved-in");
    expect(row?.ownerUserId).toBe(u.id);
    expect(isImportPending(row!)).toBe(false); // a later import naming it is "taken", never a blow-away
    const sent = v.calls.find((c) => c.path === "/api/internal/import")!;
    expect(sent.vault).toBe("moved-in");
    expect(sent.body).toEqual(TAR);
  });

  test("no credential is 401 and a read credential is 403: nothing is made, nothing is sent", async () => {
    const u = await seedUser("reader@example.com");
    const v = fakeVault();
    expect((await handleAccountVaultImport(db(), importReq(null, "nope-a"), withVault(v))).status).toBe(401);
    expect((await handleAccountVaultImport(db(), importReq(await accountToken(u.id, "read"), "nope-a"), withVault(v))).status).toBe(403);
    expect(await getVault(db(), "nope-a")).toBeNull();
    expect(v.calls).toEqual([]);
  });

  test("a name that holds a vault is taken, whether it is someone else's or my own", async () => {
    const mine = await seedUser("mine@example.com");
    const other = await seedUser("other@example.com");
    await seedVault("mine-full", mine.id);
    await seedVault("theirs-full", other.id);
    const v = fakeVault();
    for (const name of ["mine-full", "theirs-full"]) {
      const res = await handleAccountVaultImport(db(), importReq(await accountToken(mine.id), name), withVault(v));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("vault_taken");
    }
    expect(v.calls.filter((c) => c.path === "/api/internal/import")).toEqual([]);
  });

  test("a failed import keeps the name for its owner; the same call again lands in the same vault; no one else can take it", async () => {
    const u = await seedUser("retry@example.com");
    const thief = await seedUser("thief@example.com");
    let fail = true;
    const v = fakeVault({ import: () => (fail ? j({ error: "boom" }, 500) : j({ imported: true, notes: 3, stats: { skipped_attachments: 0 } })) });
    const first = await handleAccountVaultImport(db(), importReq(await accountToken(u.id), "second-try"), withVault(v));
    expect(first.status).toBe(502);
    expect(((await first.json()) as { error: string; name: string }).name).toBe("second-try");
    expect(isImportPending((await getVault(db(), "second-try"))!)).toBe(true);
    const stolen = await handleAccountVaultImport(db(), importReq(await accountToken(thief.id), "second-try"), withVault(v));
    expect(stolen.status).toBe(409);
    fail = false;
    const again = await handleAccountVaultImport(db(), importReq(await accountToken(u.id), "second-try"), withVault(v));
    expect(again.status).toBe(201);
    expect((await getVault(db(), "second-try"))?.ownerUserId).toBe(u.id);
  }, 120_000);

  test("the plan's vault count applies, as on create", async () => {
    const u = await seedUser("full@example.com");
    const most = Math.max(...Object.values(PLAN_SPECS).map((p) => p.vault_count));
    for (let i = 0; i < most; i++) await seedVault(`full-${i}`, u.id);
    const v = fakeVault();
    const res = await handleAccountVaultImport(db(), importReq(await accountToken(u.id), "one-more"), withVault(v));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("vault_limit_reached");
    expect(await getVault(db(), "one-more")).toBeNull();
  });

  test("a bad name, a missing file and a file over the limit are refused before a vault exists", async () => {
    const u = await seedUser("bad@example.com");
    const v = fakeVault();
    const t = await accountToken(u.id);
    const bad = await handleAccountVaultImport(db(), importReq(t, "Not A Name!"), withVault(v));
    expect([bad.status, ((await bad.json()) as { error: string }).error]).toEqual([400, "invalid_name"]);
    const reserved = await handleAccountVaultImport(db(), importReq(t, "admin"), withVault(v));
    expect([reserved.status, ((await reserved.json()) as { error: string }).error]).toEqual([400, "reserved"]);
    expect((await handleAccountVaultImport(db(), importReq(t, "no-file", null), withVault(v))).status).toBe(400);
    expect((await handleAccountVaultImport(db(), importReq(t, undefined), withVault(v))).status).toBe(400);
    const big = new Request(`${ISSUER}/account/vaults/import`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-length": String(MAX_IMPORT_BYTES + 1024 * 1024), "content-type": "multipart/form-data; boundary=x" }, body: "x" });
    const refused = await handleAccountVaultImport(db(), big, withVault(v));
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([413, "import_too_large"]);
    expect(v.calls).toEqual([]);
  });

  test("the route is the account door's: a real request through the worker reaches it", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/account/vaults/import`, { method: "POST", body: new FormData() }), env);
    expect(res.status).toBe(401);
  });
});

describe("the files an import left out", () => {
  const fileReq = (token: string, vault: string, fields: Record<string, string | null> = {}) => {
    const f = new FormData();
    const all = { path: "2026-01-02/a.png", sha256: "ab".repeat(32), ...fields };
    for (const [k, val] of Object.entries(all)) if (val !== null) f.set(k, val);
    if (fields.file !== null) f.set("file", new File([new Uint8Array([9, 9, 9])], "a.png", { type: "image/png" }));
    return new Request(`${ISSUER}/account/vaults/${vault}/import-file`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: f });
  };

  test("a file goes to the owner's own vault with its path and digest; the vault decides", async () => {
    const u = await seedUser("files@example.com");
    await seedVault("with-files", u.id);
    const v = fakeVault();
    const res = await handleAccountVaultImportFile(db(), fileReq(await accountToken(u.id), "with-files"), withVault(v));
    expect(res.status).toBe(201);
    const sent = v.calls.find((c) => c.path === "/api/internal/import-file")!;
    expect(sent.vault).toBe("with-files");
    expect(sent.body).toEqual({ path: "2026-01-02/a.png", sha256: "ab".repeat(32), size: 3 });
  });

  test("another person's vault and a vault that doesn't exist get the same 403; nothing is sent", async () => {
    const u = await seedUser("me2@example.com");
    const other = await seedUser("them2@example.com");
    await seedVault("not-mine", other.id);
    const v = fakeVault();
    const t = await accountToken(u.id);
    for (const name of ["not-mine", "no-such-vault"]) {
      const res = await handleAccountVaultImportFile(db(), fileReq(t, name), withVault(v));
      expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([403, "not_owner"]);
      const check = await handleAccountVaultImportCheck(db(), new Request(`${ISSUER}/account/vaults/${name}/import-check`, { headers: { authorization: `Bearer ${t}` } }), withVault(v));
      expect(check.status).toBe(403);
    }
    expect(v.calls).toEqual([]);
  });

  test("a file with no digest is refused here; a read credential can't send one", async () => {
    const u = await seedUser("me3@example.com");
    await seedVault("mine-3", u.id);
    const v = fakeVault();
    expect((await handleAccountVaultImportFile(db(), fileReq(await accountToken(u.id), "mine-3", { sha256: null }), withVault(v))).status).toBe(400);
    expect((await handleAccountVaultImportFile(db(), fileReq(await accountToken(u.id, "read"), "mine-3"), withVault(v))).status).toBe(403);
    expect(v.calls).toEqual([]);
  });

  test("the check says what landed, in counts", async () => {
    const u = await seedUser("me4@example.com");
    await seedVault("mine-4", u.id);
    const v = fakeVault({ missing: 1 });
    const res = await handleAccountVaultImportCheck(db(), new Request(`${ISSUER}/account/vaults/mine-4/import-check`, { headers: { authorization: `Bearer ${await accountToken(u.id)}` } }), withVault(v));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "mine-4", notes: 7, attachments: 2, files_stored: 1, missing_files: 1 });
  });
});
