/**
 * POST /ops/vault-import and its follow-ups (T-379): the operator agent moves a
 * person's vault into their existing account, against real miniflare D1. The
 * vault worker is the one system faked here (a separate Worker; its side is
 * pinned in workers/vault/test/import-file.test.ts and import-lock.test.ts, and
 * the whole path runs on staging).
 *
 *   - bearer OPS_RUN_TOKEN only; unset → the router's 404;
 *   - it only ever creates a NEW vault in an account that already exists;
 *   - every step writes its audit row, with no address in it or in the logs;
 *   - the vault stays operator-pending until /finish, and only then is it the
 *     person's plain vault: no more files, tokens or retries from the operator.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/index.ts";
import { auditRowsFor } from "../src/account-audit.ts";
import { handleImportPost } from "../src/console.ts";
import type { OAuthDeps } from "../src/oauth-shared.ts";
import {
  handleOpsVaultImportAbort,
  handleOpsVaultImportFile,
  handleOpsVaultImportFinish,
  handleOpsVaultImportPost,
  handleOpsVaultImportReadToken,
  handleOpsVaultImportStatus,
} from "../src/ops-vault-import.ts";
import { requestAccountDeletion, runAccountDeleteSweep } from "../src/account-delete.ts";
import { getUserById } from "../src/users.ts";
import { createVault, getVault } from "../src/vaults.ts";
import { CSRF, ISSUER, decodeJwtPayload, deps, seedSession, seedUser, seedVault } from "./helpers.ts";

type VaultFetch = NonNullable<OAuthDeps["vaultFetch"]>;
const TOKEN = "ops-run-test-token";
const REF = "T-379 move day";
const TAR = new Uint8Array([1, 2, 3, 4]);
const OPS_ENV = { ...env, OPS_RUN_TOKEN: TOKEN };
const j = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

interface VaultScript {
  import?: () => Response | Promise<Response>;
  status?: (importId: string) => unknown;
  check?: () => unknown;
  destroy?: () => Response;
  patch?: () => Response;
  /** What GET /api/vault answers for the description read-back. */
  description?: () => string;
}

/** Records every call to the vault worker and answers as a healthy one would. */
function fakeVault(script: VaultScript = {}) {
  const calls: Array<{ path: string; method: string; auth: string; body?: unknown; ifUnwritten?: string | null }> = [];
  let importId = "";
  let stored = "";
  const vaultFetch: VaultFetch = async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace(/^\/vault\/[^/]+/, "");
    const call = {
      path,
      method: req.method,
      auth: req.headers.get("authorization") ?? "",
      body: undefined as unknown,
      ifUnwritten: req.headers.get("x-parachute-import-if-unwritten"),
    };
    calls.push(call);
    if (path === "/api/internal/import") {
      importId = req.headers.get("x-parachute-import-id") ?? "";
      call.body = new Uint8Array(await req.arrayBuffer());
      return script.import ? script.import() : j({ imported: true, notes: 2705, stats: { skipped_attachments: 42 } });
    }
    if (path === "/api/internal/import-status") {
      const s = script.status ? script.status(importId) : { state: "done", kind: "import", import_id: importId, notes: 2705, skipped_attachments: 42 };
      return s instanceof Response ? s : j(s);
    }
    if (path === "/api/internal/import-check") {
      const c = script.check ? script.check() : { notes: 2705, attachments: 42, files_stored: 42, missing_files: 0, written_since_import: false, r2_bytes: 44_000_000 };
      return c instanceof Response ? c : j(c);
    }
    if (path === "/api/internal/import-file") {
      const form = await req.formData();
      call.body = { path: form.get("path"), sha256: form.get("sha256"), size: (form.get("file") as unknown as File).size };
      return j({ written: true, size: (form.get("file") as unknown as File).size }, 201);
    }
    if (path === "/api/internal/destroy") {
      call.body = await req.json();
      return script.destroy ? script.destroy() : j({ destroyed: true, r2_objects_deleted: 2 });
    }
    if (path === "/api/vault") {
      if (req.method === "GET") return j({ description: script.description ? script.description() : stored });
      call.body = await req.json();
      stored = (call.body as { description: string }).description;
      return script.patch ? script.patch() : j({ ok: true });
    }
    return j({ ok: true });
  };
  return { vaultFetch, calls, paths: () => calls.map((c) => c.path) };
}

function importForm(fields: Record<string, string | undefined>, tar: Uint8Array | null = TAR): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) f.set(k, v);
  if (tar) f.set("tarball", new File([tar], "export.tar", { type: "application/x-tar" }));
  return f;
}

const person = (email: string, vault: string, extra: Record<string, string> = {}) => ({
  email,
  confirm: email,
  vault_name: vault,
  reference: REF,
  ...extra,
});

