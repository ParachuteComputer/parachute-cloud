// NIP-98 for the personal door (T-430): sign one HTTP request with a Nostr key, and sign in with it.
//   bun deploy/personal/nip98.ts keygen <secret-file>             a new key; prints its pubkey (hex), secret to the file (0600)
//   bun deploy/personal/nip98.ts pubkey <secret-file>             the key's pubkey (hex)
//   bun deploy/personal/nip98.ts token <identity-origin> <secret-file> [out-file]
//                                                                 sign in (POST /account/token); the 10-minute account
//                                                                 token goes to out-file (0600), never to stdout
// A secret file holds 64 hex characters, or an nsec1… (bech32). Nothing secret is printed.
// The identity worker's own Schnorr (its NIP-98 verifier uses the same package): no second copy to install.
import { schnorr } from "../../workers/identity/node_modules/@noble/curves/secp256k1.js";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string) => Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)));

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i]!;
  }
  return chk;
}

function bech32Bytes(s: string, prefix: string): Uint8Array {
  const lower = s.toLowerCase();
  if (!lower.startsWith(`${prefix}1`)) throw new Error(`not an ${prefix}`);
  const all = [...lower.slice(prefix.length + 1)].map((c) => {
    const v = BECH32.indexOf(c);
    if (v < 0) throw new Error(`bad ${prefix}`);
    return v;
  });
  // A mistyped key must fail here, not quietly become another key.
  const hrp = [...prefix].map((c) => c.charCodeAt(0));
  if (polymod([...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31), ...all]) !== 1) throw new Error(`${prefix} checksum doesn't match`);
  const data = all.slice(0, -6);
  let acc = 0, bits = 0;
  const out: number[] = [];
  for (const v of data) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (out.length !== 32) throw new Error(`bad ${prefix} length`);
  return Uint8Array.from(out);
}

export function readSecret(file: string): Uint8Array {
  const raw = readFileSync(file, "utf8").trim();
  if (/^[0-9a-f]{64}$/i.test(raw)) return fromHex(raw.toLowerCase());
  return bech32Bytes(raw, "nsec");
}

export function pubkeyOf(secret: Uint8Array): string {
  return hex(schnorr.getPublicKey(secret));
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** `Authorization: Nostr <event>` for one request (kind 27235: u, method, payload when there is a body, a nonce). */
export async function nip98Header(secret: Uint8Array, url: string, method: string, body?: string, extraTags: string[][] = []): Promise<string> {
  const tags = [["u", url], ["method", method], ["nonce", hex(crypto.getRandomValues(new Uint8Array(16)))], ...extraTags];
  if (body) tags.push(["payload", await sha256Hex(body)]);
  const unsigned = { pubkey: pubkeyOf(secret), created_at: Math.floor(Date.now() / 1000), kind: 27235, tags, content: "" };
  const id = await sha256Hex(JSON.stringify([0, unsigned.pubkey, unsigned.created_at, unsigned.kind, unsigned.tags, unsigned.content]));
  const event = { ...unsigned, id, sig: hex(schnorr.sign(fromHex(id), secret)) };
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

/** Sign in at an identity origin: the account token, or the refusal's status. */
export async function signIn(identity: string, secret: Uint8Array): Promise<{ status: number; token?: string; body: unknown }> {
  const url = `${identity.replace(/\/$/, "")}/account/token`;
  const res = await fetch(url, { method: "POST", headers: { Authorization: await nip98Header(secret, url, "POST") } });
  const body = (await res.json().catch(() => null)) as { token?: string } | null;
  return { status: res.status, ...(body?.token ? { token: body.token } : {}), body };
}

if (import.meta.main) {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === "keygen" && a) {
    const secret = schnorr.utils.randomSecretKey();
    writeFileSync(a, hex(secret) + "\n", { mode: 0o600 });
    chmodSync(a, 0o600);
    console.log(pubkeyOf(secret));
  } else if (cmd === "pubkey" && a) {
    console.log(pubkeyOf(readSecret(a)));
  } else if (cmd === "token" && a && b) {
    const r = await signIn(a, readSecret(b));
    if (!r.token) {
      console.error(`sign-in refused: ${r.status} ${JSON.stringify(r.body)}`);
      process.exit(1);
    }
    if (c) {
      writeFileSync(c, r.token, { mode: 0o600 });
      console.log(`account token (10 min) in ${c}`);
    } else console.log("signed in (pass an out-file to keep the token)");
  } else {
    console.error("usage: nip98.ts keygen <secret-file> | pubkey <secret-file> | token <identity-origin> <secret-file> [out-file]");
    process.exit(2);
  }
}
