import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Root config directory inside the Fly machine.
 *
 * Honors `$PARACHUTE_HOME` to match the hub-side convention: both sides must
 * resolve the same path or the bootstrap-written marker / .env won't line up
 * with what the hub reads on first boot.
 *
 * Production shape on Fly: `PARACHUTE_HOME=/data` (the persistent volume mount).
 * Without that override the resolver falls back to `~/.parachute`, which on a
 * containerized deploy is the *image* layer — wiped on every restart. The
 * bootstrap script warns loudly when this happens (#131 in the hub history).
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PARACHUTE_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), ".parachute");
}
