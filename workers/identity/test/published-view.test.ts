/**
 * The descriptor says this door serves a published record's page (T-476): the vault worker answers
 * `GET <vault>/view/<id>` (workers/vault/src/view.ts), and the Parachute app gives a published record's link only on a
 * door that says so (app src/vault/published.ts viewBase: before this, every Cloud-kind door got no link, because the
 * page was a 404). Additive, like `connections`: a reader that only knows the shared capabilities sees them unchanged.
 */
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import app from "../src/index.ts";
import { ISSUER } from "./helpers.ts";

describe("the descriptor advertises the published page", () => {
  test("capabilities.published_view is true", async () => {
    const res = await app.fetch(new Request(`${ISSUER}/.well-known/parachute-account`), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capabilities: Record<string, unknown> };
    expect(body.capabilities.published_view).toBe(true);
  });
});
