/**
 * The cloud import ceiling — must equal the vault worker's `MAX_IMPORT_BYTES`
 * (restore.ts). Separate Workers, no shared module; keep the two identical.
 *
 * Lives in its own file so test-bun/import-limit-parity.test.ts can import
 * the constant without typechecking the rest of console.ts under the root
 * bun+workers type environment (cloud#259).
 */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_MIB = 50;
