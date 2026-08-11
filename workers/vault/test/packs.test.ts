import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { freshVault, mintToken, op, base } from "./helpers.ts";
import { SELF } from "cloudflare:test";
import {
  SEED_PACK_NAMES,
  SURFACE_STARTER_CONTENT,
  SURFACE_STARTER_PATH,
  welcomePack,
} from "@openparachute/core/src/seed-packs.js";
import {
  CAPTURE_ANYTHING_PATH,
  CONNECT_AI_PATH,
  GETTING_STARTED_PATH,
  TAGS_GRAPH_PATH,
  WELCOME_PATH,
  YOURS_TO_KEEP_PATH,
} from "../src/welcome.ts";

/**
 * POST /api/packs/<name> — the on-demand seam for core's seed packs.
 * Surface Starter (opt-in, NOT default-seeded) is the motivating case; the
 * default packs are also applyable (harmless: idempotent per item). Auth is
 * `vault:admin` (isPackApply, cloud#134 A.1 review follow-up), NOT the
 * generic write tier: `applySeedPack` upserts tag schemas via the same core
 * call `PUT /api/tags/:name` is admin-gated for, so a write-tier token must
 * not be able to reach it through this side door. A read-only OR write-only
 * token is refused with the standard insufficient_scope envelope; an admin
 * token (or the operator bearer `op()` uses, which is admin-equivalent)
 * succeeds.
 */

async function listNotes(v: string): Promise<any[]> {
  const res = await op(v, "/api/notes?include_content=true");
  expect(res.status).toBe(200);
  return (await res.json()) as any[];
}

function applyPack(v: string, pack: string): Promise<Response> {
  return op(v, `/api/packs/${pack}`, { method: "POST" });
}

