import { SELF, env, runInDurableObject } from "cloudflare:test";
import type { DurableObject } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { base, createNote, freshVault, op, OP } from "./helpers.ts";

/**
 * A rename rewrites OTHER notes: core v0.8's reference-field repair (cloud#329)
 * rewrites `metadata.<reference field>` from the old path to the new one, and
 * the older cascade rewrites `[[old path]]` in content. Both commit new rows for
 * those notes, so a live subscription whose set holds them must get an upsert
 * with the new values, the same as for any other write to a note in its set.
 */

function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(timeoutMs = 8000): Promise<{ event: string; data: any }> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = "message";
          const data: string[] = [];
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (data.length) return { event, data: JSON.parse(data.join("\n")) };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("SSE read timeout");
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("SSE read timeout")), remaining)),
        ]);
        if (done) throw new Error("SSE stream closed");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

const json = (body: unknown) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Upserts for notes in the `task` set, in order, until the sentinel arrives. */
async function upsertsUntilSentinel(sse: ReturnType<typeof sseReader>, sentinelId: string) {
  const seen: any[] = [];
  for (;;) {
    const f = await sse.next();
    if (f.event !== "upsert") continue; // the renamed note itself leaves/never was in the set
    if (f.data.note.id === sentinelId) return seen;
    seen.push(f.data.note);
  }
}

describe("a rename's repair writes reach live subscribers", () => {
  it("reference-field repair (metadata) pushes an upsert for the referencing note", async () => {
    const v = freshVault("replive");
    const project = await createNote(v, { content: "p", path: "Projects/Old", tags: ["project"] });
    await runInDurableObject<DurableObject, void>(env.VAULT.get(env.VAULT.idFromName(v)), async (inst: any) => {
      await inst.store.upsertTagRecord("task", { fields: { node: { type: "reference", indexed: true } } });
    });
    const task = await createNote(v, { content: "t", path: "Tasks/One", tags: ["task"], metadata: { node: "Projects/Old" } });

    const res = await SELF.fetch(`${base(v)}/api/subscribe?tag=task`, { headers: { Authorization: `Bearer ${OP}` } });
    const sse = sseReader(res);
    expect((await sse.next()).event).toBe("snapshot");

    const renamed = await op(v, `/api/notes/${project.id}`, { method: "PATCH", ...json({ path: "Projects/New", force: true }) });
    expect(renamed.status).toBe(200);
    // The repair committed: REST reads the new value.
    expect(((await (await op(v, `/api/notes/${task.id}`)).json()) as any).metadata.node).toBe("Projects/New");

    const sentinel = (await createNote(v, { content: "sentinel", tags: ["task"] })).id;
    const seen = await upsertsUntilSentinel(sse, sentinel);
    await sse.cancel();
    const pushed = seen.find((n) => n.id === task.id);
    expect(pushed, "no upsert for the repaired task before the sentinel").toBeTruthy();
    expect(pushed.metadata.node).toBe("Projects/New");
  });

  it("wikilink cascade (content) pushes an upsert for the linking note", async () => {
    const v = freshVault("caslive");
    const project = await createNote(v, { content: "p", path: "Projects/Old", tags: ["project"] });
    const task = await createNote(v, { content: "see [[Projects/Old]]", path: "Tasks/One", tags: ["task"] });

    const res = await SELF.fetch(`${base(v)}/api/subscribe?tag=task`, { headers: { Authorization: `Bearer ${OP}` } });
    const sse = sseReader(res);
    expect((await sse.next()).event).toBe("snapshot");

    const renamed = await op(v, `/api/notes/${project.id}`, { method: "PATCH", ...json({ path: "Projects/New", force: true, update_links: true }) });
    expect(renamed.status).toBe(200);
    // The cascade committed: REST reads the rewritten link.
    expect(((await (await op(v, `/api/notes/${task.id}`)).json()) as any).content).toBe("see [[Projects/New]]");

    const sentinel = (await createNote(v, { content: "sentinel", tags: ["task"] })).id;
    const seen = await upsertsUntilSentinel(sse, sentinel);
    await sse.cancel();
    const pushed = seen.find((n) => n.id === task.id);
    expect(pushed, "no upsert for the linking task before the sentinel").toBeTruthy();
    expect(pushed.content).toBe("see [[Projects/New]]");
  });
});
