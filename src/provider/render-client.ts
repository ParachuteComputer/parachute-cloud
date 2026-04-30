// Render.com implementation of ProviderClient (placeholder).
//
// TODO(phase-4+): only needed if we move off Fly or want a second provider
// for migration drills. Per cloud-shape doc §8.5 the user never sees the
// provider name, so swapping is purely an internal lift. Stub here just
// pins the shape so a future RenderClient slot exists in the codebase.
import type { ProviderClient } from "./provider-client.ts";

export class RenderClient implements ProviderClient {
  // TODO(phase-4+): implement against the Render REST API when needed.
}
