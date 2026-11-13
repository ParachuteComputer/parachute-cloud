// Engine rollback rehearsal (T-456, first for the 0.9.3 search DDL): a vault the new engine wrote, opened and written
// by the engine a rollback would return to, then by the new one again. Each step is its own process with one engine
// (`<engine>` is a parachute-core checkout's packages/vault/core/src), on one SQLite file:
//   bun scripts/engine-rollback-rehearsal.ts <new engine> <file> new1
//   bun scripts/engine-rollback-rehearsal.ts <old engine> <file> old
//   bun scripts/engine-rollback-rehearsal.ts <new engine> <file> new2
// Run it from a directory with bun:sqlite (any checkout with bun installed), with NODE_ENV=test and a throwaway
// PARACHUTE_HOME. Made-up notes only. Exit 1 on any check that fails; prints one line per check. On 11-13 against
// core next + #112 (new) and core 53f956f (Cloud's 0.8 engine): every check passed.
import { Database } from "bun:sqlite";

const [engine, file, step] = process.argv.slice(2);
const { BunSqliteStore } = await import(`${engine}/store.ts`);
const db = new Database(file!);
const store = new BunSqliteStore(db);
let bad = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${step}: ${what}`);
  if (!ok) bad++;
};
const ids = async (q: string) => (await store.searchNotes(q)).map((n: { path?: string }) => n.path).sort();

if (step === "new1") {
  await store.upsertTagRecord("project", { fields: { client: { type: "string", indexed: true } } });
  await store.createNote("Fernhill bakery order, body words", { path: "a/one", tags: ["project"], metadata: { client: "propolis" } });
  await store.createNote("plain note about sourdough", { path: "a/two" });
  check(JSON.stringify(await ids("propolis")) === JSON.stringify(["a/one"]), "a field value is searchable");
}
if (step === "old") {
  check(JSON.stringify(await ids("sourdough")) === JSON.stringify(["a/two"]), "the old engine opens the vault and finds a body word");
  await store.createNote("rye starter written by the old engine", { path: "b/old", tags: ["project"], metadata: { client: "quince" } });
  const one = (await store.queryNotes({ path: "a/one" } as never))[0];
  await store.updateNote(one.id, { content: "Fernhill bakery order, edited by the old engine", metadata: { client: "marmalade" } });
  check(JSON.stringify(await ids("rye")) === JSON.stringify(["b/old"]), "a note the old engine writes is found by a body word");
  check(JSON.stringify(await ids("edited")) === JSON.stringify(["a/one"]), "an edit by the old engine is found by its new body word");
  await store.deleteNote((await store.queryNotes({ path: "a/two" } as never))[0].id);
  check((await ids("sourdough")).length === 0, "a note the old engine deletes leaves the index");
}
if (step === "new2") {
  check(JSON.stringify(await ids("rye")) === JSON.stringify(["b/old"]), "back on the new engine, the old engine's note is found");
  check(JSON.stringify(await ids("marmalade")) === JSON.stringify(["a/one"]), "the old engine's field edit is searchable on the new engine");
  check(JSON.stringify(await ids("quince")) === JSON.stringify(["b/old"]), "the old engine's new note's field is searchable on the new engine");
  check((await ids("propolis")).length === 0, "the field value the old engine replaced no longer matches");
}
const integrity = (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
check(integrity === "ok", `integrity_check ${integrity}`);
try {
  db.query("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')").run();
  check(true, "fts5 integrity-check");
} catch (e) {
  check(false, `fts5 integrity-check: ${(e as Error).message}`);
}
process.exit(bad ? 1 : 0);
