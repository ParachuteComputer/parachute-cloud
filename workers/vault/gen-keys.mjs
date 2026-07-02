import { generateKeyPair, exportJWK } from "jose";
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const pub = await exportJWK(publicKey);
const priv = await exportJWK(privateKey);
const kid = "cloud-test-key-1";
pub.kid = kid; pub.alg = "RS256"; pub.use = "sig";
priv.kid = kid; priv.alg = "RS256";
const jwks = { keys: [pub] };
const out = `// AUTO-GENERATED fixed RS256 test keypair for the conformance auth matrix.
// NOT a secret — a throwaway key used only to sign tokens the vault validates
// against the injected TEST_JWKS binding. Regenerate via gen-keys.mjs.
export const TEST_KID = ${JSON.stringify(kid)};
export const TEST_PUBLIC_JWKS = ${JSON.stringify(JSON.stringify(jwks))};
export const TEST_PRIVATE_JWK = ${JSON.stringify(priv)};
`;
process.stdout.write(out);
