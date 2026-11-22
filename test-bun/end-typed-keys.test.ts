/**
 * deploy/personal/end-typed-keys.sh (T-476): before a rollback past the typed-keys stack it must end every live typed
 * key, and it must never say PASS while one could still be live. Run against a local fake identity worker, with the
 * NIP-98 sign-in stubbed (a copy of the script beside a stub `nip98.ts` that writes a curl config): every answer that
 * isn't a readable key list, and every revoke that isn't a 200, is a FAIL with exit 1.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "end-typed-keys-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, "personal"));
copyFileSync(join(ROOT, "deploy/personal/end-typed-keys.sh"), join(dir, "personal/end-typed-keys.sh"));
// the stub sign-in: `bun nip98.ts token <origin> <key file> <out>` writes a curl config with a made-up bearer
writeFileSync(
  join(dir, "personal/nip98.ts"),
  `const [, , mode, , , out] = process.argv; if (mode !== "token") process.exit(2); await Bun.write(out, 'header = "Authorization: Bearer made-up"\\n');`,
);
writeFileSync(join(dir, "key"), "made-up");

type Mode = { list: () => Response; del?: (name: string) => Response };
async function run(mode: Mode, origin?: (base: string) => string) {
  let revoked: string[] = [];
  const typed = new Set(["ai-recipes"]);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      if (req.method === "GET" && u.pathname === "/account/keys") return mode.list();
      const m = /^\/account\/keys\/(.+)$/.exec(u.pathname);
      if (req.method === "DELETE" && m) {
        const name = decodeURIComponent(m[1]!);
        const r = mode.del ? mode.del(name) : Response.json({ name });
        if (r.status === 200) { revoked.push(name); typed.delete(name); }
        return r;
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const proc = Bun.spawn(["bash", join(dir, "personal/end-typed-keys.sh"), origin ? origin(base) : base, join(dir, "key")], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: process.env.PATH ?? "" },
  });
  const [out, code] = [await new Response(proc.stdout).text(), await proc.exited];
  server.stop(true);
  return { out, code, revoked };
}

const keysList = (keys: unknown[]) => () => Response.json({ keys });
const ai = { name: "ai-recipes", vault: "home", can: "write", status: "active", types: ["recipe"], kind: "agent" };
const plain = { name: "site", vault: "home", can: "read", status: "active" };

describe("end-typed-keys.sh", () => {
  it("ends every live typed key, leaves other keys, and passes only once none is left", async () => {
    let listed = 0;
    const r = await run({ list: () => (listed++ === 0 ? keysList([ai, plain])() : keysList([{ ...ai, status: "revoked" }, plain])()) });
    expect(r.code).toBe(0);
    expect(r.revoked).toEqual(["ai-recipes"]);
    expect(r.out).toContain("PASS end-typed-keys (1 ended)");
  });

  it("a trailing slash on the origin is the same door", async () => {
    let listed = 0;
    const r = await run({ list: () => (listed++ === 0 ? keysList([ai])() : keysList([])()) }, (b) => `${b}/`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("PASS end-typed-keys (1 ended)");
  });

  for (const [what, list] of [
    ["a 401 from the list", () => Response.json({ error: "invalid_token" }, { status: 401 })],
    ["a 500 that isn't JSON", () => new Response("upstream error", { status: 500 })],
    ["a 200 with no keys list", () => Response.json({ error: "something" })],
    ["an empty 200", () => new Response("", { status: 200 })],
  ] as const) {
    it(`fails closed on ${what}`, async () => {
      const r = await run({ list });
      expect(r.code).toBe(1);
      expect(r.out).not.toContain("PASS");
      expect(r.out).toContain("FAIL");
    });
  }

  it("fails closed when a revoke isn't a 200, whatever the list says after", async () => {
    const r = await run({ list: keysList([ai]), del: () => new Response("no", { status: 500 }) });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("PASS");
  });

  it("fails closed when the list after revoking can't be read", async () => {
    let listed = 0;
    const r = await run({ list: () => (listed++ === 0 ? keysList([ai])() : Response.json({}, { status: 503 })) });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("PASS");
  });

  it("prints no token", async () => {
    let listed = 0;
    const r = await run({ list: () => (listed++ === 0 ? keysList([ai])() : keysList([])()) });
    expect(r.out).not.toContain("made-up");
  });
});
