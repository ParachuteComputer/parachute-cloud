/**
 * Per-tenant storage caps. Enforced in-DO at write time: the SQLite database
 * size (`sql.databaseSize`) plus a running R2-usage meter is checked against the
 * tenant's `cap_bytes` before a byte-growing write commits. Over the cap →
 * the documented 413 `storage_cap_exceeded` shape.
 *
 * The R2 meter is a DO-storage counter maintained by the storage upload/delete
 * paths (R2 has no cheap per-prefix size query), so the check stays O(1).
 */
export const R2_METER_KEY = "r2_bytes";

export function capExceededResponse(used: number, cap: number, attempted: number): Response {
  return Response.json(
    {
      error_type: "storage_cap_exceeded",
      error: "storage_cap_exceeded",
      message: `storage cap exceeded: ${used} + ${attempted} bytes would exceed the ${cap}-byte cap`,
      used_bytes: used,
      cap_bytes: cap,
      attempted_bytes: attempted,
    },
    { status: 413 },
  );
}

/**
 * Current used bytes = live SQLite size + metered R2 bytes. `sql.databaseSize`
 * is synchronous; the R2 meter is read from DO storage by the caller (kept as a
 * param so this stays a pure computation, easy to unit-test).
 */
export function usedBytes(databaseSize: number, r2Bytes: number): number {
  return databaseSize + r2Bytes;
}

/** Returns the effective cap for this DO: per-DO override, else the env default. */
export function resolveCap(perDoCap: number | undefined, envCapBytes: string | undefined): number {
  if (typeof perDoCap === "number" && perDoCap > 0) return perDoCap;
  const parsed = envCapBytes ? Number(envCapBytes) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1024 * 1024 * 1024; // 1 GiB fallback
}
