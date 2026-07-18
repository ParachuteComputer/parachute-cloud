/**
 * Cloud voice-transcription pipeline — the pure body-transform helpers +
 * shared markers (cloud#56; per-segment slots added voice W2).
 *
 * These mirror the self-host transcription worker's "never destroy content"
 * body policy (parachute-vault src/transcription-worker.ts) so a voice memo
 * captured against a cloud vault resolves EXACTLY like one captured against a
 * bun vault: the `_Transcript pending._` placeholder Notes seeds
 * (parachute-surface memoNoteContent) is surgically replaced with the
 * transcript on success, or a terminal marker on failure — never an eternal
 * spinner.
 *
 * ## Per-segment slots (voice W2 — a BYTE-EXACT cross-door contract)
 *
 * A long recording can be split into several audio segments that all attach to
 * ONE note. When an attachment carries `metadata.segment_index` (an integer
 * ≥ 0, client-set at link time), its markers gain a `(part N)` suffix — where
 * **N = segment_index + 1, decimal** — so each segment resolves into its OWN
 * slot in the shared note body instead of fighting over a single bare marker:
 *
 *   - pending:      `_Transcript pending (part N)._`
 *   - unavailable:  `_Transcription unavailable (part N)._`
 *
 * Attachments WITHOUT a segment_index keep the BARE markers byte-identically
 * (zero change to every existing single-memo flow). The monthly-limit marker
 * is UN-PARTED by design (a shared string) — a segment that hits the cap has
 * its part-N pending marker replaced IN PLACE by the bare limit marker, which
 * leaves the other parts' slots untouched. The exact marker strings are the
 * contract the bun vault ships identically and the notes-ui status chip keys
 * off — never reword them without a coordinated cross-door + surface change.
 *
 * The orchestration (list pending, read R2 audio, call the provider, meter the
 * minutes, honor retention, re-arm the alarm) lives in the DO (vault-do.ts);
 * only the pure string transforms + the marker vocabulary live here, so they
 * unit-test without a DO/R2/AI binding.
 */

/** Placeholder Notes seeds at capture time (`_Transcript pending._`). */
export const TRANSCRIPT_PLACEHOLDER = /_Transcript pending\._/;

/**
 * Terminal-failure marker. **Load-bearing copy**: the notes-ui status chip
 * (parachute-surface TranscriptionStatus.tsx) keys off this EXACT string to
 * render "Transcription unavailable — open the audio below…", so it must stay
 * byte-identical to the self-host marker. Don't change without a coordinated
 * surface change.
 */
export const TRANSCRIPT_UNAVAILABLE = "_Transcription unavailable._";

/**
 * Soft-cap marker — the account is out of monthly voice minutes. Distinct from
 * "unavailable" (a failure) so the copy is honest: the audio is fine, the
 * budget isn't. The chip treats it as neither pending nor unavailable (plain
 * body text, no spinner) — the honest resting state until the meter resets.
 * ALWAYS un-parted, even for a segmented attachment (see the file header).
 */
export const TRANSCRIPT_LIMIT_REACHED =
  "_Monthly voice limit reached — transcription resumes next month._";

/**
 * On a successful (re)transcription the transcript replaces whichever marker is
 * currently in the body — the original placeholder on a first-try success, OR a
 * prior terminal/limit marker if we're retrying after a failure or a cap reset.
 * Matching all three lands the transcript exactly where a first-try success
 * would, preserving the surrounding capture body (the `![[memo]]` embed, the
 * `_Recorded …_` line, the header). No `/g` — a canonical capture body holds
 * exactly one marker; first-match is the target. (The bare, un-segmented case.)
 */
export const TRANSCRIPT_SUCCESS_TARGET =
  /_Transcript pending\._|_Transcription unavailable\._|_Monthly voice limit reached[^\n]*\._/;

/** Every terminal/limit marker, for the "already-terminal, don't stack" guard.
 *  (The bare, un-segmented case.) */
const ANY_TERMINAL_MARKER = /_Transcription unavailable\._|_Monthly voice limit reached[^\n]*\._/;

/** Escape a literal string for use inside a `RegExp` (the marker strings carry
 *  `(`, `)`, and `.`, all regex metacharacters). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The 1-based part number (N = segment_index + 1) for an attachment, or
 * `undefined` when it is NOT segmented — in which case every helper below falls
 * back to the byte-identical BARE markers. Only a genuine non-negative integer
 * `segment_index` opts into the parted markers; anything else (missing,
 * negative, fractional, non-number) reads as un-segmented, so a malformed value
 * can never silently corrupt the bare flow.
 */
export function segmentPart(meta: Record<string, unknown> | undefined | null): number | undefined {
  const idx = meta?.["segment_index"];
  return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx + 1 : undefined;
}

