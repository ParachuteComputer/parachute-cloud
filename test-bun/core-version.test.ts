// The version both workers say (T-476: the brief's Docs line, the docs tool's pages, every refusal's `docs` address)
// is the pinned parachute-core's: a pin move that changes core's version must change both constants with it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

test("both workers' PARACHUTE_VERSION is scripts/core-source.env's PARACHUTE_CORE_VERSION", () => {
  const pinned = read("scripts/core-source.env").match(/^PARACHUTE_CORE_VERSION="([^"]+)"/m)?.[1];
  expect(pinned).toBeString();
  for (const file of ["workers/vault/src/docs.ts", "workers/identity/src/docs.ts"]) {
    const said = read(file).match(/export const PARACHUTE_VERSION = "([^"]+)";/)?.[1];
    expect({ file, version: said }).toEqual({ file, version: pinned });
  }
});
