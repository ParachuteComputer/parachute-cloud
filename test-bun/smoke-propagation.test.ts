/**
 * The edge-propagation retry, pinned (cloud#207).
 *
 * The rc.116 Wave A prod deploy read RED on a healthy feature: the smoke ran
 * before the new worker reached the edge PoP, the not-yet-existing
 * /account/mcp path fell through to the SPA static assets and answered 200
 * text/html, and `.json()` threw SyntaxError. These tests pin the property that
 * makes the retry safe rather than merely convenient: it may delay a red, but
 * it can NEVER turn one green — only the SPA-shell signature is retried, every
 * other answer comes back on the first attempt untouched.
 *
 * Pure module with injectable fetch/sleep — no network, no ports, no clock.
 * Runs under the root `bun test` suite ("test": "bun test src test-bun").
 */
import { describe, expect, it } from "bun:test";
import {
  fetchPastPropagation,
  looksLikeSpaShell,
  PROPAGATION_BACKOFF_MS,
  propagationNote,
  type PropagationDeps,
} from "../scripts/smoke-propagation.ts";

const html = (status = 200) => new Response("<!DOCTYPE html><html><body>app shell</body></html>", { status, headers: { "content-type": "text/html; charset=utf-8" } });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A scripted fetch: hands back the queued responses in order, recording calls. */
function scriptedDeps(queue: Response[]): PropagationDeps & { calls: number; slept: number[] } {
  const d = {
    calls: 0,
    slept: [] as number[],
    fetch: async () => {
      const r = queue[Math.min(d.calls, queue.length - 1)]!;
      d.calls++;
      return r.clone();
    },
    sleep: async (ms: number) => {
      d.slept.push(ms); // never actually waits — the schedule is asserted, not endured
    },
    log: () => {},
  };
  return d;
}

describe("looksLikeSpaShell — the ONE retryable signature", () => {
  it("an HTML content-type is the shell", () => {
    expect(looksLikeSpaShell(html(), "<!DOCTYPE html>")).toBe(true);
  });

  it("a body opening with a tag is the shell even without an HTML content-type", () => {
    const res = new Response("<html></html>", { headers: { "content-type": "application/octet-stream" } });
    expect(looksLikeSpaShell(res, "  <html></html>")).toBe(true);
  });

  it("JSON is NOT the shell — including a JSON error, a 404, and a 500", () => {
    expect(looksLikeSpaShell(json({ resource: "x" }), '{"resource":"x"}')).toBe(false);
    expect(looksLikeSpaShell(json({ error: "nope" }, 404), '{"error":"nope"}')).toBe(false);
    expect(looksLikeSpaShell(json({ error: "boom" }, 500), '{"error":"boom"}')).toBe(false);
  });

  it("an empty body is NOT the shell (a 204/redirect is a real answer)", () => {
    expect(looksLikeSpaShell(new Response("", { status: 302 }), "")).toBe(false);
  });
});

describe("fetchPastPropagation — a retry may delay a red, never turn one green", () => {
  it("a clean first answer costs exactly one fetch and zero sleeps", async () => {
    const d = scriptedDeps([json({ resource: "https://my.parachute.computer/account/mcp" })]);
    const r = await fetchPastPropagation("https://cloud.example/x", undefined, d);
    expect(r.attempts).toBe(1);
    expect(d.calls).toBe(1);
    expect(d.slept).toEqual([]);
    expect(r.waitedMs).toBe(0);
    expect(JSON.parse(r.body).resource).toBe("https://my.parachute.computer/account/mcp");
  });

  it("THE rc.116 CASE: shell, shell, then the real PRM → retried through to the JSON answer", async () => {
    const d = scriptedDeps([html(), html(), json({ resource: "https://my.parachute.computer/account/mcp" })]);
    const r = await fetchPastPropagation("https://cloud.example/.well-known/oauth-protected-resource/account/mcp", undefined, d);
    expect(r.attempts).toBe(3);
    expect(d.slept).toEqual([PROPAGATION_BACKOFF_MS[0], PROPAGATION_BACKOFF_MS[1]]);
    expect(r.res.status).toBe(200);
    expect(() => JSON.parse(r.body)).not.toThrow(); // the SyntaxError that made rc.116 red
  });

  it("THE SAFETY PROPERTY — a WRONG answer is never retried away: it comes back on attempt 1", async () => {
    // If the retry chewed on real failures it would mask contract breaks. A
    // 401-with-no-challenge, a wrong resource, a 500: all real answers.
    for (const bad of [json({ resource: "https://wrong.example/account/mcp" }), json({ error: "boom" }, 500), json({ error: "not_found" }, 404)]) {
      const d = scriptedDeps([bad, json({ resource: "https://right.example/account/mcp" })]);
      const r = await fetchPastPropagation("https://cloud.example/x", undefined, d);
      expect(r.attempts).toBe(1);
      expect(d.calls).toBe(1); // the "good" second response is never reached
      expect(d.slept).toEqual([]);
    }
  });

  it("a PERSISTENT shell exhausts the retries and returns the shell — red stays red", async () => {
    // The run_worker_first backstop regressing (cloud#196) must still fail the
    // smoke. The retry costs ~19s and changes nothing about the verdict.
    const d = scriptedDeps([html()]);
    const r = await fetchPastPropagation("https://cloud.example/account/mcp", undefined, d);
    expect(r.attempts).toBe(PROPAGATION_BACKOFF_MS.length + 1);
    expect(d.calls).toBe(PROPAGATION_BACKOFF_MS.length + 1);
    expect(d.slept).toEqual([...PROPAGATION_BACKOFF_MS]);
    expect(looksLikeSpaShell(r.res, r.body)).toBe(true); // caller asserts on this and FAILS
    expect(r.waitedMs).toBe(PROPAGATION_BACKOFF_MS.reduce((a, b) => a + b, 0));
  });

  it("the backoff is bounded and modest — a stale PoP costs ~19s, not minutes", () => {
    const total = PROPAGATION_BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(10_000); // enough to outlast a normal PoP lag
    expect(total).toBeLessThanOrEqual(30_000); // but never long enough to hide a real outage
    expect([...PROPAGATION_BACKOFF_MS]).toEqual([...PROPAGATION_BACKOFF_MS].sort((a, b) => a - b)); // monotonic
  });

  it("passes the init through on every attempt (the POST body isn't lost on retry)", async () => {
    const seen: (RequestInit | undefined)[] = [];
    const deps: PropagationDeps = {
      fetch: async (_u, init) => {
        seen.push(init);
        return seen.length < 3 ? html() : json({ ok: true });
      },
      sleep: async () => {},
      log: () => {},
    };
    const init = { method: "POST", body: '{"jsonrpc":"2.0"}' };
    await fetchPastPropagation("https://cloud.example/account/mcp", init, deps);
    expect(seen).toHaveLength(3);
    for (const s of seen) expect(s).toEqual(init);
  });
});

describe("propagationNote — a run that waited never reads identical to a clean one", () => {
  it("silent on a first-attempt answer", () => {
    expect(propagationNote(1)).toBe("");
  });

  it("names the attempt count once propagation had to be waited out", () => {
    expect(propagationNote(3)).toContain("3 attempts");
    expect(propagationNote(3)).toMatch(/propagated/);
  });
});
