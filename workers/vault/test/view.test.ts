/**
 * A published record's page, for anyone with its link (T-476): `GET /vault/<name>/view/<idOrPath>`, as the box serves
 * it (core packages/vault/src/routes.ts handleViewNote). Before this, the Parachute app's link for a published record
 * on a Cloud or personal door was a 404 (T-476 walk). Made-up records only.
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base, createNote, freshVault, mintToken } from "./helpers.ts";

const view = (v: string, idOrPath: string, headers: Record<string, string> = {}, method = "GET") =>
  SELF.fetch(`${base(v)}/view/${idOrPath}`, { method, headers });

describe("a published record's page", () => {
  it("anyone reads a record published by tag or by field, by id or by path, as a plain page with no scripts", async () => {
    const v = freshVault("view");
    const byTag = await createNote(v, { path: "posts/bread", content: "# Bread\n\nFlour, **water**, salt.", tags: ["publish"] });
    const byField = await createNote(v, { path: "posts/soup", content: "Soup for *two*.", metadata: { published: true } });
    for (const ref of [byTag.id, "posts%2Fbread"]) {
      const r = await view(v, ref);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(r.headers.get("content-security-policy")).toContain("script-src 'none'");
      expect(r.headers.get("cache-control")).toBe("no-store");
      const html = await r.text();
      expect(html).toContain("<title>bread</title>");
      expect(html).toContain("<h1>Bread</h1>");
      expect(html).toContain("<strong>water</strong>");
    }
    const soup = await view(v, byField.id);
    expect(soup.status).toBe(200);
    expect(await soup.text()).toContain("<em>two</em>");
  });

  it("a record nobody published is the same 404 as one that doesn't exist, to a stranger and to a bad key", async () => {
    const v = freshVault("viewp");
    const priv = await createNote(v, { path: "diary/today", content: "made-up private words" });
    const missing = await view(v, `${priv.id}x`);
    expect(missing.status).toBe(404);
    const missingText = await missing.text();
    const asks: Record<string, string>[] = [{}, { Authorization: "Bearer not-a-token" }];
    for (const headers of asks) {
      const r = await view(v, priv.id, headers);
      expect(r.status).toBe(404);
      expect(await r.text()).toBe(missingText);
      expect((await view(v, "diary%2Ftoday", headers)).status).toBe(404);
    }
  });

  it("a key that reads the whole vault sees an unpublished record too, as on the box; one for another vault doesn't", async () => {
    const v = freshVault("viewk");
    const priv = await createNote(v, { path: "diary/mine", content: "made-up words for the owner" });
    const reader = await mintToken({ vault: v, scopes: `vault:${v}:read` });
    const r = await view(v, priv.id, { Authorization: `Bearer ${reader}` });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("made-up words for the owner");
    const other = freshVault("viewo");
    const elsewhere = await mintToken({ vault: other, scopes: `vault:${other}:read` });
    expect((await view(v, priv.id, { Authorization: `Bearer ${elsewhere}` })).status).toBe(404);
  });

  it("no HTML from a record reaches the page, and a link keeps its href only when it is safe", async () => {
    const v = freshVault("viewx");
    const n = await createNote(v, {
      path: "posts/xss",
      content: '<script>alert(1)</script> <img src=x onerror="alert(2)">\n\n[ok](https://example.com/a) [bad](javascript:alert(3))',
      tags: ["publish"],
    });
    const html = await (await view(v, n.id)).text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('<a href="https://example.com/a">ok</a>');
    expect(html).not.toContain("javascript:");
  });

  it("a vault nobody made answers 404 and is not made by asking", async () => {
    const v = freshVault("viewnone");
    const r = await view(v, "anything");
    expect(r.status).toBe(404);
    await runInDurableObject(env.VAULT.get(env.VAULT.idFromName(v)), async (_inst, state) => {
      expect(await state.storage.get("config")).toBeUndefined();
    });
  });

  it("only reads: another method is 405, for a vault that exists and one nobody made alike", async () => {
    const v = freshVault("viewm");
    const n = await createNote(v, { path: "posts/m", content: "x", tags: ["publish"] });
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await view(v, n.id, {}, method)).status).toBe(405);
      expect((await view(freshVault("viewmnone"), "x", {}, method)).status).toBe(405);
    }
  });

  it("a private record never hides a published one, by title, path or extension", async () => {
    const v = freshVault("viewshadow");
    const bread = await createNote(v, { path: "posts/bread", content: "# Bread\n\npublished bread", tags: ["publish"] });
    await createNote(v, { path: "drafts/bread-2", content: "# Bread\n\nprivate draft" });
    const byTitle = await view(v, "Bread");
    expect(byTitle.status).toBe(200);
    expect(await byTitle.text()).toContain("published bread");
    await createNote(v, { path: "posts/bread.txt", content: "private text", extension: "txt" });
    const byPath = await view(v, encodeURIComponent("posts/bread"));
    expect(byPath.status).toBe(200);
    expect(await byPath.text()).toContain("published bread");
    expect((await view(v, bread.id)).status).toBe(200);
  });

  it("while an import runs, the page answers as for a vault nobody made (no 401 naming it)", async () => {
    const v = freshVault("viewimport");
    const n = await createNote(v, { path: "posts/i", content: "x", tags: ["publish"] });
    const stub = env.VAULT.get(env.VAULT.idFromName(v));
    await runInDurableObject(stub, async (inst) => {
      (inst as unknown as { importRun: string | null }).importRun = "import";
    });
    try {
      const r = await view(v, n.id);
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("Not Found");
      expect((await view(v, n.id, {}, "POST")).status).toBe(405);
    } finally {
      await runInDurableObject(stub, async (inst) => {
        (inst as unknown as { importRun: string | null }).importRun = null;
      });
    }
  });
});
