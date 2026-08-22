/**
 * Attachment tickets — the DO mirror of bun's runtime-lane implementation
 * (parachute-vault src/attachment-tickets.ts). Ground truth for the wire
 * shape is core's `core/src/attachment/tickets.ts` (the `AttachmentTicket`
 * record, `AttachmentTicketProvider` seam, TTL math, id generation) and
 * `core/src/mcp.ts`'s `request-attachment-upload` / `-download` mint tools —
 * this module supplies ONLY the cloud-specific storage + spend halves.
 *
 * `DoAttachmentTicketProvider` persists tickets in the vault DO's own
 * SQLite storage (the same `ctx.storage.sql` handle `DoSqliteStore` boots
 * against, via a private table this module owns — no core schema change).
 * `take` is an atomic SELECT+DELETE under `ctx.storage.transactionSync`
 * (single-writer DO ⇒ race-free single-use by construction, unlike bun's
 * plain `Map.delete` which needs no such guard because bun has no
 * concurrent-request model to race). `put` opportunistically deletes
 * already-expired rows first — see its doc comment for why this replaces a
 * dedicated sweep alarm.
 *
 * `handleTicketSpend` is the bare (no auth beyond the ticket itself) HTTP
 * handler `VaultDO.fetch()` dispatches to for `/vault/<name>/tickets/<id>`
 * — BEFORE `authenticateVaultRequest` runs, mirroring bun's `routing.ts`
 * placement exactly: the ticket IS the credential, and a bearer-less
 * `curl` must be able to spend it.
 */
import type {
  AttachmentTicket,
  AttachmentTicketProvider,
} from "@openparachute/core/src/attachment/tickets.js";
import { mimeForAttachmentExtension, sanitizeAttachmentExtension } from "@openparachute/core/src/attachment/policy.js";
import type { Store } from "@openparachute/core/src/types.js";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// `Record<string, SqlStorageValue>` (the index signature) is what
// `SqlStorage.exec<T>`'s generic constraint requires — every field below is
// already `ArrayBuffer | string | number | null`-shaped, so this is purely
// a type-system formality, not a behavior change.
interface TicketRow extends Record<string, SqlStorageValue> {
  id: string;
  kind: string;
  vault_name: string;
  created_at: number;
  expires_at: number;
  mime_type: string | null;
  size_bytes: number | null;
  note_id: string | null;
  filename: string | null;
  transcribe: number | null;
  attachment_id: string | null;
}

function rowToTicket(r: TicketRow): AttachmentTicket {
  return {
    id: r.id,
    kind: r.kind as AttachmentTicket["kind"],
    vaultName: r.vault_name,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    ...(r.mime_type !== null ? { mimeType: r.mime_type } : {}),
    ...(r.size_bytes !== null ? { sizeBytes: r.size_bytes } : {}),
    ...(r.note_id !== null ? { noteId: r.note_id } : {}),
    ...(r.filename !== null ? { filename: r.filename } : {}),
    ...(r.transcribe !== null ? { transcribe: r.transcribe === 1 } : {}),
    ...(r.attachment_id !== null ? { attachmentId: r.attachment_id } : {}),
  };
}

/**
 * DO-backed `AttachmentTicketProvider` — one table (`attachment_tickets`) in
 * the vault's own DO SQLite storage, created idempotently at construction
 * (the `DoSqliteStore`/`initSchema` pattern: a plain `CREATE TABLE IF NOT
 * EXISTS`, safe to re-run every DO wake). Rows are small (a few dozen bytes)
 * and short-lived (≤30 min TTL, `computeTicketTtlMs`), so this never
 * competes meaningfully with the vault's own note/tag/attachment data for
 * storage.
 */
