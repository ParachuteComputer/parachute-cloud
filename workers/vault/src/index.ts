/**
 * Phase-0 spike worker entry. The DO is driven directly over RPC from the
 * vitest-pool-workers tests; this fetch handler exists only so wrangler has a
 * valid `main`. No routing, no auth — that's Phase 2.
 */
export { VaultDO } from "./vault-do.js";

export interface Env {
  VAULT: DurableObjectNamespace;
}

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response("parachute-vault-do spike — drive the DO via RPC from tests", { status: 200 });
  },
};
