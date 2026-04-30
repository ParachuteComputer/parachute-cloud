/**
 * CLI tests — argv routing + env handling + HTTP plumbing.
 *
 * The admin endpoints are tested in admin.test.ts; here we verify the
 * thin CLI wrapper sends the right request and surfaces errors.
 */

import { describe, expect, test } from "bun:test";
import { main, type FetchLike } from "../cli/admin.ts";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function recordingFetch(response: { status?: number; body?: string }): {
  fetchImpl: FetchLike;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      new Response(response.body ?? "", { status: response.status ?? 200 }),
    );
  };
  return { fetchImpl, calls };
}

function captureOutput(): {
  out: (line: string) => void;
  err: (line: string) => void;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    stdout,
    stderr,
  };
}

const ENV = {
  PARACHUTE_CLOUD_BASE_URL: "https://cloud.example/",
  PARACHUTE_CLOUD_ADMIN_BEARER: "operator_only_shh",
};

describe("admin CLI", () => {
  test("`reconcile` POSTs to /api/admin/reconcile with bearer", async () => {
    const { fetchImpl, calls } = recordingFetch({
      body: JSON.stringify({ ok: true, tierChanges: [], terminations: [] }),
    });
    const cap = captureOutput();
    const code = await main(["reconcile"], {
      env: ENV,
      fetchImpl,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://cloud.example/api/admin/reconcile");
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers?.authorization).toBe("Bearer operator_only_shh");
    // Pretty-printed JSON output.
    expect(cap.stdout.join("\n")).toContain('"ok": true');
  });

  test("`reconcile-tiers` and `reconcile-terminations` route to their endpoints", async () => {
    const { fetchImpl: f1, calls: c1 } = recordingFetch({ body: '{"ok":true}' });
    await main(["reconcile-tiers"], { env: ENV, fetchImpl: f1, ...captureOutput() });
    expect(c1[0]?.url).toBe("https://cloud.example/api/admin/reconcile-tiers");

    const { fetchImpl: f2, calls: c2 } = recordingFetch({ body: '{"ok":true}' });
    await main(["reconcile-terminations"], { env: ENV, fetchImpl: f2, ...captureOutput() });
    expect(c2[0]?.url).toBe("https://cloud.example/api/admin/reconcile-terminations");
  });

  test("missing BASE_URL → exit 1", async () => {
    const cap = captureOutput();
    const code = await main(["reconcile"], {
      env: { PARACHUTE_CLOUD_ADMIN_BEARER: "x" },
      fetchImpl: recordingFetch({}).fetchImpl,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(1);
    expect(cap.stderr.join("\n")).toContain("PARACHUTE_CLOUD_BASE_URL");
  });

  test("missing BEARER → exit 1", async () => {
    const cap = captureOutput();
    const code = await main(["reconcile"], {
      env: { PARACHUTE_CLOUD_BASE_URL: "https://x" },
      fetchImpl: recordingFetch({}).fetchImpl,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(1);
    expect(cap.stderr.join("\n")).toContain("PARACHUTE_CLOUD_ADMIN_BEARER");
  });

  test("unknown command → exit 2 with usage", async () => {
    const cap = captureOutput();
    const code = await main(["wat"], {
      env: ENV,
      fetchImpl: recordingFetch({}).fetchImpl,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(2);
    expect(cap.stderr.join("\n")).toContain("unknown command: wat");
  });

  test("no command → exit 2 with usage", async () => {
    const cap = captureOutput();
    const code = await main([], {
      env: ENV,
      fetchImpl: recordingFetch({}).fetchImpl,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(2);
    expect(cap.stdout.join("\n")).toContain("usage:");
  });

  test("--help → exit 0 with usage", async () => {
    const cap = captureOutput();
    const code = await main(["--help"], {
      env: ENV,
      fetchImpl: recordingFetch({}).fetchImpl,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(0);
    expect(cap.stdout.join("\n")).toContain("commands:");
  });

  test("non-2xx response → exit 1, body printed to stderr", async () => {
    const { fetchImpl } = recordingFetch({ status: 401, body: '{"error":"unauthorized"}' });
    const cap = captureOutput();
    const code = await main(["reconcile"], {
      env: ENV,
      fetchImpl,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(1);
    expect(cap.stderr.join("\n")).toContain("HTTP 401");
    expect(cap.stderr.join("\n")).toContain("unauthorized");
  });

  test("trailing slash on BASE_URL is normalized", async () => {
    const { fetchImpl, calls } = recordingFetch({ body: "{}" });
    await main(["reconcile"], { env: ENV, fetchImpl, ...captureOutput() });
    // ENV has trailing slash; the URL should not be doubled.
    expect(calls[0]?.url).toBe("https://cloud.example/api/admin/reconcile");
  });
});