describe("POST /api/packs/:name", () => {
  it("surface-starter applies onto a fresh vault (not default-seeded)", async () => {
    const v = freshVault("p");
    // The default seed does NOT include Surface Starter.
    const before = await listNotes(v);
    expect(before.map((n) => n.path)).not.toContain(SURFACE_STARTER_PATH);

    const res = await applyPack(v, "surface-starter");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.pack).toBe("surface-starter");
    expect(body.applied).toEqual([SURFACE_STARTER_PATH]);
    expect(body.skipped).toEqual([]);
    // Surface Starter is a #guide too (guides-ring, vault#544) — it declares
    // GUIDE_TAG, so the applier upserts it and reports it.
    expect(body.tags).toEqual(["guide"]);

    // Byte-equal to core's pack content (no cloud-side fork).
    const after = await listNotes(v);
    const note = after.find((n) => n.path === SURFACE_STARTER_PATH)!;
    expect(note.content).toBe(SURFACE_STARTER_CONTENT);
  });

  it("re-applying is idempotent → {applied: [], skipped: [path]}", async () => {
    const v = freshVault("p");
    expect((await applyPack(v, "surface-starter")).status).toBe(200);
    const res = await applyPack(v, "surface-starter");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.applied).toEqual([]);
    expect(body.skipped).toEqual([SURFACE_STARTER_PATH]);
    expect((await listNotes(v)).filter((n) => n.path === SURFACE_STARTER_PATH)).toHaveLength(1);
  });

  it("re-applying never clobbers an edited note", async () => {
    const v = freshVault("p");
    await applyPack(v, "surface-starter");
    const note = (await listNotes(v)).find((n) => n.path === SURFACE_STARTER_PATH)!;
    const upd = await op(v, `/api/notes/${note.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Surface Starter\n\nOur own version.", force: true }),
    });
    expect(upd.status).toBe(200);

    const again = await applyPack(v, "surface-starter");
    expect(((await again.json()) as any).skipped).toEqual([SURFACE_STARTER_PATH]);
    const after = (await listNotes(v)).find((n) => n.path === SURFACE_STARTER_PATH)!;
    expect(after.content).toContain("Our own version.");
  });

  it("the default packs are re-applyable and converge (welcome + getting-started)", async () => {
    const v = freshVault("p");
    await op(v, "/api/health"); // materialize → default seed ran
    const w = (await (await applyPack(v, "welcome")).json()) as any;
    expect(w.applied).toEqual([]);
    expect(w.skipped.sort()).toEqual(
      [WELCOME_PATH, CAPTURE_ANYTHING_PATH, TAGS_GRAPH_PATH, CONNECT_AI_PATH, YOURS_TO_KEEP_PATH].sort(),
    );
    // upserts, idempotent — core's declared set (capture + guide + pinned).
    expect(w.tags).toEqual(welcomePack().tags.map((t) => t.name));
    const g = (await (await applyPack(v, "getting-started")).json()) as any;
    expect(g.applied).toEqual([]);
    expect(g.skipped).toEqual([GETTING_STARTED_PATH]);
    expect(await listNotes(v)).toHaveLength(6);
  });

  it("unknown pack → 404 listing the available names", async () => {
    const v = freshVault("p");
    const res = await applyPack(v, "nonsense");
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toContain("nonsense");
    expect(body.available).toEqual([...SEED_PACK_NAMES]);
  });

  it("GET → 405 (POST-only)", async () => {
    const v = freshVault("p");
    const res = await op(v, "/api/packs/surface-starter");
    expect(res.status).toBe(405);
  });

  it("a vault:<name>:admin JWT can apply (the console's mint seam, cloud#134 A.1)", async () => {
    const v = freshVault("p");
    const admin = await mintToken({ vault: v, scopes: `vault:${v}:admin`, vaultScope: [v] });
    const ok = await SELF.fetch(`${base(v)}/api/packs/surface-starter`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}` },
    });
    expect(ok.status).toBe(200);
    // Fresh vault → the pack lands (the JWT admin path is the console's seam).
    expect(((await ok.json()) as any).applied).toEqual([SURFACE_STARTER_PATH]);
  });

  it("an admin JWT with the console's NON-first-party pack-apply client_id still applies (cloud#134 A.1 hardening)", async () => {
    // "parachute-packs" mirrors PACK_APPLY_CLIENT_ID (workers/identity/src/
    // vault-call.ts) — the client_id the console's postVaultPackApply mint
    // stamps INSTEAD of FIRST_PARTY_CLIENT_ID ("parachute-console"), so a pack
    // token can never satisfy internalForbidden's platform check (pinned in
    // internal-config.test.ts). The REST scope gate for packs (isPackApply →
    // hasScopeForVault) never looks at client_id, so this must still succeed.
    const v = freshVault("p");
    const admin = await mintToken({
      vault: v,
      scopes: `vault:${v}:admin`,
      vaultScope: [v],
      clientId: "parachute-packs",
    });
    const ok = await SELF.fetch(`${base(v)}/api/packs/surface-starter`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}` },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).applied).toEqual([SURFACE_STARTER_PATH]);
  });

  it("a vault:<name>:write JWT is refused (insufficient_scope, vault:admin) — the cloud#134 A.1 review finding", async () => {
    const v = freshVault("p");
    const writer = await mintToken({ vault: v, scopes: `vault:${v}:write`, vaultScope: [v] });
    const before = await listNotes(v);
    const forbidden = await SELF.fetch(`${base(v)}/api/packs/surface-starter`, {
      method: "POST",
      headers: { Authorization: `Bearer ${writer}` },
    });
    expect(forbidden.status).toBe(403);
    const body = (await forbidden.json()) as any;
    expect(body.error_type).toBe("insufficient_scope");
    expect(body.required_scope).toBe("vault:admin");
    expect(body.granted_scopes).toContain(`vault:${v}:write`);
    // The refusal happened at the gate — no tag/note landed from the pack.
    expect(await listNotes(v)).toEqual(before);
  });

  it("read-only JWT → 403; no credentials → 401", async () => {
    const v = freshVault("p");
    const reader = await mintToken({ vault: v, scopes: `vault:${v}:read`, vaultScope: [v] });
    const forbidden = await SELF.fetch(`${base(v)}/api/packs/surface-starter`, {
      method: "POST",
      headers: { Authorization: `Bearer ${reader}` },
    });
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as any).error_type).toBe("insufficient_scope");

    const anon = await SELF.fetch(`${base(v)}/api/packs/surface-starter`, { method: "POST" });
    expect(anon.status).toBe(401);
  });

  it("the seeded Surface Starter shows up in export like any note", async () => {
    const v = freshVault("p");
    await applyPack(v, "surface-starter");
    const stub = env.VAULT.get(env.VAULT.idFromName(v));
    const entries = (await stub.exportEntries(v)) as { name: string; text: string }[];
    const entry = entries.find((e) => e.name === `${SURFACE_STARTER_PATH}.md`);
    expect(entry, "Surface Starter.md exported").toBeTruthy();
  });
});
