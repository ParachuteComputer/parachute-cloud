// Provision orchestration — the actual VM-spinup pipeline.
//
// TODO(phase-2): given a tenant + plan + chosen subdomain:
//   1. ProviderClient.createInstance(spec) → handle, IP
//   2. Wait for first-boot bootstrap (in src/bootstrap.ts, lifted from
//      parachute-hub/src/deploy/bootstrap.ts in phase-1) to write its marker.
//   3. Update DNS: <subdomain>.parachute.computer → machine IP / Fly app.
//   4. Persist DeploymentRecord (provider, handle, region, vm_size, plan).
//   5. Email the user their URL + first-boot setup link.
//
// Phase 1 lifts FlyClient + bootstrap from parachute-hub. This file is what
// drives them in production.

export async function orchestrateProvision(): Promise<void> {
  throw new Error("TODO(phase-2): implement provisioning orchestration");
}
