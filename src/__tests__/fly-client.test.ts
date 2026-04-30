import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FlyClient, PARACHUTE_VOLUME_NAME } from "../provider/fly-client.ts";
import { ProviderError } from "../provider/provider-client.ts";

interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

interface FakeFly {
  origin: string;
  requests: RecordedRequest[];
  /** Replace per-test to control responses. Default returns 200/empty for everything. */
  handler: (req: Request, url: URL) => Promise<Response> | Response;
  stop: () => Promise<void>;
}

async function startFakeFly(): Promise<FakeFly> {
  const requests: RecordedRequest[] = [];
  const fake: FakeFly = {
    origin: "",
    requests,
    handler: () => new Response("{}", { status: 200 }),
    stop: async () => {},
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      let body: unknown = null;
      if (req.method !== "GET" && req.method !== "DELETE") {
        const text = await req.text();
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
      }
      requests.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        authorization: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        body,
      });
      return fake.handler(req, url);
    },
  });
  fake.origin = `http://localhost:${server.port}`;
  fake.stop = async () => {
    await server.stop(true);
  };
  return fake;
}

let fake: FakeFly;
let client: FlyClient;

beforeEach(async () => {
  fake = await startFakeFly();
  client = new FlyClient({
    token: "fly_test_token_xyz",
    orgSlug: "personal",
    apiOrigin: fake.origin,
  });
});

afterEach(async () => {
  await fake.stop();
});

describe("FlyClient.validateToken", () => {
  test("200 from /v1/apps → valid + orgSlug", async () => {
    fake.handler = () => new Response(JSON.stringify({ apps: [] }), { status: 200 });
    const v = await client.validateToken();
    expect(v.valid).toBe(true);
    expect(v.orgSlug).toBe("personal");
    expect(fake.requests[0]?.path).toBe("/v1/apps?org_slug=personal");
    expect(fake.requests[0]?.authorization).toBe("Bearer fly_test_token_xyz");
  });

  test("401 → invalid with reason", async () => {
    fake.handler = () => new Response("nope", { status: 401 });
    const v = await client.validateToken();
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("401");
  });

  test("403 → invalid with reason", async () => {
    fake.handler = () => new Response("forbidden", { status: 403 });
    const v = await client.validateToken();
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("403");
  });

  test("404 (org not found) → valid=false with explanatory reason", async () => {
    fake.handler = () => new Response("no such org", { status: 404 });
    const v = await client.validateToken();
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("not found");
  });

  test("500 → invalid with status in reason", async () => {
    fake.handler = () => new Response("oops", { status: 500 });
    const v = await client.validateToken();
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("500");
  });
});

