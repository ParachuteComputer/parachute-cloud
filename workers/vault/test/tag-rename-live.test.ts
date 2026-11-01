import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, createNote, freshVault, op, OP } from "./helpers.ts";

/**
 * A tag rename rewrites `#old` to `#new` in the content of every note that
 * mentions it and commits those rows, but core fired no `updated` for them
 * (core#29 covered only the path-rename cascade). A live subscription whose
 * set holds such a note must get an upsert with the new body. Red until the
 * core pin carries parachute-core uni/t318-dr2-tagrename-updated.
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

describe("a tag rename's content rewrites reach live subscribers", () => {
  it("pushes an upsert with the rewritten body", async () => {
    const v = freshVault("tagrlive");
    const task = await createNote(v, { content: "follow up #work", path: "Tasks/One", tags: ["task", "work"] });

    const res = await SELF.fetch(`${base(v)}/api/subscribe?tag=task`, { headers: { Authorization: `Bearer ${OP}` } });
    const sse = sseReader(res);
    expect((await sse.next()).event).toBe("snapshot");

    const renamed = await op(v, `/api/tags/work/rename`, { method: "POST", ...json({ new_name: "job" }) });
    expect(renamed.status).toBe(200);
    // The rewrite committed: REST reads the new body.
    expect(((await (await op(v, `/api/notes/${task.id}`)).json()) as any).content).toBe("follow up #job");

    const sentinel = (await createNote(v, { content: "sentinel", tags: ["task"] })).id;
    const seen = await upsertsUntilSentinel(sse, sentinel);
    await sse.cancel();
    const pushed = seen.find((n) => n.id === task.id);
    expect(pushed, "no upsert for the rewritten task before the sentinel").toBeTruthy();
    expect(pushed.content).toBe("follow up #job");
  });
});
