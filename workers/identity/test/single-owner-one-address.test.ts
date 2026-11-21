/**
 * T-476: a single-owner door is one address. On a door with OWNER_PUBKEY and the VAULT_SERVICE binding (the
 * own-Cloudflare deploy, deploy/personal on door/0.9), `/vault/*` on the identity origin reaches the vault worker
 * over the binding, so the Parachute app, which sends tokens only to the hub it signed in to, can use the door's
 * vaults. Parachute Cloud (no OWNER_PUBKEY) keeps the route_missing backstop. The vault worker itself is a stub
 * here (it is another worker); the live check is the rehearsal deploy (T-476 WALK.md).
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import worker from "../src/index.ts";
import { ISSUER } from "./helpers.ts";

type Env = typeof env;
const OWNER = "a".repeat(64);

function vaultStub() {
  const seen: Request[] = [];
  const fetcher = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as RequestInfo, init);
      seen.push(req);
      return Response.json({ from: "vault", path: new URL(req.url).pathname }, { status: 200 });
    },
    connect: () => {
      throw new Error("not used");
    },
  } as unknown as Fetcher;
  return { fetcher, seen };
}

const singleOwner = (vault: Fetcher | undefined) => ({ ...env, OWNER_PUBKEY: OWNER, VAULT_SERVICE: vault }) as Env;

describe("a single-owner door answers for its vaults on its own origin (T-476)", () => {
  test("REST on /vault/<name>/… reaches the vault worker: method, path, query, body and bearer intact", async () => {
    const { fetcher, seen } = vaultStub();
    const res = await worker.fetch(
      new Request(`${ISSUER}/vault/home/api/records?limit=1`, {
        method: "POST",
        headers: { authorization: "Bearer app-key", "content-type": "application/json", cookie: "parachute_id_session=s3cret" },
        body: JSON.stringify({ content: "# hi" }),
      }),
      singleOwner(fetcher),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ from: "vault", path: "/vault/home/api/records" });
    expect(seen).toHaveLength(1);
    const got = seen[0]!;
    expect(got.method).toBe("POST");
    expect(new URL(got.url).search).toBe("?limit=1");
    expect(new URL(got.url).origin).toBe(new URL(ISSUER).origin);
    expect(got.headers.get("authorization")).toBe("Bearer app-key");
    expect(await got.text()).toBe(JSON.stringify({ content: "# hi" }));
  });

  test("the identity session cookie never reaches the vault worker", async () => {
    const { fetcher, seen } = vaultStub();
    await worker.fetch(
      new Request(`${ISSUER}/vault/home/mcp`, { method: "POST", headers: { cookie: "parachute_id_session=s3cret; other=1" } }),
      singleOwner(fetcher),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("cookie")).toBeNull();
  });

  test("the bare /vault and the vault's RFC 9728 documents go to the vault worker too", async () => {
    const { fetcher, seen } = vaultStub();
    const e = singleOwner(fetcher);
    for (const path of [
      "/vault",
      "/.well-known/oauth-protected-resource/vault/home/mcp",
      "/.well-known/oauth-authorization-server/vault/home",
    ]) {
      const res = await worker.fetch(new Request(`${ISSUER}${path}`), e);
      expect(res.status, path).toBe(200);
    }
    expect(seen.map((r) => new URL(r.url).pathname)).toEqual([
      "/vault",
      "/.well-known/oauth-protected-resource/vault/home/mcp",
      "/.well-known/oauth-authorization-server/vault/home",
    ]);
  });

  test("the door's own documents stay its own", async () => {
    const { fetcher, seen } = vaultStub();
    const res = await worker.fetch(new Request(`${ISSUER}/.well-known/oauth-protected-resource/account/mcp`), singleOwner(fetcher));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(0);
  });
});

describe("Parachute Cloud, and a door without the binding, keep the backstop", () => {
  test("no OWNER_PUBKEY: /vault/* is the 503 route_missing even with the binding", async () => {
    const { fetcher, seen } = vaultStub();
    const res = await worker.fetch(new Request(`${ISSUER}/vault/home/api/records`), { ...env, VAULT_SERVICE: fetcher } as Env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error_type: string }).error_type).toBe("vault_route_missing");
    expect(seen).toHaveLength(0);
  });

  test("no OWNER_PUBKEY: the path-inserted vault documents are a 404, as before", async () => {
    const { fetcher, seen } = vaultStub();
    const res = await worker.fetch(new Request(`${ISSUER}/.well-known/oauth-protected-resource/vault/home/mcp`), {
      ...env,
      VAULT_SERVICE: fetcher,
    } as Env);
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  test("OWNER_PUBKEY but no VAULT_SERVICE binding: the 503 backstop", async () => {
    const res = await worker.fetch(new Request(`${ISSUER}/vault/home/api/records`), singleOwner(undefined));
    expect(res.status).toBe(503);
  });
});
