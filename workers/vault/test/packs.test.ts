import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { freshVault, mintToken, op, base } from "./helpers.ts";
import { SELF } from "cloudflare:test";
import {
  SEED_PACK_NAMES,
  SURFACE_STARTER_CONTENT,
  SURFACE_STARTER_PATH,
} from "@openparachute/core/src/seed-packs.js";
import { GETTING_STARTED_PATH, WELCOME_PATH } from "../src/welcome.ts";

/**
 * POST /api/packs/<name> — the on-demand seam for core's seed packs.
 * Surface Starter (opt-in, NOT default-seeded) is the motivating case; the
 * default packs are also applyable (harmless: idempotent per item). Auth is
 * the ordinary write gate (POST → verb=write), so a read-only token is
 * refused with the standard insufficient_scope envelope.
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
    expect(body.tags).toEqual([]);

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
    expect(w.skipped.sort()).toEqual([WELCOME_PATH, "Connect your AI", "Try linking notes"].sort());
    expect(w.tags).toEqual(["capture", "capture/text", "capture/voice"]); // upserts, idempotent
    const g = (await (await applyPack(v, "getting-started")).json()) as any;
    expect(g.applied).toEqual([]);
    expect(g.skipped).toEqual([GETTING_STARTED_PATH]);
    expect(await listNotes(v)).toHaveLength(4);
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

  it("a vault:<name>:write JWT can apply; a read-only JWT is refused (insufficient_scope)", async () => {
    const v = freshVault("p");
    const writer = await mintToken({ vault: v, scopes: `vault:${v}:write`, vaultScope: [v] });
    const ok = await SELF.fetch(`${base(v)}/api/packs/surface-starter`, {
      method: "POST",
      headers: { Authorization: `Bearer ${writer}` },
    });
    expect(ok.status).toBe(200);
    // Fresh vault → the pack lands (the JWT write path is the console's seam).
    expect(((await ok.json()) as any).applied).toEqual([SURFACE_STARTER_PATH]);
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
