/**
 * QR code → inline SVG for the TOTP enrollment page. Uses `@paulmillr/qr`
 * (`encodeQR`), a zero-dependency pure-JS encoder — the package's main entry
 * (index.js) pulls in no Node built-ins, so it bundles cleanly into workerd (the
 * `dom` / `decode` entry points, which do touch the DOM, are never imported).
 *
 * We render the QR ourselves rather than fetch an external QR service: the
 * otpauth URI carries the TOTP secret, so it must never leave the origin.
 */
import { encodeQR } from "@paulmillr/qr";

/** Inline SVG markup for `text` (the otpauth URI). Sized by the caller's CSS. */
export function qrSvg(text: string): string {
  // `border: 2` = a 2-module quiet zone (scanner-friendly). Default error
  // correction is fine for the short otpauth URI.
  return encodeQR(text, "svg", { border: 2 });
}
