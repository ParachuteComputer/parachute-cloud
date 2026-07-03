/**
 * Cloud voice-transcription pipeline — the pure body-transform helpers +
 * shared markers (cloud#56).
 *
 * These mirror the self-host transcription worker's "never destroy content"
 * body policy (parachute-vault src/transcription-worker.ts) so a voice memo
 * captured against a cloud vault resolves EXACTLY like one captured against a
 * bun vault: the `_Transcript pending._` placeholder Notes seeds
 * (parachute-surface memoNoteContent) is surgically replaced with the
 * transcript on success, or a terminal marker on failure — never an eternal
 * spinner.
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
 * exactly one marker; first-match is the target.
 */
export const TRANSCRIPT_SUCCESS_TARGET =
  /_Transcript pending\._|_Transcription unavailable\._|_Monthly voice limit reached[^\n]*\._/;

/** Every terminal/limit marker, for the "already-terminal, don't stack" guard. */
const ANY_TERMINAL_MARKER = /_Transcription unavailable\._|_Monthly voice limit reached[^\n]*\._/;

/**
 * Compute the note body after a successful transcription (finding F — never
 * destroy content):
 *   - a placeholder/terminal marker present → surgical replace in place;
 *   - neither present (the user edited while pending) → APPEND the transcript
 *     (never full-replace — that would destroy the embed + the user's edits).
 *
 * The replacer is a FUNCTION, never a string: speech-to-text is arbitrary user
 * content and `String.replace` treats `$&`/`$1`/etc. as special in a string
 * replacement — `() => transcript` inserts the text verbatim.
 */
export function bodyWithTranscript(content: string, transcript: string): string {
  if (TRANSCRIPT_SUCCESS_TARGET.test(content)) {
    return content.replace(TRANSCRIPT_SUCCESS_TARGET, () => transcript);
  }
  return content.length > 0 ? `${content}\n\n${transcript}` : transcript;
}

/**
 * Compute the note body after a terminal outcome (transcription failed, or the
 * monthly voice cap is hit):
 *   - placeholder present → surgical replace with the marker;
 *   - a terminal/limit marker already present → no-op (idempotent — a repeated
 *     terminal outcome must not stack markers);
 *   - otherwise (user edited while pending) → APPEND the marker.
 *
 * `marker` is {@link TRANSCRIPT_UNAVAILABLE} or {@link TRANSCRIPT_LIMIT_REACHED}.
 */
export function bodyWithFailureMarker(content: string, marker: string): string {
  if (TRANSCRIPT_PLACEHOLDER.test(content)) {
    return content.replace(TRANSCRIPT_PLACEHOLDER, () => marker);
  }
  if (ANY_TERMINAL_MARKER.test(content)) return content;
  return content.length > 0 ? `${content}\n\n${marker}` : marker;
}