describe("FlyClient.provisionMachine — happy path", () => {
  test("makes app + volume + machine calls in order with correct shapes", async () => {
    const responses: Array<() => Response> = [
      () => new Response(JSON.stringify({ name: "parachute-aaron" }), { status: 201 }),
      () =>
        new Response(JSON.stringify({ id: "vol_abc", name: PARACHUTE_VOLUME_NAME }), {
          status: 200,
        }),
      () =>
        new Response(
          JSON.stringify({
            id: "m_123",
            region: "ord",
            state: "starting",
            created_at: "2026-04-29T12:00:00Z",
          }),
          { status: 200 },
        ),
    ];
    let i = 0;
    fake.handler = () => {
      const r = responses[i++];
      if (!r) return new Response("unexpected", { status: 500 });
      return r();
    };

    const rec = await client.provisionMachine({
      name: "parachute-aaron",
      region: "ord",
      size: "small",
      volumeSizeGb: 10,
      image: "ghcr.io/openparachute/parachute:0.4.0",
      env: { HUB_PORT: "1939" },
    });

    expect(fake.requests).toHaveLength(3);

    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/apps",
      authorization: "Bearer fly_test_token_xyz",
      contentType: "application/json",
      body: { app_name: "parachute-aaron", org_slug: "personal" },
    });

    expect(fake.requests[1]).toMatchObject({
      method: "POST",
      path: "/v1/apps/parachute-aaron/volumes",
      body: { name: PARACHUTE_VOLUME_NAME, region: "ord", size_gb: 10 },
    });

    const machineCall = fake.requests[2];
    if (!machineCall) throw new Error("missing machine call");
    expect(machineCall.method).toBe("POST");
    expect(machineCall.path).toBe("/v1/apps/parachute-aaron/machines");
    const machineBody = machineCall.body as {
      region: string;
      config: {
        image: string;
        env: Record<string, string>;
        guest: { cpu_kind: string; cpus: number; memory_mb: number };
        mounts: Array<{ volume: string; path: string }>;
        services: Array<{ internal_port: number }>;
      };
    };
    expect(machineBody.region).toBe("ord");
    expect(machineBody.config.image).toBe("ghcr.io/openparachute/parachute:0.4.0");
    expect(machineBody.config.env).toEqual({ HUB_PORT: "1939" });
    expect(machineBody.config.guest).toEqual({ cpu_kind: "shared", cpus: 1, memory_mb: 1024 });
    expect(machineBody.config.mounts[0]).toEqual({ volume: "vol_abc", path: "/data" });
    expect(machineBody.config.services[0]?.internal_port).toBe(1939);

    expect(rec).toEqual({
      name: "parachute-aaron",
      provider: "fly",
      region: "ord",
      url: "https://parachute-aaron.fly.dev",
      status: "starting",
      createdAt: "2026-04-29T12:00:00Z",
    });
  });

  test("size=medium → 2048 MB guest config", async () => {
    fake.handler = (_req, url) => {
      if (url.pathname.endsWith("/volumes")) {
        return new Response(JSON.stringify({ id: "vol_x", name: PARACHUTE_VOLUME_NAME }), {
          status: 200,
        });
      }
      if (url.pathname.endsWith("/machines")) {
        return new Response(
          JSON.stringify({
            id: "m_x",
            region: "ams",
            state: "starting",
            created_at: "2026-04-29T12:00:00Z",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    };

    await client.provisionMachine({
      name: "parachute-bigger",
      region: "ams",
      size: "medium",
      volumeSizeGb: 20,
      image: "x",
      env: {},
    });

    const machineCall = fake.requests.find((r) => r.path.endsWith("/machines"));
    expect(
      (machineCall?.body as { config: { guest: { memory_mb: number } } }).config.guest.memory_mb,
    ).toBe(2048);
  });
});

describe("FlyClient.provisionMachine — failure paths", () => {
  test("app-create 422 → ProviderError with status, no further calls", async () => {
    fake.handler = () => new Response("name taken", { status: 422 });
    await expect(
      client.provisionMachine({
        name: "parachute-dup",
        region: "ord",
        size: "small",
        volumeSizeGb: 10,
        image: "x",
        env: {},
      }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      provider: "fly",
      statusCode: 422,
    });
    expect(fake.requests).toHaveLength(1);
  });

  test("volume-create 5xx (placement failure) → ProviderError, then cleanup DELETE", async () => {
    let n = 0;
    fake.handler = (req) => {
      if (req.method === "DELETE") return new Response("", { status: 200 });
      n++;
      if (n === 1) return new Response("{}", { status: 201 });
      return new Response("placement failed", { status: 503 });
    };
    await expect(
      client.provisionMachine({
        name: "parachute-x",
        region: "ord",
        size: "small",
        volumeSizeGb: 10,
        image: "x",
        env: {},
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests[2]).toMatchObject({
      method: "DELETE",
      path: "/v1/apps/parachute-x?force=true",
    });
  });

  test("machine-create 4xx → ProviderError surfaces status, then cleanup DELETE", async () => {
    let n = 0;
    fake.handler = (req) => {
      if (req.method === "DELETE") return new Response("", { status: 200 });
      n++;
      if (n === 1) return new Response("{}", { status: 201 });
      if (n === 2) return new Response(JSON.stringify({ id: "vol_z", name: "x" }), { status: 200 });
      return new Response("bad guest config", { status: 400 });
    };
    await expect(
      client.provisionMachine({
        name: "parachute-bad",
        region: "ord",
        size: "small",
        volumeSizeGb: 10,
        image: "x",
        env: {},
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fake.requests).toHaveLength(4);
    expect(fake.requests[3]).toMatchObject({
      method: "DELETE",
      path: "/v1/apps/parachute-bad?force=true",
    });
  });

  test("name without parachute- prefix → ProviderError, no API calls", async () => {
    await expect(
      client.provisionMachine({
        name: "my-app",
        region: "ord",
        size: "small",
        volumeSizeGb: 10,
        image: "x",
        env: {},
      }),
    ).rejects.toMatchObject({ name: "ProviderError", provider: "fly" });
    expect(fake.requests).toHaveLength(0);
  });

  test("app-create 409 (conflict — already exists in another org) → ProviderError with status", async () => {
    fake.handler = () => new Response("name not available", { status: 409 });
    await expect(
      client.provisionMachine({
        name: "parachute-taken",
        region: "ord",
        size: "small",
        volumeSizeGb: 10,
        image: "x",
        env: {},
      }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      provider: "fly",
      statusCode: 409,
    });
    expect(fake.requests).toHaveLength(1);
  });
});

describe("FlyClient — token does not leak into error messages", () => {
  const token = "fly_test_token_xyz";

  test("provisionMachine app-failure error message has no token", async () => {
    fake.handler = () => new Response(`internal: bearer ${token} echoed back`, { status: 500 });
    let err: unknown;
    try {
      await client.provisionMachine({
        name: "parachute-leak",
        region: "ord",
        size: "small",
        volumeSizeGb: 10,
        image: "x",
        env: {},
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).not.toContain(token);
  });

  test("destroyMachine 500 error message has no token", async () => {
    fake.handler = () => new Response(`echoed: ${token}`, { status: 500 });
    let err: unknown;
    try {
      await client.destroyMachine("parachute-leak");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).not.toContain(token);
  });

  test("listMachines 500 error message has no token", async () => {
    fake.handler = () => new Response(`echoed: ${token}`, { status: 500 });
    let err: unknown;
    try {
      await client.listMachines();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).not.toContain(token);
  });
});

describe("FlyClient.destroyMachine", () => {
  test("200 → resolves; one DELETE call with force=true", async () => {
    fake.handler = () => new Response("", { status: 200 });
    await client.destroyMachine("parachute-aaron");
    expect(fake.requests).toEqual([
      {
        method: "DELETE",
        path: "/v1/apps/parachute-aaron?force=true",
        authorization: "Bearer fly_test_token_xyz",
        contentType: null,
        body: null,
      },
    ]);
  });

  test("404 → resolves (idempotent — already gone is success)", async () => {
    fake.handler = () => new Response("not found", { status: 404 });
    await expect(client.destroyMachine("parachute-gone")).resolves.toBeUndefined();
  });

  test("410 → resolves (gone but historically present)", async () => {
    fake.handler = () => new Response("", { status: 410 });
    await expect(client.destroyMachine("parachute-gone")).resolves.toBeUndefined();
  });

  test("500 → ProviderError with status", async () => {
    fake.handler = () => new Response("server error", { status: 500 });
    await expect(client.destroyMachine("parachute-x")).rejects.toMatchObject({
      name: "ProviderError",
      statusCode: 500,
    });
  });
});

describe("FlyClient.listMachines", () => {
  test("filters apps by parachute- prefix and enriches with machine state", async () => {
    fake.handler = (_req, url) => {
      if (url.pathname === "/v1/apps") {
        return new Response(
          JSON.stringify({
            apps: [
              { name: "parachute-aaron", status: "deployed" },
              { name: "unrelated-side-project", status: "deployed" },
              { name: "parachute-test", status: "pending" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.pathname === "/v1/apps/parachute-aaron/machines") {
        return new Response(
          JSON.stringify([
            { id: "m1", region: "ord", state: "started", created_at: "2026-04-29T10:00:00Z" },
          ]),
          { status: 200 },
        );
      }
      if (url.pathname === "/v1/apps/parachute-test/machines") {
        return new Response(
          JSON.stringify([
            { id: "m2", region: "ams", state: "starting", created_at: "2026-04-29T11:00:00Z" },
          ]),
          { status: 200 },
        );
      }
      return new Response("not expected", { status: 500 });
    };

    const list = await client.listMachines();
    expect(list).toHaveLength(2);
    const names = list.map((d) => d.name).sort();
    expect(names).toEqual(["parachute-aaron", "parachute-test"]);
    const aaron = list.find((d) => d.name === "parachute-aaron");
    expect(aaron).toMatchObject({
      provider: "fly",
      region: "ord",
      url: "https://parachute-aaron.fly.dev",
      status: "running",
      createdAt: "2026-04-29T10:00:00Z",
    });
  });

  test("orphan app (no machines) returns record with status=unknown", async () => {
    fake.handler = (_req, url) => {
      if (url.pathname === "/v1/apps") {
        return new Response(
          JSON.stringify({ apps: [{ name: "parachute-orphan", status: "pending" }] }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/machines")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    };

    const list = await client.listMachines();
    expect(list).toEqual([
      {
        name: "parachute-orphan",
        provider: "fly",
        region: "",
        url: "https://parachute-orphan.fly.dev",
        status: "unknown",
        createdAt: "",
      },
    ]);
  });

  test("empty app list → empty record list", async () => {
    fake.handler = () => new Response(JSON.stringify({ apps: [] }), { status: 200 });
    expect(await client.listMachines()).toEqual([]);
  });

  test("app-list 5xx → ProviderError", async () => {
    fake.handler = () => new Response("down", { status: 503 });
    await expect(client.listMachines()).rejects.toMatchObject({
      name: "ProviderError",
      statusCode: 503,
    });
  });
});

describe("FlyClient — deferred surfaces", () => {
  test("tailLogs throws ProviderError on first iteration", async () => {
    const it = client.tailLogs("parachute-aaron")[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toBeInstanceOf(ProviderError);
  });

  test("sshExec rejects with ProviderError", async () => {
    await expect(client.sshExec("parachute-aaron", "ls /")).rejects.toBeInstanceOf(ProviderError);
  });
});
