/**
 * `GET /vault/<name>/view/<idOrPath>`: a published record as a plain web page, for anyone with its link (T-476).
 *
 * The box serves the same page (core packages/vault/src/routes.ts `handleViewNote`, routing.ts): a record is
 * published when it carries the `publish` tag or `metadata.published === true`, and a reader with no credential sees
 * only those. A credential that reads this whole vault sees an unpublished record too, as on the box; a credential
 * with a tag scope (`scoped_tags`) reads the page as a stranger does. A reference is resolved among the records the
 * reader may see (the box's resolveVisibleNote), so a private record never hides a published one, nor shows it
 * exists by doing so. Every other answer is the same plain 404, so a stranger can't tell a missing record from a
 * private one, nor a missing vault from either; another method is 405 for every vault alike.
 *
 * The renderer is the box's, ported as it is (no HTML from the record survives: everything is escaped, and a link
 * keeps its href only for http(s), mailto, # and /), and so is the page's CSP: no scripts at all.
 */
import type { Note, Store } from "@openparachute/core/src/types.js";
import { resolveVisibleNote } from "@openparachute/core/src/mcp.js";
import { resolveNote } from "./rest/parse.js";

/** `/view/<idOrPath>`: a published record's page. */
export const VIEW_PATH = /^\/view\/(.+)$/;

const PUBLISHED_TAG = "publish";

export function isPublished(note: Pick<Note, "tags" | "metadata">): boolean {
  if (note.tags?.includes(PUBLISHED_TAG)) return true;
  const meta = note.metadata as Record<string, unknown> | undefined;
  return meta?.published === true;
}

export function viewNotFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export function viewMethodNotAllowed(): Response {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" } });
}

/**
 * Answer a view of `idOrPath`. `wholeVault`: the request carried a credential that reads this whole vault.
 * Anything that fails to resolve (missing, ambiguous, a bad name) is the same 404 a private record gets: an
 * ambiguity would otherwise name the candidates' ids to a stranger.
 */
export async function handleView(store: Store, idOrPath: string, wholeVault: boolean): Promise<Response> {
  let note: Note | null = null;
  try {
    note = wholeVault
      ? await resolveNote(store, idOrPath)
      : resolveVisibleNote(store.db as unknown as Parameters<typeof resolveVisibleNote>[0], idOrPath, isPublished);
  } catch {
    note = null;
  }
  if (!note || (!wholeVault && !isPublished(note))) return viewNotFound();

  const title = note.path?.split("/").pop()?.replace(/\.[^.]+$/, "") ?? note.id;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body {
    max-width: 42rem;
    margin: 2rem auto;
    padding: 0 1rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
  }
  pre {
    background: #f5f5f5;
    padding: 1rem;
    border-radius: 4px;
    overflow-x: auto;
  }
  code {
    font-size: 0.9em;
    background: #f5f5f5;
    padding: 0.15em 0.3em;
    border-radius: 3px;
  }
  pre code {
    background: none;
    padding: 0;
  }
  a { color: #0066cc; }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; }
  ul { padding-left: 1.5em; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e0e0e0; }
    pre, code { background: #2a2a2a; }
    a { color: #66b3ff; }
  }
</style>
</head>
<body>
${renderMarkdown(note.content ?? "")}
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'",
      // A record can be unpublished at any time: no shared cache keeps serving it.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      // The page can be opened with ?key= and carries outbound links: they never learn the address.
      "Referrer-Policy": "no-referrer",
    },
  });
}

// The box's renderer (core packages/vault/src/routes.ts escapeHtml / renderMarkdown / inlineMarkdown), unchanged.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        out.push("</code></pre>");
        inCodeBlock = false;
      } else {
        out.push("<pre><code>");
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      out.push(escapeHtml(line));
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      out.push("");
      continue;
    }

    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1]!.length;
      out.push(`<h${level}>${inlineMarkdown(escapeHtml(headerMatch[2]!))}</h${level}>`);
      continue;
    }

    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const items: string[] = [trimmed.slice(2)];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!.trim();
        if (next.startsWith("- ") || next.startsWith("* ")) {
          items.push(next.slice(2));
          i++;
        } else break;
      }
      out.push("<ul>");
      for (const item of items) out.push(`<li>${inlineMarkdown(escapeHtml(item))}</li>`);
      out.push("</ul>");
      continue;
    }

    out.push(`<p>${inlineMarkdown(escapeHtml(trimmed))}</p>`);
  }

  if (inCodeBlock) out.push("</code></pre>");
  return out.join("\n");
}

function inlineMarkdown(html: string): string {
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/`(.+?)`/g, "<code>$1</code>");
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, (_match, text, url) => {
    const decoded = url.replace(/&amp;/g, "&");
    if (/^(https?:|mailto:|#|\/)/i.test(decoded)) return `<a href="${url}">${text}</a>`;
    return text;
  });
  return html;
}
