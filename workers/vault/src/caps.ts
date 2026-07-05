/**
 * Per-tenant storage caps — TWO-METER (the pricing model, 2026-07-05).
 *
 * A vault's DO config carries `caps: { notes_bytes, attachment_bytes }`: the
 * SQLite graph (`sql.databaseSize`) is checked against `notes_bytes`, and the
 * R2 attachment meter against `attachment_bytes`, as SEPARATE budgets. Each
 * over-budget byte-growing write is refused (the notes gate before a note/tag/
 * pack write; the attachment gate before a storage upload). `attachment_bytes:
 * 0` is a legal value (the Entry "notes-only" tier) → a distinct 403
 * `attachments_not_included`. DELETE is exempt on both meters.
 *
 * BACK-COMPAT (an un-pushed / not-yet-migrated vault is UNCHANGED):
 *   - `caps` present            → two-meter (this module's `notes`/`attachment`).
 *   - else `cap_bytes` present  → the LEGACY single summed cap (db + r2 ≤ cap).
 *   - else the env default.
 * The vault DO resolves which mode it's in; this module supplies the pure
 * computations + the wire responses.
 *
 * FROZEN (the expired floor): an independent `frozen: true` flag the DO checks
 * BEFORE any cap math on writes → 402 `plan_required` (reads + export + DELETE
 * untouched — "your notes are safe").
 *
 * The R2 meter is a DO-storage counter maintained by the storage upload/delete
 * paths (R2 has no cheap per-prefix size query), so the check stays O(1).
 */
export const R2_METER_KEY = "r2_bytes";

/** Which meter a 413 fired against (additive field on the response, 2026-07-05). */
export type CapMeter = "notes" | "attachments";

/**
 * The 413 storage-cap shape. `meter` is ADDITIVE (present in two-meter mode:
 * "notes" | "attachments"); legacy single-cap 413s omit it, byte-shape unchanged.
 */
export function capExceededResponse(used: number, cap: number, attempted: number, meter?: CapMeter): Response {
  return Response.json(
    {
      error_type: "storage_cap_exceeded",
      error: "storage_cap_exceeded",
      message: `storage cap exceeded: ${used} + ${attempted} bytes would exceed the ${cap}-byte cap${
        meter ? ` (${meter})` : ""
      }`,
      used_bytes: used,
      cap_bytes: cap,
      attempted_bytes: attempted,
      ...(meter ? { meter } : {}),
    },
    { status: 413 },
  );
}

/**
 * 403 `attachments_not_included` — the vault's plan carries NO attachment budget
 * (the Entry notes-only tier: `attachment_bytes === 0`). Returned BEFORE any cap
 * math so the message is about the ENTITLEMENT, not a full meter.
 */
export function attachmentsNotIncludedResponse(): Response {
  return Response.json(
    {
      error_type: "attachments_not_included",
      error: "attachments_not_included",
      message: "This plan doesn't include file attachments. Upgrade to a plan with an attachment budget to upload files.",
    },
    { status: 403 },
  );
}

/**
 * 402 `plan_required` — the vault is FROZEN (the expired floor: the trial ended
 * or the subscription lapsed). Writes are refused; reads + export are untouched.
 * The trust flex: your notes are safe, pick a plan or export anytime.
 */
export function planRequiredResponse(): Response {
  return Response.json(
    {
      error_type: "plan_required",
      error: "plan_required",
      message: "Your trial has ended — this vault is read-only. Your notes are safe to read and export anytime; pick a plan to write again.",
    },
    { status: 402 },
  );
}

/**
 * Current used bytes = live SQLite size + metered R2 bytes. `sql.databaseSize`
 * is synchronous; the R2 meter is read from DO storage by the caller (kept as a
 * param so this stays a pure computation, easy to unit-test). The LEGACY single
 * summed cap uses this; the two-meter path checks db and r2 independently.
 */
export function usedBytes(databaseSize: number, r2Bytes: number): number {
  return databaseSize + r2Bytes;
}

/** Returns the effective LEGACY cap for this DO: per-DO override, else the env
 *  default. (Two-meter vaults don't use this — see the DO's own resolution.) */
export function resolveCap(perDoCap: number | undefined, envCapBytes: string | undefined): number {
  if (typeof perDoCap === "number" && perDoCap > 0) return perDoCap;
  const parsed = envCapBytes ? Number(envCapBytes) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1024 * 1024 * 1024; // 1 GiB fallback
}