/** The pending marker for a part (bare when `part` is undefined). */
export function pendingMarker(part?: number): string {
  return part === undefined ? "_Transcript pending._" : `_Transcript pending (part ${part})._`;
}

/** The terminal "unavailable" marker for a part (bare when `part` is undefined). */
export function unavailableMarker(part?: number): string {
  return part === undefined ? TRANSCRIPT_UNAVAILABLE : `_Transcription unavailable (part ${part})._`;
}

/** Body pattern matching this part's pending marker (bare when undefined). */
function pendingRe(part?: number): RegExp {
  return part === undefined ? TRANSCRIPT_PLACEHOLDER : new RegExp(escapeRegExp(pendingMarker(part)));
}

/** Body pattern a successful transcript replaces for this part.
 *  - bare: pending | unavailable | limit (one marker per body — unambiguous).
 *  - part N: pending-part-N | unavailable-part-N ONLY. The bare limit marker is
 *    DELIBERATELY excluded: it carries no part identity, so matching it here
 *    could let one part's success clobber a DIFFERENT part's limit slot. */
function successRe(part?: number): RegExp {
  if (part === undefined) return TRANSCRIPT_SUCCESS_TARGET;
  return new RegExp(`${escapeRegExp(pendingMarker(part))}|${escapeRegExp(unavailableMarker(part))}`);
}

/** Body pattern for "this part is already terminal" (the don't-stack guard).
 *  - bare: unavailable | limit.
 *  - part N: unavailable-part-N | limit (a segment that hit the cap left the
 *    shared bare limit marker in its slot). */
function anyTerminalRe(part?: number): RegExp {
  if (part === undefined) return ANY_TERMINAL_MARKER;
  return new RegExp(`${escapeRegExp(unavailableMarker(part))}|_Monthly voice limit reached[^\\n]*\\._`);
}

/**
 * Compute the note body after a successful transcription (finding F — never
 * destroy content), scoped to `part` (undefined = the bare marker):
 *   - a pending/terminal marker for this part present → surgical replace;
 *   - neither present (the user edited while pending, or the slot holds a bare
 *     limit marker that can't be attributed to this part) → APPEND the
 *     transcript (never full-replace — that would destroy the embed + edits).
 *
 * The replacer is a FUNCTION, never a string: speech-to-text is arbitrary user
 * content and `String.replace` treats `$&`/`$1`/etc. as special in a string
 * replacement — `() => transcript` inserts the text verbatim.
 */
export function bodyWithTranscript(content: string, transcript: string, part?: number): string {
  const target = successRe(part);
  if (target.test(content)) {
    return content.replace(target, () => transcript);
  }
  return content.length > 0 ? `${content}\n\n${transcript}` : transcript;
}

/**
 * Compute the note body after a terminal outcome (transcription failed, or the
 * monthly voice cap is hit), scoped to `part`:
 *   - this part's pending marker present → surgical replace with `marker`;
 *   - this part already terminal → no-op (idempotent — never stack markers);
 *   - otherwise (user edited while pending) → APPEND the marker.
 *
 * `marker` is the literal to write: {@link unavailableMarker}(part) for a
 * failure, or the un-parted {@link TRANSCRIPT_LIMIT_REACHED} for the soft cap
 * (parted-pending replaced in place by the bare limit string — see the header).
 */
export function bodyWithFailureMarker(content: string, marker: string, part?: number): string {
  const pending = pendingRe(part);
  if (pending.test(content)) {
    return content.replace(pending, () => marker);
  }
  if (anyTerminalRe(part).test(content)) return content;
  return content.length > 0 ? `${content}\n\n${marker}` : marker;
}

/**
 * Compute the note body when re-arming a retry (voice W2): restore this part's
 * pending marker in place of the terminal marker it currently shows, so the
 * re-run's success/terminal lands back in the same slot.
 *   - bare: replace the unavailable OR limit marker with `_Transcript pending._`.
 *   - part N: replace `_Transcription unavailable (part N)._` with the part-N
 *     pending marker. A bare limit marker is NOT restored for a segmented part
 *     — it carries no part identity, so blindly replacing the body's first one
 *     could hit a DIFFERENT part's slot; the segment keeps its limit marker and
 *     a later re-run appends (non-destructive, documented residual).
 *   - no terminal marker present (the user edited, or it is already pending) →
 *     leave the body untouched (never inject a spurious spinner).
 */
export function bodyWithPendingRestored(content: string, part?: number): string {
  const terminal = part === undefined ? ANY_TERMINAL_MARKER : new RegExp(escapeRegExp(unavailableMarker(part)));
  if (terminal.test(content)) {
    return content.replace(terminal, () => pendingMarker(part));
  }
  return content;
}
