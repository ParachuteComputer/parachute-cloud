/**
 * Review finding (T-318 day review, key b): an anonymous client could page the
 * operator. A POST whose body can't be parsed (multipart with no boundary,
 * broken urlencoded, broken JSON) made `req.formData()` / `req.json()` throw
 * into Hono's default handler: a 500. #313 counts every 5xx and the 10-minute
 * health tick alerts at 25, to every recipient and the webhook. So 25
 * unauthenticated junk requests paged the operator, as often as the attacker
 * liked (one page per dedupe hour).
 *
 * A body the client sent wrong is the client's error: 400, not counted.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import worker from "../src/index.ts";
import { sumOpsCounter } from "../src/ops-counters.ts";

const ORIGIN = "https://cloud.parachute.computer";

async function post(path: string, contentType: string, body: string | Uint8Array): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      // "" = send no Content-Type at all.
      headers: contentType ? { "content-type": contentType, origin: ORIGIN } : { origin: ORIGIN },
      body,
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("a malformed request body is the client's error, not a server error", () => {
  test("anonymous junk POSTs answer 400 and never reach the 5xx counter", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: Array<[string, string, string | Uint8Array]> = [
      ["/auth/magic", "multipart/form-data", "x"],
      ["/auth/code", "multipart/form-data", "x"],
      ["/login", "multipart/form-data", "x"],
      ["/signup", "multipart/form-data", "x"],
      ["/logout", "multipart/form-data", "x"],
      ["/oauth/authorize", "multipart/form-data", "x"],
      // Other bodies a stranger can send that workerd's formData() refuses
      // (found by a second review): no Content-Type, a multipart part with no
      // header terminator, an urlencoded body that isn't UTF-8.
      ["/auth/magic", "", "x"],
      ["/auth/magic", "multipart/form-data; boundary=zz", "--zz\r\nfoo\r\n--zz--"],
      ["/auth/magic", "application/x-www-form-urlencoded", new Uint8Array([0x61, 0x3d, 0xff, 0xfe])],
    ];
    const statuses: string[] = [];
    for (const [path, ct, body] of cases) {
      const res = await post(path, ct, body);
      statuses.push(`${path} ${res.status}`);
    }
    expect(statuses.filter((s) => s.endsWith(" 500"))).toEqual([]);
    expect(await sumOpsCounter(env.DB, "http_5xx", "2000", "3000")).toBe(0);
  });

  test("a genuine server error still answers 500 and is counted", async () => {
    // Positive control: the fix must not swallow real failures. With the
    // sessions table gone, the console's session lookup throws.
    vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.prepare("DROP TABLE IF EXISTS sessions").run();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/console`, { headers: { cookie: "parachute_id_session=abc" } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(500);
    expect(await sumOpsCounter(env.DB, "http_5xx", "2000", "3000")).toBe(1);
  });
});
