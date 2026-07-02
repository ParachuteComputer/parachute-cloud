// Stub for `bun:sqlite` under workerd. Core value-imports `Database` only for
// type positions (erased at transpile); this alias target guarantees nothing
// pulls a real bun:sqlite into the Worker bundle.
export class Database {}
export type SQLQueryBindings = unknown;