function post(path: string, body: FormData | object, auth: string | null = `Bearer ${TOKEN}`): Request {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = auth;
  if (body instanceof FormData) return new Request(`${ISSUER}${path}`, { method: "POST", headers, body });
  headers["content-type"] = "application/json";
  return new Request(`${ISSUER}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const withVault = (v: { vaultFetch: VaultFetch }): OAuthDeps => ({ ...deps(), vaultFetch: v.vaultFetch });

async function runImport(fields: Record<string, string | undefined>, vault = fakeVault(), tar: Uint8Array | null = TAR) {
  const res = await handleOpsVaultImportPost(OPS_ENV, post("/ops/vault-import", importForm(fields, tar)), withVault(vault));
  return { res: res!, vault, body: (await res!.clone().json()) as Record<string, any> };
}

async function finish(fields: Record<string, unknown>, vault = fakeVault()) {
  const res = await handleOpsVaultImportFinish(OPS_ENV, post("/ops/vault-import/finish", fields), withVault(vault));
  return { res: res!, body: (await res!.clone().json()) as Record<string, any> };
}

async function auditCount(): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM account_audit").first<{ n: number }>())!.n;
}

/** Everything the worker logged during a test, to prove no address reaches the logs. */
let logged: string[] = [];
beforeEach(() => {
  logged = [];
  for (const m of ["log", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  }
});
afterEach(() => vi.restoreAllMocks());

describe("/ops/vault-import — the gate", () => {
  test("unset secret → the router's 404; no bearer, a wrong one or another door's → 401; nothing moves", async () => {
    const { id } = await seedUser("gate-import@example.com");
    const fields = person("gate-import@example.com", "gate-vault");
    const vault = fakeVault();
    const auditBefore = await auditCount();

    const unset = await app.fetch(post("/ops/vault-import", importForm(fields)), { ...env });
    expect(unset.status).toBe(404);
    expect(await handleOpsVaultImportPost({ ...env }, post("/ops/vault-import", importForm(fields)), withVault(vault))).toBeNull();

    for (const auth of [null, `Bearer ${TOKEN}x`, "Bearer delete-token", "Bearer read-token"]) {
      const e = { ...OPS_ENV, OPS_DELETE_TOKEN: "delete-token", OPS_READ_TOKEN: "read-token" };
      const r = await handleOpsVaultImportPost(e, post("/ops/vault-import", importForm(fields), auth), withVault(vault));
      expect(r!.status).toBe(401);
    }
    // Every follow-up door has the same gate.
    const doors: Array<[string, (e: typeof env, r: Request, d: OAuthDeps) => Promise<Response | null>, FormData | object]> = [
      ["/ops/vault-import/file", handleOpsVaultImportFile, importForm({ vault_name: "gate-vault" })],
      ["/ops/vault-import/status", handleOpsVaultImportStatus, { vault_name: "gate-vault" }],
      ["/ops/vault-import/read-token", handleOpsVaultImportReadToken, { vault_name: "gate-vault" }],
      ["/ops/vault-import/finish", handleOpsVaultImportFinish, fields],
      ["/ops/vault-import/abort", handleOpsVaultImportAbort, fields],
    ];
    for (const [path, door, body] of doors) {
      expect(await door({ ...env }, post(path, body), withVault(vault))).toBeNull();
      expect((await app.fetch(post(path, body), { ...env })).status).toBe(404);
      expect((await door(OPS_ENV, post(path, body, null), withVault(vault)))!.status).toBe(401);
    }
    expect(vault.calls).toEqual([]);
    expect(await getVault(env.DB, "gate-vault")).toBeNull();
    expect(await auditCount()).toBe(auditBefore);
    expect(id).toBeTruthy();
  });

  test("the router reaches the handler with the secret set (a dry run touches nothing)", async () => {
    await seedUser("wired-import@example.com");
    const res = await app.fetch(
      post("/ops/vault-import", importForm(person("wired-import@example.com", "wired-vault", { dry_run: "true" }), null)),
      OPS_ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dry_run: true, account_found: true, vault_name: "wired-vault", retry: false });
  });

  test("an unknown email is refused and no account or vault appears", async () => {
    const users = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())!.n;
    const before = await users();
    const { res, body, vault } = await runImport(person("nobody-here@example.com", "nobody-vault"));
    expect(res.status).toBe(404);
    expect(body.error).toBe("account_not_found");
    expect(await users()).toBe(before);
    expect(await getVault(env.DB, "nobody-vault")).toBeNull();
    expect(vault.calls).toEqual([]);
    expect(logged.join("\n")).not.toContain("nobody-here@example.com");
  });

  test("an account that is closing, suspended or unproven is refused", async () => {
    const { id: closing } = await seedUser("closing-import@example.com");
    await env.DB.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), closing).run();
    const { id: suspended } = await seedUser("suspended-import@example.com");
    await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?").bind(new Date().toISOString(), suspended).run();
    const { id: unproven } = await seedUser("unproven-import@example.com");
    await env.DB.prepare("UPDATE users SET email_verified = 0 WHERE id = ?").bind(unproven).run();
    for (const [email, error] of [
      ["closing-import@example.com", "account_closing"],
      ["suspended-import@example.com", "account_suspended"],
      ["unproven-import@example.com", "account_unverified"],
    ] as const) {
      const { res, body, vault } = await runImport(person(email, `v-${error.replace(/_/g, "-")}`));
      expect(res.status).toBe(409);
      expect(body.error).toBe(error);
      expect(vault.calls).toEqual([]);
      expect(await getVault(env.DB, `v-${error.replace(/_/g, "-")}`)).toBeNull();
    }
  });

  test("the body takes exactly its fields: the address twice, a reference, a real dry_run", async () => {
    await seedUser("fields-import@example.com");
    const base = person("fields-import@example.com", "fields-vault");
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ ...base, confirm: "other@example.com" }, "confirm_mismatch"],
      [{ ...base, reference: "ab" }, "reference_required"],
      [{ ...base, reference: "asked by adam@example.com" }, "reference_required"],
      [{ ...base, dryRun: "true" }, "invalid_request"],
      [{ ...base, description: "belongs to /finish" }, "invalid_request"],
      [{ ...base, dry_run: "yes" }, "invalid_request"],
      [{ ...base, email: "not an address", confirm: "not an address" }, "invalid_request"],
      [{ ...base, vault_name: "Not A Slug!" }, "vault_name_invalid"],
    ];
    for (const [fields, error] of cases) {
      const { res, body, vault } = await runImport(fields);
      expect(res.status, error).toBe(400);
      expect(body.error).toBe(error);
      expect(vault.calls).toEqual([]);
    }
    expect(await getVault(env.DB, "fields-vault")).toBeNull();
    // A missing or empty export is refused too (only a dry run may omit it).
    expect((await runImport(base, fakeVault(), null)).body.error).toBe("tarball_required");
    expect((await runImport(base, fakeVault(), new Uint8Array(0))).body.error).toBe("tarball_required");
    expect(await getVault(env.DB, "fields-vault")).toBeNull();
  });

  test("an existing vault name is refused: never a write into an existing vault", async () => {
    const { id: owner } = await seedUser("existing-import@example.com");
    const { id: other } = await seedUser("existing-other@example.com");
    await seedVault("own-real-vault", owner);
    await seedVault("someone-elses", other);
    await createVault(env.DB, "own-console-retry", owner, new Date(), { importPending: true });
    await createVault(env.DB, "own-restore", owner, new Date(), { pending: "restore" });
    await createVault(env.DB, "other-operator", other, new Date(), { pending: "operator" });
    for (const name of ["own-real-vault", "someone-elses", "own-console-retry", "own-restore", "other-operator"]) {
      const before = await getVault(env.DB, name);
      for (const extra of [{}, { dry_run: "true" }] as Array<Record<string, string>>) {
        const { res, body, vault } = await runImport(person("existing-import@example.com", name, extra));
        expect(res.status, name).toBe(409);
        expect(body.error).toBe("vault_name_taken");
        expect(vault.calls).toEqual([]);
      }
      expect(await getVault(env.DB, name)).toEqual(before);
    }
  });

  test("the plan's vault count applies, as at the console", async () => {
    const { id } = await seedUser("cap-import@example.com");
    await env.DB.prepare("UPDATE users SET plan = 'expired' WHERE id = ?").bind(id).run();
    const { res, body, vault } = await runImport(person("cap-import@example.com", "cap-vault"));
    expect(res.status).toBe(409);
    expect(body.error).toBe("vault_cap");
    expect(vault.calls).toEqual([]);
    expect(await getVault(env.DB, "cap-vault")).toBeNull();
  });

  test("dry_run reads only", async () => {
    const { id } = await seedUser("dry-import@example.com");
    const before = await auditCount();
    const { res, body, vault } = await runImport(person("dry-import@example.com", "dry-vault", { dry_run: "true" }), fakeVault(), null);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ dry_run: true, account_found: true, vault_name: "dry-vault", retry: false, vaults_owned: 0 });
    expect(body.vault_limit).toBeGreaterThan(0);
    expect(vault.calls).toEqual([]);
    expect(await getVault(env.DB, "dry-vault")).toBeNull();
    expect(await auditCount()).toBe(before);
    expect((await auditRowsFor(env.DB, id)).length).toBe(0);
  });
});

describe("/ops/vault-import — the import", () => {
  test("creates the vault owned by the named account, operator-pending, and writes the audit row", async () => {
    const { id } = await seedUser("owner-import@example.com");
    const { res, body, vault } = await runImport(person("OWNER-import@example.com ".toLowerCase().trim(), "Owned-Vault"));
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ imported: true, vault_name: "owned-vault", notes: 2705, skipped_attachments: 42, retry: false });

    const row = await getVault(env.DB, "owned-vault");
    expect(row?.ownerUserId).toBe(id);
    expect(row?.importPendingAt).toMatch(/^operator:/);

    // The tar reached the vault as is, through the platform's own short-lived token.
    const imp = vault.calls.find((c) => c.path === "/api/internal/import")!;
    expect(imp.body).toEqual(TAR);
    expect(imp.ifUnwritten).toBe("1");
    const claims = decodeJwtPayload(imp.auth.replace("Bearer ", ""));
    expect(claims.sub).toBe(id);
    expect(claims.scope).toBe("vault:owned-vault:admin");
    // A new vault gets its plan's caps before the tar goes in.
    expect(vault.paths().indexOf("/api/internal/config")).toBeGreaterThanOrEqual(0);
    expect(vault.paths().indexOf("/api/internal/config")).toBeLessThan(vault.paths().indexOf("/api/internal/import"));

    // Who, when, which account (hashed), which vault, counts; never an address.
    const rows = await auditRowsFor(env.DB, id);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      actor: "operator:ops-agent",
      action: "vault_import_started",
      note: { vault: "owned-vault", reference: REF, tar_bytes: TAR.length, retry: false },
    });
    expect(rows[0]!.at).toMatch(/^\d{4}-/);
    const raw = await env.DB.prepare("SELECT target_hash, note FROM account_audit WHERE action = 'vault_import_started' AND instr(note, 'owned-vault') > 0").first<{ target_hash: string; note: string }>();
    expect(`${raw!.target_hash} ${raw!.note}`).not.toContain("owner-import@example.com");
    expect(`${raw!.target_hash} ${raw!.note}`).not.toContain(id);
    expect(logged.join("\n")).not.toContain("owner-import@example.com");
    expect(JSON.stringify(body)).not.toContain("owner-import@example.com");
  });

  test("an unreadable tar is reported as such; the name stays reserved for a retry", async () => {
    await seedUser("bad-tar@example.com");
    const { res, body } = await runImport(person("bad-tar@example.com", "bad-tar-vault"), fakeVault({
      import: () => j({ error: "Not a readable Parachute export", error_type: "import_unreadable" }, 400),
    }));
    expect(res.status).toBe(400);
    expect(body.error).toBe("import_unreadable");
    expect((await getVault(env.DB, "bad-tar-vault"))?.importPendingAt).toMatch(/^operator:/);
  });

  test("an import that errored but landed counts as landed, by THIS attempt's record", async () => {
    await seedUser("landed-op@example.com");
    const { res, body } = await runImport(person("landed-op@example.com", "landed-op-vault"), fakeVault({
      import: () => {
        throw new Error("Durable Object reset because it exceeded its memory limit");
      },
      status: (id) => ({ state: "done", kind: "import", import_id: id, notes: 2705, skipped_attachments: 42 }),
    }));
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ imported: true, notes: 2705, skipped_attachments: 42 });
  });

  test("a failed import keeps the name; a retry reuses the row and converges, and says so in the audit", async () => {
    const { id } = await seedUser("retry-op@example.com");
    const fields = person("retry-op@example.com", "retry-op-vault");
    const failing = await runImport(fields, fakeVault({
      import: () => j({ error: "boom" }, 500),
      status: () => ({ state: "failed", error_type: "exception" }),
    }));
    expect(failing.res.status).toBe(502);
    expect(failing.body.error).toBe("import_failed");
    const row = await getVault(env.DB, "retry-op-vault");
    expect(row?.ownerUserId).toBe(id);
    expect(row?.importPendingAt).toMatch(/^operator:/);

    const dry = await runImport({ ...fields, dry_run: "true" }, fakeVault(), null);
    expect(dry.body).toMatchObject({ dry_run: true, retry: true });

    const second = await runImport(fields);
    expect(second.res.status).toBe(200);
    expect(second.body).toMatchObject({ imported: true, retry: true });
    expect((await getVault(env.DB, "retry-op-vault"))?.vaultId).toBe(row?.vaultId);
    const rows = (await auditRowsFor(env.DB, id)).filter((r) => r.action === "vault_import_started");
    expect(rows.map((r) => r.note?.retry)).toEqual([false, true]);
    // A retry pushes the caps again: a first attempt's push is best-effort.
    expect(second.vault.paths()).toContain("/api/internal/config");
  });

  test("a retry never replaces what the person wrote: refused, dry run too, nothing sent", async () => {
    const { id } = await seedUser("written-op@example.com");
    const fields = person("written-op@example.com", "written-op-vault");
    expect((await runImport(fields)).res.status).toBe(200);
    const auditBefore = (await auditRowsFor(env.DB, id)).length;

    for (const extra of [{}, { dry_run: "true" }] as Array<Record<string, string>>) {
      const v = fakeVault({ check: () => ({ notes: 2706, attachments: 42, files_stored: 42, missing_files: 0, written_since_import: true, r2_bytes: 1 }) });
      const { res, body } = await runImport({ ...fields, ...extra }, v);
      expect(res.status).toBe(409);
      expect(body).toMatchObject({ error: "vault_in_use" });
      expect(v.paths()).not.toContain("/api/internal/import");
    }
    // The vault's own answer under its lock wins over the check before it (a write in between).
    const raced = fakeVault({ import: () => j({ error: "written", error_type: "vault_in_use" }, 409) });
    const late = await runImport(fields, raced);
    expect(late.res.status).toBe(409);
    expect(late.body.error).toBe("vault_in_use");
    expect(raced.calls.find((c) => c.path === "/api/internal/import")?.body).toBeDefined();
    // Can't tell (the vault won't answer) is a refusal too, not a replay.
    const blind = fakeVault({ check: () => j({ error: "boom" }, 500) });
    const unknown = await runImport(fields, blind);
    expect(unknown.res.status).toBe(409);
    expect(unknown.body.error).toBe("vault_state_unknown");
    expect(blind.paths()).not.toContain("/api/internal/import");
    // An answer with no word on it (an older vault worker) is the same.
    const old = fakeVault({ check: () => ({ notes: 3, attachments: 0, files_stored: 0, missing_files: 0, r2_bytes: 0 }) });
    expect((await runImport(fields, old)).body.error).toBe("vault_state_unknown");
    expect(old.paths()).not.toContain("/api/internal/import");
    // The one row is the raced attempt's, which had passed the first check.
    expect((await auditRowsFor(env.DB, id)).length).toBe(auditBefore + 1);
  });

  test("another attempt mid-replay: the door waits for it and takes its outcome", async () => {
    await seedUser("busy-op@example.com");
    let asks = 0;
    const { res, body } = await runImport(person("busy-op@example.com", "busy-op-vault"), fakeVault({
      import: () => j({ error: "This vault is being imported.", error_type: "import_in_progress" }, 503),
      status: () => (++asks === 1 ? { state: "running", kind: "import" } : { state: "done", kind: "import", import_id: "other", notes: 7, skipped_attachments: 0 }),
    }));
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ imported: true, notes: 7 });
    expect(asks).toBe(2);
  });

  test("the person's own console import can't replay over an operator-pending vault", async () => {
    const { id } = await seedUser("console-op@example.com");
    expect((await runImport(person("console-op@example.com", "console-op-vault"))).res.status).toBe(200);
    const session = await seedSession(id);
    const form = new FormData();
    form.set("__csrf", CSRF);
    form.set("vault_name", "console-op-vault");
    form.set("tarball", new File([TAR], "x.tar"));
    const vault = fakeVault();
    const res = await handleImportPost(
      env.DB,
      new Request(`${ISSUER}/console/vaults/import`, {
        method: "POST",
        headers: { origin: ISSUER, cookie: `parachute_id_session=${session}; parachute_id_csrf=${CSRF}` },
        body: form,
      }),
      withVault(vault),
    );
    expect(await res.text()).toContain("already taken");
    expect(vault.paths()).not.toContain("/api/internal/import");
  });
});

describe("/ops/vault-import/file, /status, /read-token", () => {
  async function pending(email: string, name: string): Promise<string> {
    const { id } = await seedUser(email);
    expect((await runImport(person(email, name))).res.status).toBe(200);
    return id;
  }

  function fileForm(fields: Record<string, string>, bytes = new Uint8Array([7, 7])): FormData {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    f.set("file", new File([bytes], "f"));
    return f;
  }

  const FILE = { path: "2026-01-01/a.png", sha256: "a".repeat(64) };

  test("a file goes to the vault's own import-file seam while the vault is operator-pending", async () => {
    await pending("file-op@example.com", "file-op-vault");
    const vault = fakeVault();
    const res = await handleOpsVaultImportFile(OPS_ENV, post("/ops/vault-import/file", fileForm({ vault_name: "file-op-vault", ...FILE })), withVault(vault));
    expect(res!.status).toBe(201);
    expect(await res!.json()).toMatchObject({ written: true, size: 2 });
    const call = vault.calls.find((c) => c.path === "/api/internal/import-file")!;
    expect(call.body).toEqual({ ...FILE, size: 2 });
    expect(logged.join("\n")).not.toContain(FILE.path);
  });

  test("no file, status detail or read token for a vault that isn't operator-pending", async () => {
    const { id } = await seedUser("real-op@example.com");
    await seedVault("real-op-vault", id);
    await createVault(env.DB, "console-pending", id, new Date(), { importPending: true });
    for (const name of ["real-op-vault", "console-pending"]) {
      const vault = fakeVault();
      const file = await handleOpsVaultImportFile(OPS_ENV, post("/ops/vault-import/file", fileForm({ vault_name: name, ...FILE })), withVault(vault));
      expect(file!.status).toBe(409);
      expect(await file!.json()).toMatchObject({ error: "not_operator_import" });
      const tok = await handleOpsVaultImportReadToken(OPS_ENV, post("/ops/vault-import/read-token", { vault_name: name }), withVault(vault));
      expect(tok!.status).toBe(409);
      const st = await handleOpsVaultImportStatus(OPS_ENV, post("/ops/vault-import/status", { vault_name: name }), withVault(vault));
      expect(st!.status).toBe(200);
      expect(await st!.json()).toEqual({ vault_name: name, operator_pending: false });
      expect(vault.calls).toEqual([]);
    }
    const gone = await handleOpsVaultImportStatus(OPS_ENV, post("/ops/vault-import/status", { vault_name: "no-such-vault" }), withVault(fakeVault()));
    expect(gone!.status).toBe(404);
  });

  test("status answers the replay's state and the file count, while pending", async () => {
    await pending("status-op@example.com", "status-op-vault");
    const res = await handleOpsVaultImportStatus(OPS_ENV, post("/ops/vault-import/status", { vault_name: "status-op-vault" }), withVault(fakeVault({
      status: () => ({ state: "done", notes: 3, skipped_attachments: 1 }),
      check: () => ({ notes: 3, attachments: 1, files_stored: 0, missing_files: 1, written_since_import: false, r2_bytes: 0 }),
    })));
    expect(await res!.json()).toMatchObject({
      vault_name: "status-op-vault",
      operator_pending: true,
      state: "done",
      notes: 3,
      attachments: 1,
      missing_files: 1,
    });
    // Mid-replay the vault refuses the file count; status still answers.
    const mid = await handleOpsVaultImportStatus(OPS_ENV, post("/ops/vault-import/status", { vault_name: "status-op-vault" }), withVault(fakeVault({
      status: () => ({ state: "running" }),
      check: () => j({ error_type: "import_in_progress" }, 503),
    })));
    expect(mid!.status).toBe(200);
    expect(await mid!.json()).toMatchObject({ operator_pending: true, state: "running" });
  });

  test("the read token reads this one vault, for five minutes, and is not the platform's", async () => {
    const id = await pending("token-op@example.com", "token-op-vault");
    const res = await handleOpsVaultImportReadToken(OPS_ENV, post("/ops/vault-import/read-token", { vault_name: "token-op-vault" }), withVault(fakeVault()));
    expect(res!.status).toBe(200);
    const { vault_token: token, expires_in: ttl } = (await res!.json()) as { vault_token: string; expires_in: number };
    expect(ttl).toBe(300);
    // The first attempt and any retry tell the vault to refuse if it was written.
    // Every mint is on the record.
    const minted = (await auditRowsFor(env.DB, id)).filter((r) => r.action === "vault_import_read_token");
    expect(minted.length).toBe(1);
    expect(minted[0]!.note).toMatchObject({ vault: "token-op-vault", expires_in: 300 });
    const c = decodeJwtPayload(token);
    expect(c.scope).toBe("vault:token-op-vault:read");
    expect(c.aud).toBe("vault.token-op-vault");
    expect(c.sub).toBe(id);
    expect(c.client_id).not.toBe("parachute-console");
    expect(logged.join("\n")).not.toContain(token);
  });
});

describe("once the person has written", () => {
  test("no read token and no abort: what they wrote stays theirs", async () => {
    const { id } = await seedUser("used-op@example.com");
    const fields = person("used-op@example.com", "used-op-vault");
    expect((await runImport(fields)).res.status).toBe(200);
    const used = () => fakeVault({ check: () => ({ notes: 2706, attachments: 42, files_stored: 42, missing_files: 0, written_since_import: true, r2_bytes: 1 }) });

    const tok = await handleOpsVaultImportReadToken(OPS_ENV, post("/ops/vault-import/read-token", { vault_name: "used-op-vault" }), withVault(used()));
    expect(tok!.status).toBe(409);
    expect(await tok!.json()).toMatchObject({ error: "vault_in_use" });

    for (const extra of [{}, { dry_run: true }]) {
      const v = used();
      const res = await handleOpsVaultImportAbort(OPS_ENV, post("/ops/vault-import/abort", { ...fields, ...extra }), withVault(v));
      expect(res!.status).toBe(409);
      expect(await res!.json()).toMatchObject({ error: "vault_in_use" });
      expect(v.paths()).not.toContain("/api/internal/destroy");
    }
    expect(await getVault(env.DB, "used-op-vault")).not.toBeNull();
    expect((await auditRowsFor(env.DB, id)).map((r) => r.action)).toEqual(["vault_import_started"]);
  });
});

describe("/ops/vault-import/finish and /abort", () => {
  async function pending(email: string, name: string): Promise<string> {
    const { id } = await seedUser(email);
    expect((await runImport(person(email, name))).res.status).toBe(200);
    return id;
  }

  test("a big import that errored but landed ends ready: no import-pending, the operator's doors closed", async () => {
    const { id } = await seedUser("ready-op@example.com");
    const fields = person("ready-op@example.com", "ready-op-vault");
    await runImport(fields, fakeVault({
      import: () => {
        throw new Error("Durable Object reset");
      },
      status: (importId) => ({ state: "done", kind: "import", import_id: importId, notes: 2705, skipped_attachments: 42 }),
    }));
    const { res, body } = await finish(fields);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ finished: true, vault_name: "ready-op-vault", notes: 2705, attachments: 42, missing_files: 0 });

    const row = await getVault(env.DB, "ready-op-vault");
    expect(row?.importPendingAt).toBeNull();
    expect(row?.ownerUserId).toBe(id);
    const rows = await auditRowsFor(env.DB, id);
    expect(rows.map((r) => r.action)).toEqual(["vault_import_started", "vault_import_finished"]);
    expect(rows[1]).toMatchObject({
      actor: "operator:ops-agent",
      note: { vault: "ready-op-vault", reference: REF, notes: 2705, attachments: 42, missing_files: 0 },
    });

    // It is the person's plain vault now: the operator can't touch it again.
    const vault = fakeVault();
    expect((await runImport(fields, vault)).body.error).toBe("vault_name_taken");
    expect((await finish(fields, vault)).res.status).toBe(409);
    const form = new FormData();
    form.set("vault_name", "ready-op-vault");
    form.set("path", "p");
    form.set("sha256", "a".repeat(64));
    form.set("file", new File([TAR], "f"));
    expect((await handleOpsVaultImportFile(OPS_ENV, post("/ops/vault-import/file", form), withVault(vault)))!.status).toBe(409);
    expect((await handleOpsVaultImportReadToken(OPS_ENV, post("/ops/vault-import/read-token", { vault_name: "ready-op-vault" }), withVault(vault)))!.status).toBe(409);
    expect((await handleOpsVaultImportAbort(OPS_ENV, post("/ops/vault-import/abort", fields), withVault(vault)))!.status).toBe(409);
    expect(vault.calls).toEqual([]);
  });

  test("finish refuses until the replay is done and every file is there; a known gap must be named exactly", async () => {
    await pending("gap-op@example.com", "gap-op-vault");
    const fields = person("gap-op@example.com", "gap-op-vault");
    const notDone = await finish(fields, fakeVault({ status: () => ({ state: "interrupted" }) }));
    expect(notDone.res.status).toBe(409);
    expect(notDone.body.error).toBe("import_not_done");

    const gap = () => fakeVault({ check: () => ({ notes: 3, attachments: 5, files_stored: 3, missing_files: 2, written_since_import: false, r2_bytes: 9 }) });
    const missing = await finish(fields, gap());
    expect(missing.res.status).toBe(409);
    expect(missing.body).toMatchObject({ error: "files_missing", missing_files: 2 });
    expect((await finish({ ...fields, allow_missing_files: 1 }, gap())).res.status).toBe(409);
    expect((await getVault(env.DB, "gap-op-vault"))?.importPendingAt).toMatch(/^operator:/);

    expect((await finish({ ...fields, dry_run: "true" }, gap())).res.status).toBe(400);
    const dry = await finish({ ...fields, allow_missing_files: 2, dry_run: true }, gap());
    expect(dry.res.status).toBe(200);
    expect(dry.body).toMatchObject({ dry_run: true, would_finish: true });
    expect((await getVault(env.DB, "gap-op-vault"))?.importPendingAt).toMatch(/^operator:/);

    const allowed = await finish({ ...fields, allow_missing_files: 2 }, gap());
    expect(allowed.res.status).toBe(200);
    expect(allowed.body).toMatchObject({ finished: true, missing_files: 2 });
    expect((await getVault(env.DB, "gap-op-vault"))?.importPendingAt).toBeNull();
  });

  test("finish puts the person's description back and reads it back; a failure refuses, the vault stays pending", async () => {
    await pending("desc-op@example.com", "desc-op-vault");
    const fields = person("desc-op@example.com", "desc-op-vault");

    const failing = await finish({ ...fields, description: "my own words" }, fakeVault({ patch: () => j({ error: "boom" }, 500) }));
    expect(failing.res.status).toBe(502);
    expect(failing.body.error).toBe("description_failed");
    expect((await getVault(env.DB, "desc-op-vault"))?.importPendingAt).toMatch(/^operator:/);

    const different = await finish({ ...fields, description: "my own words" }, fakeVault({ description: () => "stock text" }));
    expect(different.res.status).toBe(502);
    expect(different.body.error).toBe("description_failed");
    expect((await getVault(env.DB, "desc-op-vault"))?.importPendingAt).toMatch(/^operator:/);

    expect((await finish({ ...fields, description: "x".repeat(70_000) })).res.status).toBe(400);
    expect((await finish({ ...fields, description: 7 })).res.status).toBe(400);

    const dryVault = fakeVault();
    expect((await finish({ ...fields, description: "my own words", dry_run: true }, dryVault)).res.status).toBe(200);
    expect(dryVault.paths()).not.toContain("/api/vault");

    const v = fakeVault();
    const { res, body } = await finish({ ...fields, description: "my own words\n" }, v);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ finished: true, description_set: true });
    const patched = v.calls.find((c) => c.path === "/api/vault" && c.method === "PATCH")!;
    expect(patched.body).toEqual({ description: "my own words" });
    expect((await getVault(env.DB, "desc-op-vault"))?.importPendingAt).toBeNull();
  });

  test("finish never overwrites a description the person may have edited; it still finishes", async () => {
    await pending("edited-op@example.com", "edited-op-vault");
    const fields = person("edited-op@example.com", "edited-op-vault");
    const v = fakeVault({ check: () => ({ notes: 3, attachments: 0, files_stored: 0, missing_files: 0, written_since_import: true, r2_bytes: 0 }) });
    const { res, body } = await finish({ ...fields, description: "from the box" }, v);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ finished: true, description_set: false, written_since_import: true });
    expect(v.calls.filter((c) => c.path === "/api/vault")).toEqual([]);
    expect((await getVault(env.DB, "edited-op-vault"))?.importPendingAt).toBeNull();
  });

  test("finish and abort name the owner: another address gets 409 and nothing moves", async () => {
    await pending("named-op@example.com", "named-op-vault");
    await seedUser("not-owner@example.com");
    const wrong = person("not-owner@example.com", "named-op-vault");
    const vault = fakeVault();
    expect((await finish(wrong, vault)).res.status).toBe(409);
    expect((await handleOpsVaultImportAbort(OPS_ENV, post("/ops/vault-import/abort", wrong), withVault(vault)))!.status).toBe(409);
    const stranger = person("no-account@example.com", "named-op-vault");
    expect((await finish(stranger, vault)).res.status).toBe(404);
    expect(vault.calls).toEqual([]);
    expect((await getVault(env.DB, "named-op-vault"))?.importPendingAt).toMatch(/^operator:/);
    expect((await finish({ ...person("named-op@example.com", "named-op-vault"), confirm: "x@example.com" })).res.status).toBe(400);
  });

  test("abort destroys an operator-pending vault and frees the name; a failed destroy keeps the row", async () => {
    const id = await pending("abort-op@example.com", "abort-op-vault");
    const fields = person("abort-op@example.com", "abort-op-vault");

    // A write that lands between the door's check and the destroy: 409, and the row stays.
    const raced = await handleOpsVaultImportAbort(OPS_ENV, post("/ops/vault-import/abort", fields), withVault(fakeVault({ destroy: () => j({ error_type: "vault_in_use" }, 409) })));
    expect(raced!.status).toBe(409);
    expect(await raced!.json()).toMatchObject({ error: "vault_in_use" });
    expect(await getVault(env.DB, "abort-op-vault")).not.toBeNull();

    const dry = await handleOpsVaultImportAbort(OPS_ENV, post("/ops/vault-import/abort", { ...fields, dry_run: true }), withVault(fakeVault()));
    expect(await dry!.json()).toMatchObject({ dry_run: true, would_abort: true });
    expect(await getVault(env.DB, "abort-op-vault")).not.toBeNull();

    const failing = await handleOpsVaultImportAbort(OPS_ENV, post("/ops/vault-import/abort", fields), withVault(fakeVault({ destroy: () => j({ error: "boom" }, 500) })));
    expect(failing!.status).toBe(502);
    expect(await getVault(env.DB, "abort-op-vault")).not.toBeNull();

    const vault = fakeVault();
    const res = await handleOpsVaultImportAbort(OPS_ENV, post("/ops/vault-import/abort", fields), withVault(vault));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ aborted: true, r2_objects_deleted: 2 });
    // The vault gets the last word: it refuses under its own hold if it was written.
    expect(vault.calls.find((c) => c.path === "/api/internal/destroy")?.body).toEqual({ confirm: "abort-op-vault", if_unwritten: true });
    expect(await getVault(env.DB, "abort-op-vault")).toBeNull();
    const rows = await auditRowsFor(env.DB, id);
    // The record comes first: the failed try and the one that worked, then nothing to find.
    expect(rows.map((r) => r.action)).toEqual(["vault_import_started", "vault_import_abort", "vault_import_abort", "vault_import_abort"]);
    expect(rows[3]!.note).toMatchObject({ vault: "abort-op-vault", reference: REF });
  });

  test("erasing the account takes the vault name and reference out of the audit rows it keeps", async () => {
    const { id } = await seedUser("purge-op@example.com");
    const fields = person("purge-op@example.com", "purge-op-vault");
    expect((await runImport(fields)).res.status).toBe(200);
    expect((await finish(fields)).res.status).toBe(200);
    const d = { ...deps(), vaultFetch: fakeVault().vaultFetch };
    const user = (await getUserById(env.DB, id))!;
    const asked = await requestAccountDeletion(OPS_ENV, d, user, { actor: "self", notifyHolder: false });
    expect(asked.ok).toBe(true);
    const sweep = await runAccountDeleteSweep(OPS_ENV, d, new Date(), { onlyUserId: id, waiveWindow: true });
    expect(sweep.purged).toBe(1);

    const rows = (await auditRowsFor(env.DB, id)).filter((r) => r.action.startsWith("vault_import_"));
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(JSON.stringify(r.note)).not.toContain("purge-op-vault");
      expect(JSON.stringify(r.note)).not.toContain(REF);
      expect(r.note?.vault).toBeUndefined();
    }
    expect(rows[1]!.note).toMatchObject({ notes: 2705, attachments: 42 });
  });
});
