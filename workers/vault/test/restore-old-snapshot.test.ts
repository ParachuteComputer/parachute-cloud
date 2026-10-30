// Restoring a snapshot the OLD exporter wrote (every nightly snapshot taken
// before 2026-10-29): its metadata must come back exactly. That exporter left
// a string starting with [ ] { } , ' or " unquoted, so a plain YAML read made
// `wiki: "[[Projects/Alpha]]"` a nested list (T-318 review; fixed in core#32).
// The note bytes are exactly what the old exporter wrote. Made-up data.
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY_CLIENT_ID } from "../src/auth.ts";
import { toTar } from "../src/export.ts";
import type { SnapshotEntry } from "../src/snapshots.ts";
import { base, freshVault, mintToken, op } from "./helpers.ts";

const VALUES: Record<string, unknown> = {
  wiki: "[[Projects/Alpha]]",
  bracket: "[draft]",
  brace: "{x}",
  sq: "'single'",
  dq: '"double"',
  comma: ", lead",
  close: "]x",
  list: ["[[A]]", "plain"],
};

const OLD_NOTE = `---
id: 01M66HE43WKN0Z7EZ0766D7S6N
path: Notes/Meta
metadata:
  brace: {x}
  bracket: [draft]
  close: ]x
  comma: , lead
  dq: "double"
  list:
    - [[A]]
    - plain
  sq: 'single'
  wiki: [[Projects/Alpha]]
created_at: 2026-10-27T13:54:21.437Z
updated_at: 2026-10-27T13:54:21.437Z
---
body
`;

describe("restore of a snapshot the old exporter wrote", () => {
  it("brings every metadata value back exactly", async () => {
    const src = freshVault("ros");
    const snapRes = await op(src, "/api/internal/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention: { daily: 14, weekly: 8, monthly: 12 } }),
    });
    expect(snapRes.status).toBe(200);
    const { entry } = (await snapRes.json()) as { entry: SnapshotEntry };
    // Swap the snapshot's bytes for an export dated before the quoting fix.
    const enc = new TextEncoder();
    await env.ATTACHMENTS.put(
      entry.key,
      toTar([
        { name: ".parachute/vault.yaml", bytes: enc.encode("export_format_version: 1\nexported_at: 2026-10-28T04:00:00.000Z\nname: ros\n") },
        { name: "Notes/Meta.md", bytes: enc.encode(OLD_NOTE) },
      ]),
    );

    const dst = freshVault("rot");
    const token = await mintToken({ vault: dst, scopes: `vault:${dst}:admin`, vaultScope: [dst], clientId: FIRST_PARTY_CLIENT_ID });
    const res = await SELF.fetch(`${base(dst)}/api/internal/restore`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ source_vault: src, snapshot_key: entry.key }),
    });
    expect(res.status).toBe(200);

    const note = await op(dst, "/api/notes/01M66HE43WKN0Z7EZ0766D7S6N");
    expect(note.status).toBe(200);
    expect(((await note.json()) as { metadata: Record<string, unknown> }).metadata).toEqual(VALUES);
  });
});
