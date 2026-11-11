/**
 * POST /ops/history-import and its follow-ups (T-450): the operator agent adds
 * a box's note history behind the notes of a vault the account owns. Real
 * miniflare D1; the vault worker is the one system faked here (a separate
 * Worker; its side is pinned in workers/vault/test/history-graft.test.ts).
 *
 *   - bearer OPS_RUN_TOKEN only; unset → the router's 404;
 *   - the account must exist, be in good standing, and own the vault;
 *   - a batch that writes is audited first (never a note id), a dry run is not;
 *   - the account purge scrubs the vault name and reference from those rows.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/index.ts";
import { auditRowsFor } from "../src/account-audit.ts";
import { requestAccountDeletion, runAccountDeleteSweep } from "../src/account-delete.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import {
  handleOpsHistoryImportDigest,
  handleOpsHistoryImportFinish,
  handleOpsHistoryImportPost,
  handleOpsHistoryImportStatus,
} from "../src/ops-history-import.ts";
import { getUserById } from "../src/users.ts";
import { ISSUER, decodeJwtPayload, deps, seedUser, seedVault } from "./helpers.ts";

type VaultFetch = NonNullable<OAuthDeps["vaultFetch"]>;
const TOKEN = "ops-run-test-token";
const REF = "T-450 history move";
const OPS_ENV = { ...env, OPS_RUN_TOKEN: TOKEN };
const NOTE_ID = "made-up-note-id-0001";
const RUN_ID = "a".repeat(64);
const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/** A made-up batch: what scripts/ops-history-import.ts builds (the vault checks it in full). */
const BATCH = {
  run: { run_id: RUN_ID, source_fingerprint: "b".repeat(64), tip: "c".repeat(40), options_digest: "d".repeat(64) },
  blobs: [{ hash: "e".repeat(64), content: "made up", byte_size: 7, encoding: null, delta_of: null }],
  notes: [
    {
      id: NOTE_ID,
      tip: { content_hash: "f".repeat(64), path: "Made/Up", extension: "md" },
      receipt: { state_digest: "1".repeat(64), imported_count: 1, retained_count: 1, pruned_imported: 0, pruned_native: 0, completed_at: "2026-01-01T00:00:00.000Z" },
      versions: [{ version_ix: -1 }, { version_ix: 0 }],
      refs: [{ import_ix: 0, source_commit: "2".repeat(40), source_blob: "3".repeat(40) }],
      digest: "4".repeat(64),
    },
  ],
};

/** Records every call to the vault worker and answers as a healthy one would. */
function fakeVault(answer: (path: string, body: unknown) => Response | Promise<Response> = (path) =>
  path === "/api/internal/history-import"
    ? j({ dry_run: false, run_id: RUN_ID, notes: [{ id: NOTE_ID, outcome: "grafted" }], totals: { grafted: 1 } })
    : path === "/api/internal/destroy"
      ? j({ destroyed: true, r2_objects_deleted: 0 })
      : j({ ok: true })) {
  const calls: Array<{ path: string; method: string; auth: string; body?: unknown }> = [];
  const vaultFetch: VaultFetch = async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace(/^\/vault\/[^/]+/, "");
    const body = req.method === "GET" ? undefined : await req.json();
    calls.push({ path, method: req.method, auth: req.headers.get("authorization") ?? "", body });
    return await answer(path, body);
  };
  return { vaultFetch, calls };
}
const withVault = (v: { vaultFetch: VaultFetch }): OAuthDeps => ({ ...deps(), vaultFetch: v.vaultFetch });

