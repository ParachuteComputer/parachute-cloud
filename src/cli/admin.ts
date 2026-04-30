// Admin CLI — internal-use binary for operating the fleet.
//
// TODO(phase-2): subcommands, all hitting the provider abstraction directly:
//   parachute-cloud-admin provision <tenant-id>     create a VM out-of-band
//   parachute-cloud-admin destroy   <handle>        tear one down
//   parachute-cloud-admin list                      show all VMs + plans + status
//   parachute-cloud-admin tail      <handle>        stream logs
//   parachute-cloud-admin migrate   <handle> <provider>  cross-provider move
//
// Bun-native shebang. No framework — flat argv parsing, same shape as
// parachute-hub/src/cli.ts.

export async function main(_argv: string[]): Promise<number> {
  throw new Error("TODO(phase-2): implement admin CLI");
}
