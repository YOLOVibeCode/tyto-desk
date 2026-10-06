import type { Env } from "../env/env.ts";

/** The kill switch is on for any value but empty and `0`, so a spelling such as `true` or `yes` fails closed. */
function noGui(env: Env): boolean {
  const value = env.DESK_NO_GUI;
  return value !== undefined && value !== "" && value !== "0";
}

/**
 * Whether a Desk process may put anything on the screen (start Chrome, write Desk.app, install a LaunchAgent).
 * `DESK_NO_GUI` set to anything but empty or `0` always wins; the Linux test container may; anything under Vitest may
 * not; otherwise only the installed `desk` launcher, which sets `DESK_ALLOW_GUI=1`.
 */
export function guiAllowed(env: Env, platform: string): boolean {
  if (noGui(env)) return false;
  if (platform === "linux" && env.DESK_IN_CONTAINER === "1") return true;
  if (env.VITEST !== undefined) return false;
  return env.DESK_ALLOW_GUI === "1";
}
