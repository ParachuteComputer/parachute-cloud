/**
 * MAX_IMPORT_BYTES is duplicated across two SEPARATE Workers (no shared module):
 * the identity worker refuses an oversize upload early (console.ts) and the vault
 * worker's DO enforces the same ceiling on the internal import (restore.ts). The
 * two must stay identical, or a file the console accepts would 413 at the DO (or
 * vice-versa). Until now they were pinned only by a code comment — this pins the
 * equality itself, importing BOTH real constants.
 *
 * Runs under `bun test` (root suite): bare specifiers in each worker's source
 * resolve from that worker's own node_modules by walking up from the file, so
 * both modules load here without a workerd pool.
 */
import { describe, expect, it } from "bun:test";
import { MAX_IMPORT_BYTES as IDENTITY_MAX } from "../workers/identity/src/console.ts";
import { MAX_IMPORT_BYTES as VAULT_MAX } from "../workers/vault/src/restore.ts";

describe("import ceiling parity (identity ↔ vault)", () => {
  it("identity's MAX_IMPORT_BYTES equals the vault worker's", () => {
    expect(IDENTITY_MAX).toBe(VAULT_MAX);
    // And it is the documented 50 MiB (a stray edit to one side must fail above).
    expect(IDENTITY_MAX).toBe(50 * 1024 * 1024);
  });
});
