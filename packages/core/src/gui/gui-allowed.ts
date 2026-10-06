import type { Env } from "../env/env.ts";

/**
 * Whether a Desk process may put anything on the screen (start Chrome, write Desk.app, install a LaunchAgent).
 * `DESK_NO_GUI=1` always wins; the Linux test container may; anything under Vitest may not; otherwise only the
 * installed `desk` launcher, which sets `DESK_ALLOW_GUI=1`.
 */
export function guiAllowed(env: Env, platform: string): boolean {
  if (env.DESK_NO_GUI === "1") return false;
  if (platform === "linux" && env.DESK_IN_CONTAINER === "1") return true;
  if (env.VITEST !== undefined) return false;
  return env.DESK_ALLOW_GUI === "1";
}