export class DoAttachmentTicketProvider implements AttachmentTicketProvider {
  constructor(private readonly storage: DurableObjectStorage) {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS attachment_tickets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        vault_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER,
        note_id TEXT,
        filename TEXT,
        transcribe INTEGER,
        attachment_id TEXT
      )
    `);
  }

  /**
   * Insert the ticket. Opportunistically deletes already-expired rows FIRST
   * (a cheap indexed-by-nothing-but-bounded-cardinality DELETE — this
   * table only ever holds a vault's outstanding tickets, at most a handful
   * in practice) — this is the "storage-keyed sweep" the design calls for,
   * done at mint time rather than piggybacked on the DO's existing
   * transcription/embedding alarm. Deliberately NOT alarm-piggybacked: that
   * alarm's reentrancy guard (`alarmRunning`, vault-do.ts) is already
   * load-bearing and fragile-by-its-own-admission, and ticket rows are far
   * too small to need a periodic sweep — the next mint (or the `take`-time
   * expiry check every spend already runs) bounds any leak to "at most one
   * mint interval's worth of expired rows," which is negligible at a
   * ≤30-minute TTL. A vault that mints tickets rarely also grows this table
   * rarely.
   */
  async put(ticket: AttachmentTicket): Promise<void> {
    this.storage.sql.exec(`DELETE FROM attachment_tickets WHERE expires_at < ?`, Date.now());
    this.storage.sql.exec(
      `INSERT INTO attachment_tickets
         (id, kind, vault_name, created_at, expires_at, mime_type, size_bytes, note_id, filename, transcribe, attachment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ticket.id,
      ticket.kind,
      ticket.vaultName,
      ticket.createdAt,
      ticket.expiresAt,
      ticket.mimeType ?? null,
      ticket.sizeBytes ?? null,
      ticket.noteId ?? null,
      ticket.filename ?? null,
      ticket.transcribe === undefined ? null : ticket.transcribe ? 1 : 0,
      ticket.attachmentId ?? null,
    );
  }

  /**
   * Atomic check-and-consume — a single `transactionSync` wrapping a
   * SELECT + DELETE, both synchronous `ctx.storage.sql.exec` calls (the
   * ONLY operations `transactionSync`'s callback may perform — it forbids
   * `await`, so this cannot use the async KV `get`/`delete` pair, which
   * would leave a read-then-write gap another concurrent request could
   * interleave into). This is what makes single-use race-free BY
   * CONSTRUCTION on this door (core's `take` doc comment's promise) rather
   * than merely "true because bun has no concurrent-request model."
   */
  async take(id: string): Promise<AttachmentTicket | null> {
    return this.storage.transactionSync(() => {
      const rows = this.storage.sql.exec<TicketRow>(`SELECT * FROM attachment_tickets WHERE id = ?`, id).toArray();
      const row = rows[0];
      if (!row) return null;
      this.storage.sql.exec(`DELETE FROM attachment_tickets WHERE id = ?`, id);
      return rowToTicket(row);
    });
  }
}

/**
 * Take + validate a ticket against the URL's vault name and the spend
 * route's expected kind — same uniform-404 no-oracle posture as bun's
 * `takeValidTicket` (parachute-vault src/attachment-tickets.ts): spent,
 * expired, unknown, wrong-vault, and wrong-kind all collapse to the same
 * `null`.
 */
async function takeValidTicket(
  provider: AttachmentTicketProvider,
  id: string,
  vaultName: string,
  kind: AttachmentTicket["kind"],
): Promise<AttachmentTicket | null> {
  const ticket = await provider.take(id);
  if (!ticket) return null;
  if (ticket.kind !== kind || ticket.vaultName !== vaultName || ticket.expiresAt < Date.now()) {
    return null;
  }
  return ticket;
}

/** Byte-identical to bun's `ticketNotFound()` (src/attachment-tickets.ts). */
function ticketNotFound(): Response {
  return json(
    {
      error: "Not found",
      error_type: "not_found",
      how_to:
        "tickets are single-use and short-lived — mint a new one with request-attachment-upload / request-attachment-download",
    },
    404,
  );
}

/**
 * Everything `handleTicketSpend` needs from the DO, bundled the same way
 * `RestDeps` bundles REST's cross-cutting needs (rest/notes.ts). `mintGate`
 * is the SAME attachment gate ladder the mint tool runs (frozen →
 * `plan_required`; Entry `attachment_bytes===0` → `attachments_not_included`;
 * else cap math), RE-RUN here against the ACTUAL upload size — mint only
 * ever saw the caller's DECLARED size, so two tickets minted against the
 * same near-full budget must both be re-checked at spend or their combined
 * bytes could slip past the cap (the design's "re-checked against actual"
 * requirement).
 */
