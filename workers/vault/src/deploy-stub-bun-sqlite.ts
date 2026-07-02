// Deploy-time stub for `bun:sqlite`, aliased in via wrangler.toml `[alias]` —
// the production mirror of the vitest `bun:sqlite` alias (vitest.config.ts).
//
// `@openparachute/core` value-imports `Database` from `bun:sqlite` purely for
// type positions; esbuild erases that at transpile, so the deployed bundle
// already carries no real `bun:sqlite` reference (verified by `verify:bundle`).
// This alias is belt-and-suspenders: if a future core change ever makes the
// import non-type-only, `wrangler deploy` resolves it here instead of failing on
// a module workerd cannot provide. The real runtime handle is the DO-SQLite
// `DatabaseShim` (src/shim.ts), injected into the store — never this class.
export class Database {}
export type SQLQueryBindings = unknown;
