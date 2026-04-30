// Provider abstraction for VM lifecycle. Concrete impls in this directory.
//
// TODO(phase-1): lift the real interface + types from
// parachute-hub/src/deploy/provider-client.ts. Phase 0 is scaffolding only —
// this file exists to anchor the import shape so the signup orchestrator and
// admin CLI can reference it without a real impl.
//
// See parachute-vault/docs/design/2026-04-29-parachute-cloud-shape.md §8.5.

export interface ProviderClient {
  // TODO(phase-1): expand to match parachute-hub's ProviderClient shape.
}