export interface TicketSpendDeps {
  vaultName: string;
  store: Store;
  provider: AttachmentTicketProvider;
  attachments: R2Bucket;
  mintGate: (declaredBytes: number) => Response | null;
  meterAdd: (bytes: number) => Promise<void>;
  scheduleTranscription: () => Promise<void>;
}

function r2Key(vaultName: string, relativePath: string): string {
  return `vault-${vaultName}/attachments/${relativePath}`;
}

/**
 * Dispatch a ticket spend request for `/vault/<name>/tickets/<id>`. PUT or
 * POST spends an upload ticket; GET spends a download ticket. Any other
 * method collapses to the same uniform 404 `takeValidTicket` uses.
 */
export async function handleTicketSpend(req: Request, ticketId: string, deps: TicketSpendDeps): Promise<Response> {
  if (req.method === "PUT" || req.method === "POST") return handleUploadSpend(req, ticketId, deps);
  if (req.method === "GET") return handleDownloadSpend(ticketId, deps);
  return ticketNotFound();
}

async function handleUploadSpend(req: Request, ticketId: string, deps: TicketSpendDeps): Promise<Response> {
  const ticket = await takeValidTicket(deps.provider, ticketId, deps.vaultName, "upload");
  if (!ticket || !ticket.noteId || !ticket.filename || !ticket.mimeType) return ticketNotFound();

  // Declared size at mint IS the ceiling this spend enforces (mirrors bun's
  // `declaredMax` exactly) — a ticket somehow minted with no declared size
  // fails closed (0 bytes allowed).
  const declaredMax = ticket.sizeBytes ?? 0;

  // Cloud streams the body straight into R2 (never buffers a whole
  // attachment in the 128 MB DO — the export-work discipline), which means
  // R2's PUT needs a KNOWN length up front (`FixedLengthStream`, same
  // primitive `export.ts`'s `streamTar` uses). bun can afford to buffer
  // first and check the length after; cloud cannot, so — unlike bun's
  // ticket spend — Content-Length is REQUIRED here. In practice this is
  // never a real constraint: the mint tool's own `curl_example` uses
  // `curl --data-binary @file`, which always sends Content-Length.
  const contentLengthHeader = req.headers.get("content-length");
  if (!contentLengthHeader) {
    return json(
      {
        error: "Content-Length header is required",
        error_type: "length_required",
        how_to: "send a Content-Length header — curl --data-binary sets this automatically",
      },
      411,
    );
  }
  const contentLength = Number(contentLengthHeader);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    return json({ error: "Invalid Content-Length header", error_type: "invalid_content_length" }, 400);
  }
  if (contentLength > declaredMax) {
    return json(
      {
        error: `Upload exceeds the ticket's declared size (${declaredMax} bytes)`,
        error_type: "file_too_large",
        limit: declaredMax,
        got: contentLength,
        how_to: "mint a new ticket with an accurate size_bytes",
      },
      413,
    );
  }
  if (!req.body) {
    return json({ error: "Request body is required", error_type: "missing_body" }, 400);
  }

  // Re-run the SAME gate ladder mint ran (frozen / attachments_not_included
  // / storage_cap_exceeded), now against the ACTUAL declared-at-spend size
  // — closes the TOCTOU window between mint and spend (see TicketSpendDeps'
  // doc comment). This is a raw REST-shaped Response (this endpoint is
  // outside both REST's `/api` tree and MCP's JSON-RPC envelope), so it's
  // returned exactly as the storage-upload gate would.
  const gated = deps.mintGate(contentLength);
  if (gated) return gated;

  // Server-generated path, never caller-controlled — same discipline as
  // REST's storage upload and bun's ticket spend.
  const ext = sanitizeAttachmentExtension(ticket.filename);
  const date = new Date().toISOString().split("T")[0]!;
  const filename = `${Date.now()}-${crypto.randomUUID()}${ext}`;
  const relativePath = `${date}/${filename}`;
  const key = r2Key(deps.vaultName, relativePath);

  // Streamed R2 write: a `FixedLengthStream` declares the exact byte count
  // up front (R2 requires a known length for a streamed PUT — see the
  // `export.ts streamTar` precedent), so the request body pipes straight
  // through without ever landing whole in DO memory. `put()` consumes the
  // readable CONCURRENTLY with the pipe — start it first, await both after.
  const fixed = new FixedLengthStream(contentLength);
  const putPromise = deps.attachments.put(key, fixed.readable, {
    // vault#617 — store the extension-derived type on the object, not the
    // caller-asserted ticket mime. Cloud REST GET /storage/ prefers
    // httpMetadata.contentType; leaving the asserted type here would re-open
    // the same hole on the byte-serve door.
    httpMetadata: { contentType: mimeForAttachmentExtension(ext) },
  });
  try {
    await req.body.pipeTo(fixed.writable);
    await putPromise;
  } catch (e) {
    await putPromise.catch(() => {});
    console.error(`[ticket-upload ${deps.vaultName}] failed: ${errText(e)}`);
    return json(
      { error: "Upload failed", error_type: "upload_failed", how_to: "mint a new ticket and retry" },
      500,
    );
  }

  await deps.meterAdd(contentLength);

  // Mirrors cloud REST's OWN `POST /notes/:id/attachments` transcribe
  // decision exactly (rest/notes.ts) — explicit `transcribe: true` at mint
  // is the only opt-in path on cloud (no bun-style auto-infer-from-mime;
  // cloud's `auto_transcribe` vault config isn't consulted by REST's own
  // attach route either, so the ticket spend stays in lockstep with it).
  const explicitOptIn = ticket.transcribe === true;
  const attMeta: Record<string, unknown> = { original_name: ticket.filename, size: contentLength };
  if (explicitOptIn) {
    attMeta.transcribe_status = "pending";
    attMeta.transcribe_requested_at = new Date().toISOString();
    attMeta.transcribe_origin = "legacy";
  }

  // Ticket mint + register in one shot (vs REST's two-step upload-then-
  // attach) — the spend response is the attachment row itself.
  const attachment = await deps.store.addAttachment(ticket.noteId, relativePath, ticket.mimeType, attMeta);

  if (explicitOptIn) {
    const note = await deps.store.getNote(ticket.noteId);
    if (note) {
      const noteMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};
      if (noteMeta.transcribe_stub !== true) {
        await deps.store.updateNote(ticket.noteId, {
          metadata: { ...noteMeta, transcribe_stub: true },
          skipUpdatedAt: true,
        });
      }
    }
    await deps.scheduleTranscription();
  }

  return json(attachment, 201);
}