function post(path: string, body: object, auth: string | null = `Bearer ${TOKEN}`): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = auth;
  return new Request(`${ISSUER}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
const person = (email: string, vault: string, extra: Record<string, unknown> = {}) => ({ email, confirm: email, vault_name: vault, reference: REF, ...extra });
const send = (fields: object, vault = fakeVault()) =>
  handleOpsHistoryImportPost(OPS_ENV, post("/ops/history-import", fields), withVault(vault)).then((r) => ({ res: r!, vault }));
const auditCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM account_audit").first<{ n: number }>())!.n;

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  for (const m of ["log", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  }
});
afterEach(() => vi.restoreAllMocks());

describe("/ops/history-import", () => {
  test("unset secret → the router's 404 on every door; no bearer or a wrong one → 401; nothing moves", async () => {
    const { id } = await seedUser("gate-history@example.com");
    await seedVault("gate-history-vault", id);
    const fields = person("gate-history@example.com", "gate-history-vault", { batch: BATCH });
    const before = await auditCount();
    const doors: Array<[string, typeof handleOpsHistoryImportPost, object]> = [
      ["/ops/history-import", handleOpsHistoryImportPost, fields],
      ["/ops/history-import/status", handleOpsHistoryImportStatus, { vault_name: "gate-history-vault" }],
      ["/ops/history-import/digest", handleOpsHistoryImportDigest, { vault_name: "gate-history-vault", notes: [] }],
      ["/ops/history-import/finish", handleOpsHistoryImportFinish, person("gate-history@example.com", "gate-history-vault", { run_id: RUN_ID, expect_receipts: 1 })],
    ];
    const vault = fakeVault();
    for (const [path, door, body] of doors) {
      expect((await app.fetch(post(path, body), { ...env })).status, path).toBe(404);
      expect(await door({ ...env }, post(path, body), withVault(vault))).toBeNull();
      for (const auth of [null, `Bearer ${TOKEN}x`, "Bearer read-token"]) {
        const r = await door({ ...OPS_ENV, OPS_READ_TOKEN: "read-token" }, post(path, body, auth), withVault(vault));
        expect(r!.status, `${path} ${auth}`).toBe(401);
      }
      // Wired in the router too: with the secret set, no bearer is a 401 there.
      expect((await app.fetch(post(path, body, null), OPS_ENV)).status, path).toBe(401);
    }
    expect(vault.calls).toEqual([]);
    expect(await auditCount()).toBe(before);
  });

  test("an unknown account → 404, an account in bad standing or not the owner → 409; nothing forwarded or recorded", async () => {
    const { id: owner } = await seedUser("owner-history@example.com");
    const { id: other } = await seedUser("other-history@example.com");
    await seedVault("owned-history-vault", owner);
    const before = await auditCount();
    const vault = fakeVault();

    const unknown = await send(person("nobody-history@example.com", "owned-history-vault", { batch: BATCH }), vault);
    expect(unknown.res.status).toBe(404);
    expect(await unknown.res.json()).toMatchObject({ error: "account_not_found" });

    const notOwner = await send(person("other-history@example.com", "owned-history-vault", { batch: BATCH }), vault);
    expect(notOwner.res.status).toBe(409);
    expect(await notOwner.res.json()).toMatchObject({ error: "not_this_account" });

    const noVault = await send(person("owner-history@example.com", "no-such-history-vault", { batch: BATCH }), vault);
    expect(noVault.res.status).toBe(404);

    await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?").bind(new Date().toISOString(), other).run();
    await seedVault("suspended-history-vault", other);
    const suspended = await send(person("other-history@example.com", "suspended-history-vault", { batch: BATCH }), vault);
    expect(suspended.res.status).toBe(409);
    expect(await suspended.res.json()).toMatchObject({ error: "account_suspended" });

    // The address twice, a reference with no address, no stray fields, dry_run beside the batch.
    expect((await send({ ...person("owner-history@example.com", "owned-history-vault", { batch: BATCH }), confirm: "x@example.com" }, vault)).res.status).toBe(400);
    expect((await send(person("owner-history@example.com", "owned-history-vault", { batch: BATCH, reference: "ask owner@example.com" }), vault)).res.status).toBe(400);
    expect((await send(person("owner-history@example.com", "owned-history-vault", { batch: BATCH, dryrun: true }), vault)).res.status).toBe(400);
    expect((await send(person("owner-history@example.com", "owned-history-vault", { batch: { ...BATCH, dry_run: true } }), vault)).res.status).toBe(400);
    expect((await send(person("owner-history@example.com", "owned-history-vault", { batch: { notes: [] } }), vault)).res.status).toBe(400);

    expect(vault.calls).toEqual([]);
    expect(await auditCount()).toBe(before);
  });

  test("a dry run forwards with dry_run and records nothing; a real batch records one row first, then forwards", async () => {
    const { id } = await seedUser("move-history@example.com");
    await seedVault("move-history-vault", id);
    const before = await auditCount();

    const dryVault = fakeVault((path, body) => j({ dry_run: (body as any).dry_run, totals: { grafted: 1 } }));
    const dry = await send(person("move-history@example.com", "move-history-vault", { batch: BATCH, dry_run: true }), dryVault);
    expect(dry.res.status).toBe(200);
    expect(await dry.res.json()).toMatchObject({ dry_run: true });
    expect(dryVault.calls).toHaveLength(1);
    expect(dryVault.calls[0]!.body).toEqual({ ...BATCH, dry_run: true });
    expect(await auditCount()).toBe(before);

    // The audit row must exist before the vault is called.
    let rowsAtCall = -1;
    const vault = fakeVault(async () => {
      rowsAtCall = await auditCount();
      return j({ dry_run: false, notes: [{ id: NOTE_ID, outcome: "grafted" }], totals: { grafted: 1 } });
    });
    const real = await send(person("move-history@example.com", "move-history-vault", { batch: BATCH }), vault);
    expect(real.res.status).toBe(200);
    expect(await real.res.json()).toMatchObject({ totals: { grafted: 1 } });
    expect(vault.calls.map((c) => [c.method, c.path])).toEqual([["POST", "/api/internal/history-import"]]);
    expect(vault.calls[0]!.body).toEqual({ ...BATCH, dry_run: false });
    // A first-party admin mint for this vault: the vault's internal gate needs exactly that.
    const claims = decodeJwtPayload(vault.calls[0]!.auth.replace(/^Bearer /, ""));
    expect(claims).toMatchObject({ client_id: "parachute-console", scope: "vault:move-history-vault:admin", sub: id });
    expect(rowsAtCall).toBe(before + 1);

    const rows = (await auditRowsFor(env.DB, id)).filter((r) => r.action === "history_import_batch");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("operator:ops-agent");
    expect(rows[0]!.note).toEqual({ vault: "move-history-vault", reference: REF, run: RUN_ID.slice(0, 12), notes: 1, versions: 2, blobs: 1 });
    expect(JSON.stringify(rows[0]!.note)).not.toContain(NOTE_ID);
    // Counts only in the logs: no address, no note id.
    expect(logged.join("\n")).not.toContain("move-history@example.com");
    expect(logged.join("\n")).not.toContain(NOTE_ID);
    expect(logged.some((l) => l.includes("event=ops_history_import ") && l.includes("notes=1 versions=2 blobs=1"))).toBe(true);

    // The vault's refusal passes through as it is.
    const refusing = fakeVault(() => j({ error: "A blob does not match its hash", error_type: "blob_invalid", hash: "e".repeat(64) }, 400));
    const bad = await send(person("move-history@example.com", "move-history-vault", { batch: BATCH }), refusing);
    expect(bad.res.status).toBe(400);
    expect(await bad.res.json()).toMatchObject({ error_type: "blob_invalid" });
  });

  test("status and digest pass the vault's counts through; finish records and forwards, a dry finish only reads", async () => {
    const { id } = await seedUser("finish-history@example.com");
    await seedVault("finish-history-vault", id);
    const status = { runs: [{ run_id: RUN_ID, status: "applying", receipts: 3 }], imported_versions: 5, native_versions: 2, refs: 5, keep_all: true };
    const vault = fakeVault((path, body) => {
      if (path === "/api/internal/history-import") return j(status);
      if (path === "/api/internal/history-digest") return j({ notes: (body as any).notes.map((n: any) => ({ id: n.id, found: true, versions: 2, digest: "5".repeat(64), content_ok: true })) });
      if (path === "/api/internal/history-import/finish") return j({ run_id: RUN_ID, status: "complete", receipts: 3 });
      return j({}, 404);
    });
    const st = await handleOpsHistoryImportStatus(OPS_ENV, post("/ops/history-import/status", { vault_name: "finish-history-vault" }), withVault(vault));
    expect(await st!.json()).toEqual(status);
    const dg = await handleOpsHistoryImportDigest(OPS_ENV, post("/ops/history-import/digest", { vault_name: "finish-history-vault", notes: [{ id: NOTE_ID, through_ix: 0 }] }), withVault(vault));
    expect(await dg!.json()).toMatchObject({ notes: [{ id: NOTE_ID, content_ok: true }] });
    const before = await auditCount();

    const finishFields = person("finish-history@example.com", "finish-history-vault", { run_id: RUN_ID, expect_receipts: 3 });
    const dry = await handleOpsHistoryImportFinish(OPS_ENV, post("/ops/history-import/finish", { ...finishFields, dry_run: true }), withVault(vault));
    expect(await dry!.json()).toEqual({ dry_run: true, would_finish: true, run_id: RUN_ID, status: "applying", receipts: 3 });
    expect(await auditCount()).toBe(before);

    const done = await handleOpsHistoryImportFinish(OPS_ENV, post("/ops/history-import/finish", finishFields), withVault(vault));
    expect(done!.status).toBe(200);
    expect(vault.calls.at(-1)).toMatchObject({ path: "/api/internal/history-import/finish", body: { run_id: RUN_ID, expect_receipts: 3 } });
    const rows = (await auditRowsFor(env.DB, id)).filter((r) => r.action === "history_import_finished");
    expect(rows.map((r) => r.note)).toEqual([{ vault: "finish-history-vault", reference: REF, run: RUN_ID.slice(0, 12), expect_receipts: 3 }]);
  });

  test("erasing the account takes the vault name and reference out of the history import rows it keeps", async () => {
    const { id } = await seedUser("purge-history@example.com");
    await seedVault("purge-history-vault", id);
    expect((await send(person("purge-history@example.com", "purge-history-vault", { batch: BATCH }))).res.status).toBe(200);
    const fin = await handleOpsHistoryImportFinish(
      OPS_ENV,
      post("/ops/history-import/finish", person("purge-history@example.com", "purge-history-vault", { run_id: RUN_ID, expect_receipts: 1 })),
      withVault(fakeVault()),
    );
    expect(fin!.status).toBe(200);
    const d = { ...deps(), vaultFetch: fakeVault().vaultFetch };
    const user = (await getUserById(env.DB, id))!;
    expect((await requestAccountDeletion(OPS_ENV, d, user, { actor: "self", notifyHolder: false })).ok).toBe(true);
    expect((await runAccountDeleteSweep(OPS_ENV, d, new Date(), { onlyUserId: id, waiveWindow: true })).purged).toBe(1);

    const rows = (await auditRowsFor(env.DB, id)).filter((r) => r.action.startsWith("history_import_"));
    expect(rows.map((r) => r.action)).toEqual(["history_import_batch", "history_import_finished"]);
    for (const r of rows) {
      expect(JSON.stringify(r.note)).not.toContain("purge-history-vault");
      expect(JSON.stringify(r.note)).not.toContain(REF);
    }
    expect(rows[0]!.note).toEqual({ run: RUN_ID.slice(0, 12), notes: 1, versions: 2, blobs: 1 });
  });
});
