/**
 * Vault info — GET/PATCH /api/vault. Ported from routes.ts:handleVault. Cloud
 * has no global config.yaml, so `auto_transcribe.enabled` resolves from the
 * per-DO stored config (default false — cloud v1 has no scribe), rather than
 * the bun per-vault→global→true chain.
 */
import type { Store } from "@openparachute/core/src/types.js";
import { getVaultMap } from "@openparachute/core/src/notes.js";
import { json, parseBool, parseQuery } from "./parse.js";

export type VaultConfigLike = {
  name: string;
  description?: string;
  audio_retention?: "keep" | "until_transcribed" | "never";
  auto_transcribe?: { enabled?: boolean };
  /** 0.9.3: this vault's own choice for auto hybrid search; absent follows the door's default. */
  search?: { auto_hybrid: boolean };
};

const VALID_AUDIO_RETENTION = ["keep", "until_transcribed", "never"] as const;

function vaultResponse(vaultConfig: VaultConfigLike): Record<string, unknown> {
  return {
    name: vaultConfig.name,
    description: vaultConfig.description ?? null,
    config: {
      audio_retention: vaultConfig.audio_retention ?? "keep",
      auto_transcribe: { enabled: vaultConfig.auto_transcribe?.enabled ?? false },
    },
  };
}

export async function handleVault(
  req: Request,
  store: Store,
  vaultConfig: VaultConfigLike,
  persist?: () => void,
  /**
   * Transcription capability for the GET response — the SAME object the bare
   * landing carries (vault-do.ts `transcriptionCapability()`), mirroring
   * self-host's routes.ts which declares `transcription` on /api/vault.
   * Keeping both doors in lock-step is what lets notes-ui probe /api/vault
   * without its cross-door fallback. GET-only, like self-host (the PATCH
   * response omits it there too).
   */
  transcription?: { enabled: boolean; minutes_remaining: number },
  /**
   * Semantic-search capability for the GET response (C2, EXPERIMENTAL) — same
   * parity contract as `transcription` above (vault-do.ts `embeddingCapability()`
   * mirrors self-host's `resolveEmbeddingCapability`, declared on /api/vault
   * there too). GET-only.
   */
  embeddings?: { enabled: boolean; provider?: string; model?: string },
  /** An admin's GET also shows the vault's search settings (as a box's does); the effective auto hybrid value. */
  admin?: { hybridAutoDefault: boolean },
): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const result: Record<string, unknown> = vaultResponse(vaultConfig);
    if (transcription) result.transcription = transcription;
    if (embeddings) result.embeddings = embeddings;
    if (admin) result.search = { auto_hybrid: vaultConfig.search?.auto_hybrid ?? admin.hybridAutoDefault };
    // Front-door structural map — ALWAYS included, mirroring bun's handleVault
    // (routes.ts, contracts-brief C1.2). Cloud has no tag-scoped tokens
    // (NO_TAG_SCOPE everywhere), so the unscoped call is always correct here.
    result.map = getVaultMap(store.db);
    if (parseBool(parseQuery(url, "include_stats"), false)) {
      result.stats = await store.getVaultStats();
    }
    return json(result);
  }

  // Scope (T-419, audit L3-01; closes cloud#134 A.2): a PATCH that carries `description` needs vault:admin, checked
  // in vault-do.ts before this handler runs, the same rule as MCP vault-info and the bun vault's REST door. The
  // description is the instruction text every connected AI reads, so writing it is curation. `config` alone
  // (audio_retention, auto_transcribe) stays at write: the Notes app sets audio retention with a write token.
  if (req.method === "PATCH") {
    const body = await req.json() as {
      // `unknown`, not `string` — this is parsed JSON off the wire, and the old
      // `string` annotation read as a guarantee while guaranteeing nothing
      // (cloud#87). Typing it honestly makes the runtime check below mandatory
      // rather than optional.
      description?: unknown;
      config?: { audio_retention?: string; auto_transcribe?: { enabled?: unknown }; search?: { auto_hybrid?: unknown } | null };
    };
    let dirty = false;

    // cloud#87 — the RUNTIME type guard for the SAME field the MCP door guards
    // (mcp.ts `overrideVaultInfo`). `body` is untyped JSON off the wire: the
    // `description?: string` annotation on the cast above is a compile-time
    // claim, not a check, so a write-scoped caller could persist a non-string
    // here — and the damage landed on the OTHER door, three steps downstream:
    // `serverInstruction()` does `description?.trim()`, so the next MCP
    // `initialize` answered -32603 INTERNAL_ERROR and the vault could not be
    // connected to until repaired. Cheap here, unrecoverable-looking there.
    //
    // Same 400 body shape as the sibling `audio_retention` / `auto_transcribe`
    // validators below (error / error_type / field / got / message / hint) — a
    // reused local shape, not a new error family. `null` stays legal: it CLEARS
    // the description (`VaultConfigLike.description` is optional, and the DO's
    // persist callback maps absent → null).
    if (body.description !== undefined) {
      const d = body.description as unknown;
      if (d !== null && typeof d !== "string") {
        return json(
          {
            error: "invalid_description",
            error_type: "invalid_description",
            field: "description",
            got: d,
            message: "description must be a string, or null to clear it",
            hint: "pass a string, or null to clear the description",
          },
          400,
        );
      }
      vaultConfig.description = d ?? undefined;
      dirty = true;
    }

    if (body.config?.audio_retention !== undefined) {
      const v = body.config.audio_retention;
      if (!VALID_AUDIO_RETENTION.includes(v as typeof VALID_AUDIO_RETENTION[number])) {
        return json(
          {
            error: "invalid_audio_retention",
            error_type: "invalid_audio_retention",
            field: "config.audio_retention",
            got: v,
            message: `audio_retention must be one of: ${VALID_AUDIO_RETENTION.join(", ")}`,
            hint: `pass one of: ${VALID_AUDIO_RETENTION.join(", ")}`,
          },
          400,
        );
      }
      vaultConfig.audio_retention = v as typeof VALID_AUDIO_RETENTION[number];
      dirty = true;
    }

    if (body.config?.auto_transcribe !== undefined) {
      const enabled = body.config.auto_transcribe?.enabled;
      if (typeof enabled !== "boolean") {
        return json(
          {
            error: "invalid_auto_transcribe",
            error_type: "invalid_auto_transcribe",
            field: "config.auto_transcribe.enabled",
            got: enabled,
            message: "auto_transcribe.enabled must be a boolean",
            hint: "pass true or false",
          },
          400,
        );
      }
      vaultConfig.auto_transcribe = { ...vaultConfig.auto_transcribe, enabled };
      dirty = true;
    }

    // search.auto_hybrid (0.9.3), as a box takes it: true/false is this vault's choice, null follows the door's default.
    // Vault-wide, so admin only (vault-do.ts gates a PATCH carrying config.search at admin before this runs).
    if (body.config?.search !== undefined) {
      const v = body.config.search?.auto_hybrid;
      if (v !== null && typeof v !== "boolean") {
        return json(
          {
            error: "invalid_search_auto_hybrid",
            error_type: "invalid_search_auto_hybrid",
            field: "config.search.auto_hybrid",
            got: v,
            message: "search.auto_hybrid must be a boolean, or null to follow the default",
            hint: "pass true, false or null",
          },
          400,
        );
      }
      if (v === null) delete vaultConfig.search;
      else vaultConfig.search = { auto_hybrid: v };
      dirty = true;
    }

    if (dirty && persist) persist();
    return json(vaultResponse(vaultConfig));
  }

  return json({ error: "Method not allowed", error_type: "method_not_allowed" }, 405);
}
