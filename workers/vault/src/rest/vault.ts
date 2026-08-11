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
): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const result: Record<string, unknown> = vaultResponse(vaultConfig);
    if (transcription) result.transcription = transcription;
    if (embeddings) result.embeddings = embeddings;
    // Front-door structural map — ALWAYS included, mirroring bun's handleVault
    // (routes.ts, contracts-brief C1.2). Cloud has no tag-scoped tokens
    // (NO_TAG_SCOPE everywhere), so the unscoped call is always correct here.
    result.map = getVaultMap(store.db);
    if (parseBool(parseQuery(url, "include_stats"), false)) {
      result.stats = await store.getVaultStats();
    }
    return json(result);
  }

  // KNOWN GAP (cloud#134 A.2, drift vs. the MCP door — NOT fixed here, annotation
  // only): this REST PATCH still writes `description` (and audio_retention /
  // auto_transcribe below) at the generic WRITE tier — the caller's REST scope
  // gate is `verbForMethod`'s plain write (vault-do.ts's dispatcher has no
  // admin carve-out for `/vault`), unlike `mcp.ts`'s `overrideVaultInfo`, which
  // was tightened to require `vault:admin` for the SAME mutation (description
  // is curation, same class as update-tag). Left asymmetric ON PURPOSE: the bun
  // vault's `routes.ts handleVault` has the identical write-tier REST PATCH (no
  // admin gate), so re-tiering cloud's REST door alone would fork the wire
  // contract this file is required to stay byte-shaped with (see this repo's
  // CLAUDE.md: "the WIRE contract ... must match the bun vault byte-shaped").
  // Net effect: the MCP-door admin gate is ADVISORY, not a real boundary, until
  // bun's REST door moves too and both doors re-tier together — a write-tier
  // token can always reach this mutation via REST even though the MCP tool
  // refuses it. Tracked, not silently accepted; do not "fix" only one side.
  if (req.method === "PATCH") {
    const body = await req.json() as {
      description?: string;
      config?: { audio_retention?: string; auto_transcribe?: { enabled?: unknown } };
    };
    let dirty = false;

    if (body.description !== undefined) {
      vaultConfig.description = body.description;
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

    if (dirty && persist) persist();
    return json(vaultResponse(vaultConfig));
  }

  return json({ error: "Method not allowed", error_type: "method_not_allowed" }, 405);
}
