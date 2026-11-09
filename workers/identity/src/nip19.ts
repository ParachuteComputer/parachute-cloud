// Ported from parachute-core packages/hub/src/nip19.ts (T-414), npub half only: the identity worker has no nsec to read.
/**
 * NIP-19 `npub` decoding — bech32 to 32-byte x-only hex. Pure: no DB, no HTTP,
 * no crypto, no dependencies.
 *
 * ## Why this exists
 *
 * Every human-facing nostr surface (Buzz, clients, profile pages) shows keys
 * as `npub1…`, while every wire format the hub speaks — NIP-01 events,
 * `user_pubkeys.pubkey`, `user_vaults` — is 64-char lowercase hex. Something
 * has to sit at the operator-facing edge and translate, or an admin pasting
 * the only form of the key they can actually see gets rejected. That edge is
 * `parseGrantPubkey` (`grant-access.ts`); this module is its decoder.
 *
 * **`npub` is an encoding, not a credential.** Decoding one proves nothing —
 * it is exactly as unauthenticated as the hex it becomes. The bech32 checksum
 * is a typo guard (a mistyped npub fails to decode rather than granting a
 * stranger's key), not a signature. Authority still comes from the caller's
 * NIP-98 or Bearer credential, unchanged.
 *
 * ## Why hand-rolled rather than a library
 *
 * The hub has no bech32 dependency and this is ~40 lines of fully-specified
 * arithmetic (BIP-173) with published test vectors. Adding a package to the
 * shipped door's dependency closure to decode 63 characters is the worse
 * trade. The BIP-173 checksum vectors and the NIP-19 spec vectors both live
 * in `__tests__/nip19.test.ts`.
 *
 * ## Case
 *
 * Only all-lowercase input is accepted. BIP-173 also permits all-uppercase,
 * but nostr emits lowercase universally and `pubkey-links.ts` already refuses
 * to normalize mixed-case hex ("reject mixed case — don't normalize"). Same
 * rule here: normalizing quietly is how two spellings of one key end up in
 * two rows.
 */

/** BIP-173 data charset. Index = 5-bit value. */
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** BIP-173 generator constants for the BCH checksum. */
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** bech32 (not bech32m) checksum constant. NIP-19 is plain bech32. */
const BECH32_CONST = 1;

/**
 * An `npub`/`nsec` is the 4-char hrp + `1` + 52 data chars (32 bytes @ 5 bits)
 * + 6 checksum characters. Both NIP-19 forms carry exactly 32 bytes, so both
 * are exactly this long.
 */
const KEY_BECH32_LENGTH = 63;

/** x-only key size in bytes. */
const PUBKEY_BYTES = 32;

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GENERATOR[i] as number;
    }
  }
  return chk;
}

/** BIP-173 HRP expansion: high bits, separator zero, low bits. */
function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/** 5-bit groups → 8-bit bytes. Rejects non-zero padding and over-long padding. */
function wordsToBytes(words: readonly number[]): Uint8Array | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const word of words) {
    acc = (acc << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  // A well-formed encoding leaves <5 leftover bits and they must all be zero.
  if (bits >= 5) return null;
  if (((acc << (8 - bits)) & 0xff) !== 0) return null;
  return Uint8Array.from(out);
}

/**
 * Decode a lowercase NIP-19 `npub1…` into 64-char lowercase hex.
 *
 * Returns `null` for anything that is not a checksum-valid `npub` carrying
 * exactly 32 bytes: wrong human-readable part (`nsec1…`, `note1…`), bad
 * checksum, illegal character, wrong payload length (which the 63-char gate
 * catches — see below), any uppercase. The caller owns the error message —
 * this never throws.
 */
export function decodeNpub(input: string): string | null {
  return decodeKeyBech32(input, "npub");
}

/**
 * Shared bech32 body for the two 32-byte NIP-19 forms. Returns lowercase hex,
 * or `null` for a wrong hrp, a bad checksum, an illegal character, any
 * uppercase, or non-canonical padding. Never throws — the caller owns the
 * error message, and for `nsec` the input must never appear in one.
 */
function decodeKeyBech32(input: string, hrp: "npub" | "nsec"): string | null {
  if (input.length !== KEY_BECH32_LENGTH) return null;
  if (!input.startsWith(`${hrp}1`)) return null;

  const data = input.slice(hrp.length + 1);
  const words: number[] = [];
  for (const char of data) {
    const value = CHARSET.indexOf(char);
    if (value === -1) return null;
    words.push(value);
  }

  if (polymod([...hrpExpand(hrp), ...words]) !== BECH32_CONST) return null;

  const bytes = wordsToBytes(words.slice(0, -6));
  // `wordsToBytes` can still return null (non-canonical padding). The
  // `PUBKEY_BYTES` half is belt, not brace: 63 chars fixes the payload at 52
  // words = 32 bytes exactly, so a wrong-length key is already rejected by
  // the gate on the first line — this can never be the reason. Kept so the
  // 32-byte contract is stated where the bytes are produced rather than
  // inferred from an arithmetic identity three lines up.
  if (bytes === null || bytes.length !== PUBKEY_BYTES) return null;

  return Buffer.from(bytes).toString("hex");
}
