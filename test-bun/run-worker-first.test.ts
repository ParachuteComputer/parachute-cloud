/**
 * The `run_worker_first` config drift-catcher (P1.1, parachute-cloud#116).
 *
 * `workers/identity/wrangler.toml` [assets].run_worker_first is a hand-written
 * TOML array — but it MUST stay byte-equal to the P0.4 route manifest, or a
 * ceremony route added to `route-manifest.ts` without regenerating the config
 * would let the SPA catch-all shadow it. This test reads the committed TOML
 * (Bun parses `.toml` on import) and asserts BOTH the production and the staging
 * arrays equal `runWorkerFirstRules()` exactly — extending the route-manifest
 * drift-catcher from the router to the serving config.
 *
 * Runs under `bun test` (root suite): the manifest is pure TS with no workerd
 * deps, and Bun (unlike the workerd vitest pool) has fs + native TOML import.
 */
import { describe, expect, it } from "bun:test";
import wrangler from "../workers/identity/wrangler.toml";
import { runWorkerFirstRules } from "../workers/identity/src/route-manifest.ts";

interface AssetsBlock {
  directory?: string;
  binding?: string;
  not_found_handling?: string;
  run_worker_first?: string[];
}
interface WranglerShape {
  assets?: AssetsBlock;
  env?: { staging?: { assets?: AssetsBlock } };
}
const cfg = wrangler as WranglerShape;

describe("run_worker_first config ↔ the P0.4 manifest (P1.1)", () => {
  const expected = runWorkerFirstRules();

  it("the manifest derives a sane rule set (positive control)", () => {
    // Guard against a vacuous pass if the manifest ever yields an empty set.
    expect(expected.length).toBeGreaterThan(20);
    expect(expected).toContain("/oauth/*");
    expect(expected).toContain("/");
    expect(expected).toContain("!/oauth/callback");
  });

  it("production [assets].run_worker_first is byte-equal to runWorkerFirstRules()", () => {
    expect(cfg.assets?.run_worker_first).toEqual(expected);
  });

  it("[env.staging.assets].run_worker_first is byte-equal to runWorkerFirstRules()", () => {
    expect(cfg.env?.staging?.assets?.run_worker_first).toEqual(expected);
  });

  it("staging and production share the identical rule set", () => {
    expect(cfg.env?.staging?.assets?.run_worker_first).toEqual(cfg.assets?.run_worker_first);
  });

  it("both assets blocks carry the same directory / binding / SPA fallback", () => {
    for (const block of [cfg.assets, cfg.env?.staging?.assets]) {
      expect(block?.directory).toBe("./dist-assets");
      expect(block?.binding).toBe("ASSETS");
      expect(block?.not_found_handling).toBe("single-page-application");
    }
  });
});
