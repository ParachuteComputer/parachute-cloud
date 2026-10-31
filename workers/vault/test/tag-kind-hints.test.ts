/**
 * Core 0.9's kind errors and doctor remedy teach the fix as a tool call. On cloud that call must name a tool this
 * door serves: cloud lists core's tools (update-tag), not the bun server's 0.9 names (manage-types), so a hint
 * naming manage-types sends the agent to "Unknown tool".
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, freshVault, OP } from "./helpers.ts";

const BOTH = "application/json, text/event-stream";
async function rpc(v: string, method: string, params: Record<string, unknown>): Promise<any> {
  const res = await SELF.fetch(`${base(v)}/mcp`, {
    method: "POST",
    headers: { Accept: BOTH, "Content-Type": "application/json", Authorization: `Bearer ${OP}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()) as any;
}
const call = (v: string, name: string, args: Record<string, unknown>) => rpc(v, "tools/call", { name, arguments: args });
/** The tool a hint like `manage-types {tag: "x", kind: "type"}` names. */
const toolIn = (hint: string) => /([a-z][a-z-]+) \{/.exec(hint)?.[1];

describe("kind hints name a tool cloud serves", () => {
  it("create-note {types: [a plain tag]} and the doctor remedy", async () => {
    const v = freshVault("tkh");
    const listed = ((await rpc(v, "tools/list", {})).result.tools as { name: string }[]).map((t) => t.name);
    await call(v, "create-note", { notes: Array.from({ length: 20 }, (_, i) => ({ path: `l/${i}`, content: `n${i}`, tags: ["label"] })) });

    const refused = await call(v, "create-note", { path: "x", content: "x", types: ["label"] });
    expect(refused.error?.data?.error_type).toBe("tag_kind");
    expect(listed).toContain(toolIn(refused.error.data.hint));
    expect(listed).toContain(toolIn(refused.error.message));

    const doctor = JSON.parse((await call(v, "doctor", {})).result.content[0].text);
    const finding = doctor.findings.find((f: any) => f.type === "tag_used_like_type" && f.subject === "label");
    expect(finding).toBeTruthy();
    expect(listed).toContain(toolIn(finding.remedy));

    // And the call the hint names does the job here.
    const name = toolIn(refused.error.data.hint)!;
    const fixed = await call(v, name, { tag: "label", kind: "type" });
    expect(fixed.error).toBeUndefined();
    const made = await call(v, "create-note", { path: "x", content: "x", types: ["label"] });
    expect(made.error).toBeUndefined();
  });
});
