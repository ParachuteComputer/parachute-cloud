// Fly.io implementation of ProviderClient against the Machines API.
//
// TODO(phase-1): lift from parachute-hub/src/deploy/fly-client.ts. The real
// implementation is already written there (createInstance/destroyInstance via
// POST /v1/apps + POST /v1/apps/{app}/volumes + POST /v1/apps/{app}/machines).
// In Phase 1 we move that file here, delete the hub copy (or thin it to
// re-export this one for backward compat), and wire it through
// signup/orchestrate.ts.
import type { ProviderClient } from "./provider-client.ts";

export class FlyClient implements ProviderClient {
  // TODO(phase-1): bring over real Fly Machines API client.
}
