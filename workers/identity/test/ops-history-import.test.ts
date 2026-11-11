/**
 * POST /ops/history-import and its follow-ups (T-450): the operator agent adds
 * a box's note history behind the notes of a vault the account owns. Real
 * miniflare D1; the vault worker is the one system faked here (a separate
 * Worker; its side is pinned in workers/vault/test/history-graft.test.ts).
 *
 *   - bearer OPS_RUN_TOKEN only; unset → the router's 404;
 *   - the account must exist, be in good standing, and own the vault, on every
 *     door (status and digest too, though they write no audit row);
 *   - a batch is multipart: small fields this door checks, and the batch's JSON
 *     bytes, which it passes to the vault untouched (dry_run in the query);
 *   - a batch that writes is audited first with the counts the client stated
 *     (never a note id), a dry run is not;
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
function fakeVault(answer: (path: string, body: unknown) => Response | Promise<Response> = (path, body) =>
  path === "/api/internal/history-import" && body === undefined
    ? j({ runs: [{ run_id: RUN_ID, status: "applying", receipts: 1 }], imported_versions: 1, native_versions: 1, refs: 1, keep_all: true })
    : path === "/api/internal/history-import"
    ? j({ dry_run: false, run_id: RUN_ID, notes: [{ id: NOTE_ID, outcome: "grafted" }], totals: { grafted: 1 }, versions_written: 2, blobs_written: 1, database_bytes_before: 1000, database_bytes: 2000, notes_cap_bytes: null })
    : path === "/api/internal/destroy"
      ? j({ destroyed: true, r2_objects_deleted: 0 })
      : j({ ok: true })) {
  const calls: Array<{ path: string; query: string; method: string; auth: string; contentType: string; raw?: string; body?: unknown }> = [];
  const vaultFetch: VaultFetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/vault\/[^/]+/, "");
    const raw = req.method === "GET" ? undefined : await req.text();
    const body = raw === undefined ? undefined : JSON.parse(raw);
    calls.push({ path, query: url.search, method: req.method, auth: req.headers.get("authorization") ?? "", contentType: req.headers.get("content-type") ?? "", raw, body });
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
/** The batch's bytes as the client sends them (odd spacing on purpose: the door must pass them through untouched). */
const BATCH_BYTES = JSON.stringify(BATCH, null, 1);
/** The counts the client states beside the batch. */
const STATED = { run_id: RUN_ID, notes: "1", versions: "2", blobs: "1" };
/** A multipart request to the batch door: small text fields, and the batch as a file part (null: none). */
function postForm(fields: Record<string, string>, batch: string | null = BATCH_BYTES, auth: string | null = `Bearer ${TOKEN}`): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (batch !== null) form.set("batch", new File([batch], "batch.json", { type: "application/json" }));
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = auth;
  return new Request(`${ISSUER}/ops/history-import`, { method: "POST", headers, body: form });
}
const person = (email: string, vault: string, extra: Record<string, string | number> = {}) => ({ email, confirm: email, vault_name: vault, reference: REF, ...extra });
const formFields = (email: string, vault: string, extra: Record<string, string> = {}) => ({ ...person(email, vault), ...STATED, ...extra }) as Record<string, string>;
const send = (fields: Record<string, string>, vault = fakeVault(), batch: string | null = BATCH_BYTES) =>
  handleOpsHistoryImportPost(OPS_ENV, postForm(fields, batch), withVault(vault)).then((r) => ({ res: r!, vault }));
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
    const who = person("gate-history@example.com", "gate-history-vault");
    const before = await auditCount();
    const doors: Array<[string, typeof handleOpsHistoryImportPost, (auth: string | null) => Request]> = [
      ["/ops/history-import", handleOpsHistoryImportPost, (auth) => postForm(formFields("gate-history@example.com", "gate-history-vault"), BATCH_BYTES, auth)],
      ["/ops/history-import/status", handleOpsHistoryImportStatus, (auth) => post("/ops/history-import/status", who, auth)],
      ["/ops/history-import/digest", handleOpsHistoryImportDigest, (auth) => post("/ops/history-import/digest", { ...who, notes: [] }, auth)],
      ["/ops/history-import/finish", handleOpsHistoryImportFinish, (auth) => post("/ops/history-import/finish", { ...who, run_id: RUN_ID, expect_receipts: 1 }, auth)],
    ];
    const vault = fakeVault();
    for (const [path, door, req] of doors) {
      expect((await app.fetch(req(`Bearer ${TOKEN}`), { ...env })).status, path).toBe(404);
      expect(await door({ ...env }, req(`Bearer ${TOKEN}`), withVault(vault))).toBeNull();
      for (const auth of [null, `Bearer ${TOKEN}x`, "Bearer read-token"]) {
        const r = await door({ ...OPS_ENV, OPS_READ_TOKEN: "read-token" }, req(auth), withVault(vault));
        expect(r!.status, `${path} ${auth}`).toBe(401);
      }
      // Wired in the router too: with the secret set, no bearer is a 401 there.
      expect((await app.fetch(req(null), OPS_ENV)).status, path).toBe(401);
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
    const fields = (extra: Record<string, string> = {}) => formFields("owner-history@example.com", "owned-history-vault", extra);

    const unknown = await send(formFields("nobody-history@example.com", "owned-history-vault"), vault);
    expect(unknown.res.status).toBe(404);
    expect(await unknown.res.json()).toMatchObject({ error: "account_not_found" });

    const notOwner = await send(formFields("other-history@example.com", "owned-history-vault"), vault);
    expect(notOwner.res.status).toBe(409);
    expect(await notOwner.res.json()).toMatchObject({ error: "not_this_account" });

    const noVault = await send(formFields("owner-history@example.com", "no-such-history-vault"), vault);
    expect(noVault.res.status).toBe(404);

    await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?").bind(new Date().toISOString(), other).run();
    await seedVault("suspended-history-vault", other);
    const suspended = await send(formFields("other-history@example.com", "suspended-history-vault"), vault);
    expect(suspended.res.status).toBe(409);
    expect(await suspended.res.json()).toMatchObject({ error: "account_suspended" });

    // The address twice, a reference with no address, no stray fields, dry_run as "true"/"false", the stated counts,
    // and the batch as a file part.
    const refusals: Array<[string, Record<string, string>, string | null]> = [
      ["confirm differs", fields({ confirm: "x@example.com" }), BATCH_BYTES],
      ["address in reference", fields({ reference: "ask owner@example.com" }), BATCH_BYTES],
      ["stray field", fields({ dryrun: "true" }), BATCH_BYTES],
      ["dry_run not a word", fields({ dry_run: "yes" }), BATCH_BYTES],
      ["run_id short", fields({ run_id: "abc" }), BATCH_BYTES],
      ["notes not a count", fields({ notes: "-1" }), BATCH_BYTES],
      ["versions missing", (({ versions: _v, ...rest }) => rest)(fields()), BATCH_BYTES],
      ["blobs not a count", fields({ blobs: "1.5" }), BATCH_BYTES],
      ["no batch", fields(), null],
      ["empty batch", fields(), ""],
    ];
    for (const [why, f, batch] of refusals) {
      const r = await send(f, vault, batch);
      expect(r.res.status, why).toBe(400);
    }
    // The batch as a text field, not a file.
    const form = new FormData();
    for (const [k, v] of Object.entries(fields())) form.set(k, v);
    form.set("batch", BATCH_BYTES);
    const asText = await handleOpsHistoryImportPost(OPS_ENV, new Request(`${ISSUER}/ops/history-import`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: form }), withVault(vault));
    expect(asText!.status).toBe(400);
    // Not multipart at all.
    expect((await handleOpsHistoryImportPost(OPS_ENV, post("/ops/history-import", { ...fields(), batch: BATCH }), withVault(vault)))!.status).toBe(400);

    expect(vault.calls).toEqual([]);
    expect(await auditCount()).toBe(before);
  });

  test("a body with no declared length stops being read at the cap: 413, nothing forwarded or recorded", async () => {
    const { id } = await seedUser("chunked-history@example.com");
    await seedVault("chunked-history-vault", id);
    const before = await auditCount();
    const vault = fakeVault();
    // A real multipart body whose file part runs to 40 MiB, sent as a stream (no content-length).
    const boundary = "made-up-boundary";
    const enc = new TextEncoder();
    const head = Object.entries(formFields("chunked-history@example.com", "chunked-history-vault"))
      .map(([k, v]) => `--${boundary}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
      .join("") + `--${boundary}\r\ncontent-disposition: form-data; name="batch"; filename="batch.json"\r\ncontent-type: application/json\r\n\r\n`;
    let pulled = 0;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent === 0) c.enqueue(enc.encode(head));
        if (sent < 40) {
          // A fresh buffer each time: an enqueued one is handed over to the reader.
          const chunk = new Uint8Array(1024 * 1024).fill(0x20);
          pulled += chunk.byteLength;
          c.enqueue(chunk);
        } else {
          c.enqueue(enc.encode(`\r\n--${boundary}--\r\n`));
          c.close();
        }
        sent++;
      },
    });
    const req = new Request(`${ISSUER}/ops/history-import`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: "half",
    } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await handleOpsHistoryImportPost(OPS_ENV, req, withVault(vault));
    expect(res!.status).toBe(413);
    expect(pulled).toBeLessThan(20 * 1024 * 1024);
    expect(vault.calls).toEqual([]);
    expect(await auditCount()).toBe(before);
  });

  test("a dry run forwards the batch's bytes untouched with ?dry_run=true and records nothing; a real batch records one row first, then forwards", async () => {
    const { id } = await seedUser("move-history@example.com");
    await seedVault("move-history-vault", id);
    const before = await auditCount();

    const dryVault = fakeVault(() => j({ dry_run: true, totals: { grafted: 1 }, versions_written: 2, blobs_written: 1, database_bytes_before: 10, database_bytes: 20, notes_cap_bytes: null }));
    const dry = await send(formFields("move-history@example.com", "move-history-vault", { dry_run: "true" }), dryVault);
    expect(dry.res.status).toBe(200);
    expect(await dry.res.json()).toMatchObject({ dry_run: true });
    expect(dryVault.calls).toHaveLength(1);
    expect(dryVault.calls[0]).toMatchObject({ method: "POST", path: "/api/internal/history-import", query: `?run_id=${RUN_ID}&dry_run=true`, contentType: "application/json", raw: BATCH_BYTES });
    expect(await auditCount()).toBe(before);

    // The audit row must exist before the vault is called.
    let rowsAtCall = -1;
    const vault = fakeVault(async () => {
      rowsAtCall = await auditCount();
      return j({ dry_run: false, notes: [{ id: NOTE_ID, outcome: "grafted" }], totals: { grafted: 1, note_changed: 0 }, versions_written: 2, blobs_written: 1, database_bytes_before: 1000, database_bytes: 2000, notes_cap_bytes: 5000 });
    });
    const real = await send(formFields("move-history@example.com", "move-history-vault", { dry_run: "false" }), vault);
    expect(real.res.status).toBe(200);
    expect(await real.res.json()).toMatchObject({ totals: { grafted: 1 } });
    expect(vault.calls.map((c) => [c.method, c.path, c.query])).toEqual([["POST", "/api/internal/history-import", `?run_id=${RUN_ID}`]]);
    expect(vault.calls[0]!.raw).toBe(BATCH_BYTES);
    // A first-party admin mint for this vault: the vault's internal gate needs exactly that.
    const claims = decodeJwtPayload(vault.calls[0]!.auth.replace(/^Bearer /, ""));
    expect(claims).toMatchObject({ client_id: "parachute-console", scope: "vault:move-history-vault:admin", sub: id });
    expect(rowsAtCall).toBe(before + 1);

    const rows = (await auditRowsFor(env.DB, id)).filter((r) => r.action === "history_import_batch");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("operator:ops-agent");
    // The counts are what the client said: named stated_* so nobody reads them as checked.
    expect(rows[0]!.note).toEqual({ vault: "move-history-vault", reference: REF, run: RUN_ID.slice(0, 12), stated_notes: 1, stated_versions: 2, stated_blobs: 1 });
    expect(JSON.stringify(rows[0]!.note)).not.toContain(NOTE_ID);
    // Counts only in the logs: no address, no note id; the vault's real totals after it answered.
    expect(logged.join("\n")).not.toContain("move-history@example.com");
    expect(logged.join("\n")).not.toContain(NOTE_ID);
    const line = logged.find((l) => l.includes("event=ops_history_import ") && l.includes("dry_run=false"));
    expect(line).toBeDefined();
    expect(line).toContain("stated_notes=1 stated_versions=2 stated_blobs=1");
    expect(line).toContain("status=200 notes=1 grafted=1 versions_written=2 blobs_written=1 database_bytes=2000");

    // The vault's refusal passes through as it is.
    const refusing = fakeVault(() => j({ error: "A blob does not match its hash", error_type: "blob_invalid", hash: "e".repeat(64) }, 400));
    const bad = await send(formFields("move-history@example.com", "move-history-vault"), refusing);
    expect(bad.res.status).toBe(400);
    expect(await bad.res.json()).toMatchObject({ error_type: "blob_invalid" });
  });

  test("status and digest take the same consent as the batch door and record nothing; finish records and forwards, a dry finish only reads", async () => {
    const { id } = await seedUser("finish-history@example.com");
    await seedUser("stranger-history@example.com");
    await seedVault("finish-history-vault", id);
    const status = { runs: [{ run_id: RUN_ID, status: "applying", receipts: 3 }], imported_versions: 5, native_versions: 2, refs: 5, keep_all: true };
    const vault = fakeVault((path, body) => {
      if (path === "/api/internal/history-import") return j(status);
      if (path === "/api/internal/history-digest") return j({ notes: (body as any).notes.map((n: any) => ({ id: n.id, found: true, versions: 2, digest: "5".repeat(64), content_ok: true })) });
      if (path === "/api/internal/history-import/finish") return j({ run_id: RUN_ID, status: "complete", receipts: 3 });
      return j({}, 404);
    });
    const who = person("finish-history@example.com", "finish-history-vault");
    const before = await auditCount();
    const st = await handleOpsHistoryImportStatus(OPS_ENV, post("/ops/history-import/status", who), withVault(vault));
    expect(st!.status).toBe(200);
    expect(await st!.json()).toEqual(status);
    const dg = await handleOpsHistoryImportDigest(OPS_ENV, post("/ops/history-import/digest", { ...who, notes: [{ id: NOTE_ID, through_ix: 0 }] }), withVault(vault));
    expect(await dg!.json()).toMatchObject({ notes: [{ id: NOTE_ID, content_ok: true }] });
    expect(await auditCount()).toBe(before);

    // Another account's vault, a missing or mismatched field, a stray one: refused, nothing forwarded.
    const callsBefore = vault.calls.length;
    const stranger = person("stranger-history@example.com", "finish-history-vault");
    const { reference: _r, ...noReference } = who;
    const reads: Array<[string, typeof handleOpsHistoryImportStatus, object, number]> = [
      ["/ops/history-import/status", handleOpsHistoryImportStatus, stranger, 409],
      ["/ops/history-import/digest", handleOpsHistoryImportDigest, { ...stranger, notes: [] }, 409],
      ["/ops/history-import/status", handleOpsHistoryImportStatus, { vault_name: "finish-history-vault" }, 400],
      ["/ops/history-import/digest", handleOpsHistoryImportDigest, { vault_name: "finish-history-vault", notes: [] }, 400],
      ["/ops/history-import/status", handleOpsHistoryImportStatus, noReference, 400],
      ["/ops/history-import/digest", handleOpsHistoryImportDigest, { ...who, confirm: "x@example.com", notes: [] }, 400],
      ["/ops/history-import/status", handleOpsHistoryImportStatus, { ...who, extra: 1 }, 400],
    ];
    for (const [path, door, body, code] of reads) {
      const r = await door(OPS_ENV, post(path, body), withVault(vault));
      expect(r!.status, `${path} ${JSON.stringify(Object.keys(body))}`).toBe(code);
    }
    expect(vault.calls.length).toBe(callsBefore);
    expect(await auditCount()).toBe(before);

    const finishFields = { ...who, run_id: RUN_ID, expect_receipts: 3 };
    const dry = await handleOpsHistoryImportFinish(OPS_ENV, post("/ops/history-import/finish", { ...finishFields, dry_run: true }), withVault(vault));
    expect(await dry!.json()).toEqual({ dry_run: true, would_finish: true, run_id: RUN_ID, status: "applying", receipts: 3 });
    expect(await auditCount()).toBe(before);

    // A run the vault does not hold: 404, and no audit row for a run that never was.
    const noRun = await handleOpsHistoryImportFinish(OPS_ENV, post("/ops/history-import/finish", { ...finishFields, run_id: "b".repeat(64), expect_receipts: 0 }), withVault(vault));
    expect(noRun!.status).toBe(404);
    expect(await noRun!.json()).toMatchObject({ error: "run_not_found" });
    expect(await auditCount()).toBe(before);
    expect(vault.calls.at(-1)!.path).toBe("/api/internal/history-import");
    // A status answer the door can't read is not taken as "no run".
    const garbled = fakeVault(() => new Response("not json", { status: 200 }));
    const unread = await handleOpsHistoryImportFinish(OPS_ENV, post("/ops/history-import/finish", finishFields), withVault(garbled));
    expect(unread!.status).toBe(502);
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
    expect((await send(formFields("purge-history@example.com", "purge-history-vault"))).res.status).toBe(200);
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
    expect(rows[0]!.note).toEqual({ run: RUN_ID.slice(0, 12), stated_notes: 1, stated_versions: 2, stated_blobs: 1 });
  });
});
