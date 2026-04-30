// First-boot bootstrap — runs once on a freshly-provisioned cloud VM.
//
// TODO(phase-1): lift from parachute-hub/src/deploy/bootstrap.ts. The real
// script reads PARACHUTE_VAULT_NAME / PARACHUTE_MODULES / scribe-provider envs,
// installs the configured Tier 1 modules onto /data, persists a marker, and
// hands control to the hub. Idempotent on restart.
//
// Phase 1 moves the file here; the cloud control plane's signup orchestrator
// invokes it via the bake-into-image path (it ships in the Parachute machine
// image, not as runtime code in this control plane).

export async function bootstrap(): Promise<void> {
  throw new Error("TODO(phase-1): lift bootstrap from parachute-hub");
}
