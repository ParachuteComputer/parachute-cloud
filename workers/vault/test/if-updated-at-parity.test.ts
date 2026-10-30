/**
 * Door parity for a malformed `if_updated_at` (vault#739, carried by the engine
 * move to parachute-core v0.8, cloud#329). The bun door answers 400
 * invalid_request on PATCH /api/notes/:id and POST /api/notes/:id/restore
 * (parachute-core packages/vault/src/routes.ts `invalidIfUpdatedAtResponse`),
 * and core's own update-note tool rejects it the same way. Before this, the
 * cloud REST door passed the value through to core's `updateNote`, whose
 * `new Date(v).toISOString()` threw, so the caller got a 500.
 */
import { describe, expect, it } from "vitest";
import { createNote, freshVault, op } from "./helpers.ts";

const BAD: unknown[] = ["zzz", {}, ["2026-01-01"], 12345];
const json = (body: unknown) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function expectInvalidIfUpdatedAt(status: number, body: any) {
  expect(status, JSON.stringify(body)).toBe(400);
  expect(body.error_type).toBe("invalid_request");
  expect(body.field).toBe("if_updated_at");
  expect(body.error).toBe("if_updated_at must be an ISO-8601 timestamp string");
  expect(typeof body.hint).toBe("string");
}

describe("malformed if_updated_at → 400 invalid_request (bun-door parity)", () => {
  it("PATCH /api/notes/:id", async () => {
    const v = freshVault("ifua");
    const n = await createNote(v, { content: "v1" });
    for (const bad of BAD) {
      const res = await op(v, `/api/notes/${n.id}`, { method: "PATCH", ...json({ content: "v2", if_updated_at: bad }) });
      expectInvalidIfUpdatedAt(res.status, await res.json());
    }
    // Nothing was written.
    const after = await (await op(v, `/api/notes/${n.id}`)).json() as any;
    expect(after.content).toBe("v1");
  });

  it("POST /api/notes/:id/restore", async () => {
    const v = freshVault("ifuar");
    const n = await createNote(v, { content: "v1" });
    const edited = await op(v, `/api/notes/${n.id}`, { method: "PATCH", ...json({ content: "v2", force: true }) });
    expect(edited.status).toBe(200);
    for (const bad of BAD) {
      const res = await op(v, `/api/notes/${n.id}/restore`, { method: "POST", ...json({ version_ix: 0, if_updated_at: bad }) });
      expectInvalidIfUpdatedAt(res.status, await res.json());
    }
    const after = await (await op(v, `/api/notes/${n.id}`)).json() as any;
    expect(after.content).toBe("v2");
  });

  it("a valid if_updated_at still works", async () => {
    const v = freshVault("ifuaok");
    const n = await createNote(v, { content: "v1" });
    const res = await op(v, `/api/notes/${n.id}`, { method: "PATCH", ...json({ content: "v2", if_updated_at: n.updatedAt ?? n.createdAt }) });
    expect(res.status).toBe(200);
  });
});