async function handleDownloadSpend(ticketId: string, deps: TicketSpendDeps): Promise<Response> {
  const ticket = await takeValidTicket(deps.provider, ticketId, deps.vaultName, "download");
  if (!ticket || !ticket.attachmentId) return ticketNotFound();

  // The row can vanish between mint and spend (rare — a delete racing a
  // slow curl); fold that into the same uniform 404 rather than a 500.
  const attachment = await deps.store.getAttachment(ticket.attachmentId);
  if (!attachment) return ticketNotFound();

  const obj = await deps.attachments.get(r2Key(deps.vaultName, attachment.path));
  if (!obj) {
    return json(
      {
        error: "Not found",
        error_type: "attachment_binary_missing",
        how_to: "the attachment row exists but its bytes are gone — this ticket can't be re-spent",
      },
      404,
    );
  }

  // Streams straight from R2 (native chunk-wise `ReadableStream`, same as
  // the existing `GET /api/storage/<path>` byte-serve and `handleExport`'s
  // final serve) — never whole-buffered.
  // vault#617 — same discipline as bun ticket spend and bun REST GET
  // /storage/: extension wins over the row's caller-asserted mime_type.
  const contentType = mimeForAttachmentExtension(sanitizeAttachmentExtension(attachment.path));
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(obj.size),
      // Same defense-in-depth as every other byte-serve response on this
      // door: never let a browser MIME-sniff a stored asset into an active
      // type.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
