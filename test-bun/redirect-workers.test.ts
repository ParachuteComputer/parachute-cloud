/**
 * The legacy-host redirect workers (my.-canonical Phase 1).
 *
 * Two tiny standalone workers 301 legacy hosts onto the ONE canonical human
 * origin, my.parachute.computer, path + query preserved:
 *   - app-redirect:   app.parachute.computer/*   → my.  (a ZONE ROUTE that
 *                     shadows the identity worker's app. Custom Domain, so DEEP
 *                     SPA paths — asset-runtime-served, never reaching a worker —
 *                     are caught too).
 *   - notes-redirect: notes.parachute.computer/* → my.  (re-pointed from app. to
 *                     my. so old bookmarks don't take a notes.→app.→my. double-hop).
 *
 * This pins BOTH halves that a reviewer can't eyeball together: the redirect
 * LOGIC (import each worker, drive its fetch) and the committed zone-route
 * DECLARATIONS (Bun parses `.toml` on import). Runs under `bun test` (root suite).
 */
import { describe, expect, it } from "bun:test";
import appRedirect from "../workers/app-redirect/index.js";
import notesRedirect from "../workers/notes-redirect/index.js";
import appWrangler from "../workers/app-redirect/wrangler.toml";
import notesWrangler from "../workers/notes-redirect/wrangler.toml";

const MY = "https://my.parachute.computer";

interface Route {
  pattern: string;
  zone_name?: string;
}
interface WranglerShape {
  name?: string;
  routes?: Route[];
}

describe("app-redirect worker — app.parachute.computer/* → my. (301)", () => {
  it("redirects the root, path + query preserved", () => {
    const res = appRedirect.fetch(new Request("https://app.parachute.computer/"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${MY}/`);
  });

  it("redirects a DEEP SPA path (the whole reason it's a zone route), path + query preserved", () => {
    const res = appRedirect.fetch(new Request("https://app.parachute.computer/n/abc123?highlight=x"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${MY}/n/abc123?highlight=x`);
  });

  it("targets my., NOT app. (no self-loop)", () => {
    const loc = appRedirect.fetch(new Request("https://app.parachute.computer/settings")).headers.get("location") ?? "";
    expect(loc.startsWith(`${MY}/`)).toBe(true);
    expect(loc).not.toContain("app.parachute.computer");
  });

  it("declares the app.parachute.computer/* zone route, zone-scoped to parachute.computer", () => {
    const cfg = appWrangler as WranglerShape;
    const route = (cfg.routes ?? []).find((r) => r.pattern === "app.parachute.computer/*");
    expect(route, "app-redirect must declare the app.parachute.computer/* zone route").toBeDefined();
    expect(route!.zone_name).toBe("parachute.computer");
  });
});

describe("notes-redirect worker — notes.parachute.computer/* → my. (301, re-pointed from app.)", () => {
  it("redirects, path + query preserved, straight to my. (no notes.→app.→my. hop)", () => {
    const res = notesRedirect.fetch(new Request("https://notes.parachute.computer/n/x?q=2"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${MY}/n/x?q=2`);
  });

  it("no longer targets app.parachute.computer", () => {
    const loc = notesRedirect.fetch(new Request("https://notes.parachute.computer/")).headers.get("location") ?? "";
    expect(loc).toBe(`${MY}/`);
    expect(loc).not.toContain("app.parachute.computer");
  });

  it("still declares the notes.parachute.computer/* zone route", () => {
    const cfg = notesWrangler as WranglerShape;
    const route = (cfg.routes ?? []).find((r) => r.pattern === "notes.parachute.computer/*");
    expect(route, "notes-redirect must declare the notes.parachute.computer/* zone route").toBeDefined();
    expect(route!.zone_name).toBe("parachute.computer");
  });
});
