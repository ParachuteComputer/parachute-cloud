#!/usr/bin/env bun
// Every backticked repo path in the agent-facing docs (AGENTS.md, CLAUDE.md, PROCESS.md) must exist.
// Agents follow these files literally, so a path that moved is a wrong instruction (audit L7-02).
// What counts: a backticked token that ends in a file extension, or a slash path whose first part is
// a real folder here (so branch names, MIME types and other repos' paths are left alone). It passes
// if it exists from the doc's folder or the repo root, or, written short, as the tail of a tracked
// path (`deploy-prod.sh`, `src/health.ts`). Globs, placeholders, URLs, ~ and $ paths, flags, build
// output (dist/, node_modules/), bare runtime file names (config.yaml, .env) and paths in other
// repos (../parachute-core, parachute-cloud/...) are skipped.
// Usage: bun scripts/check-doc-paths.ts   (exit 1 lists every missing path as file:line `path`)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docNames = new Set(["AGENTS.md", "CLAUDE.md", "PROCESS.md"]);
const listed = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
const docs = listed.filter((p) => docNames.has(p.split("/").pop() ?? ""));
const EXT = /\.(md|ts|tsx|js|mjs|json|jsonc|toml|ya?ml|sh|sql|html|css|env)$/;
const SOURCE = /\.(md|ts|tsx|js|mjs|sh|sql)$/; // a bare name with these is a repo file; .json/.yaml/.env ones are runtime files
const SKIP = /[\s*<>{}$~|]|^https?:|^[-@]|:\/\/|^\.\.\.|^\/|^[A-Z_]+=|\(|^parachute[-.]/; // parachute-*: another repo

const tracked = listed.filter(Boolean);
const isTail = (p: string) =>
  tracked.some(
    (t) => t === p || t.endsWith(`/${p}`) || t.includes(`/${p}/`) || t.startsWith(`${p}/`),
  );
const inRepo = (p: string) => !relative(root, p).startsWith("..") && existsSync(p);
const BUILD = /(^|\/)(dist|node_modules|\.cache)(\/|$)/;

const missing: string[] = [];
for (const doc of docs) {
  const lines = readFileSync(join(root, doc), "utf8").split("\n");
  let fenced = false;
  lines.forEach((line: string, i: number) => {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    if (fenced) return;
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const raw = m[1]
        .trim()
        .replace(/:\d+(-\d+)?$/, "")
        .replace(/[#?].*$/, "");
      if (!raw || SKIP.test(raw) || BUILD.test(raw)) continue;
      if (!/^[\w.@/+-]+$/.test(raw)) continue; // code, not a path
      const bases = [resolve(root, dirname(doc)), root];
      const candidates = bases.map((b) => resolve(b, raw));
      if (candidates.every((c) => relative(root, c).startsWith(".."))) continue; // outside the repo
      if (!raw.includes("/")) {
        if (!SOURCE.test(raw)) continue; // a bare runtime name (config.yaml) or a word
      } else if (!EXT.test(raw)) {
        const first = raw.replace(/^\.\//, "").split("/")[0];
        if (!bases.some((b) => inRepo(resolve(b, first)))) continue; // a branch name, a MIME type, not a path here
      }
      if (candidates.some(inRepo)) continue;
      if (isTail(raw.replace(/^\.\//, "").replace(/\/$/, ""))) continue;
      missing.push(`${doc}:${i + 1} \`${raw}\``);
    }
  });
}
if (missing.length) {
  console.error(
    `doc paths: ${missing.length} backticked path(s) in ${docs.length} doc(s) don't exist:`,
  );
  for (const m of missing) console.error(`  ${m}`);
  console.error(
    "Fix the path, or write it without backticks if it isn't meant to be in this repo.",
  );
  process.exit(1);
}
console.log(`doc paths: ok (${docs.length} docs: ${docs.join(", ")})`);
