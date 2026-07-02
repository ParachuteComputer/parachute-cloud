/**
 * Router resolution — vault names are canonicalized to lowercase so a mixed-case
 * URL hits the SAME Durable Object as its lowercase form (vault names are created
 * lowercase + tokens carry a lowercase `aud=vault.<name>`). Without this, an
 * owner visiting `/vault/MyVault/…` self-locks-out onto a new empty DO.
 */
import { describe, expect, test } from "vitest";
import { resolveVault } from "../src/index.ts";

const env = { VAULT_BASE_DOMAIN: "u.parachute.computer" };

describe("resolveVault case-normalization", () => {
  test("mixed-case path resolves to the canonical lowercase vault", () => {
    expect(resolveVault(new URL("https://u.parachute.computer/vault/MyVault/api/notes"), env)).toEqual({
      name: "myvault",
      rel: "/api/notes",
    });
    // …the same DO as the already-lowercase form.
    expect(resolveVault(new URL("https://u.parachute.computer/vault/myvault/api/notes"), env)).toEqual({
      name: "myvault",
      rel: "/api/notes",
    });
  });

  test("mixed-case subdomain resolves to the canonical lowercase vault", () => {
    expect(resolveVault(new URL("https://MyVault.u.parachute.computer/api/notes"), env)).toEqual({
      name: "myvault",
      rel: "/api/notes",
    });
  });

  test("bare vault root path (no trailing segment)", () => {
    expect(resolveVault(new URL("https://u.parachute.computer/vault/Demo"), env)).toEqual({
      name: "demo",
      rel: "",
    });
  });

  test("a non-vault path is not addressable", () => {
    expect(resolveVault(new URL("https://u.parachute.computer/health"), env)).toBeNull();
  });
});
