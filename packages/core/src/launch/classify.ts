/** What `desk` does with the Desk Chrome it finds (docs/IMPLEMENTATION.md §6.1 step 4). */
export type LaunchDecision = "launch" | "move-port" | "reuse" | "foreign" | "wait";

export type SingletonState = "none" | "dead" | "alive";

export type LaunchFacts = {
  singleton: SingletonState;
  /** Whether `/json/version` answers on the Desk port. */
  answers: boolean;
  /** Whether anything holds the Desk port. */
  busy: boolean;
  /** Who listens on the Desk port (asked only when a live singleton's port answers). */
  listener: "desk" | "other" | "unverifiable";
};

/**
 * §6.1's table. No live singleton: a free port launches, a held one moves Chrome to a new raw port. A live singleton:
 * a port that answers is reused only when its listener is the Desk Chrome (anything else, unverifiable included, fails
 * closed); a silent port means Chrome is quitting, so `desk` waits for it.
 */
export function classifyLaunch(facts: LaunchFacts): LaunchDecision {
  if (facts.singleton !== "alive") return facts.busy || facts.answers ? "move-port" : "launch";
  if (!facts.answers) return "wait";
  return facts.listener === "desk" ? "reuse" : "foreign";
}

/**
 * The listener is the Desk Chrome when it is the singleton's pid, its executable lies inside the configured app
 * (`appRoot`: the macOS bundle, or the Linux binary's real directory), and its arguments name the Desk profile.
 */
export function listenerIsDesk(input: {
  singletonPid: number;
  listenerPid: number | null;
  image: { exe: string; args: string } | null;
  appRoot: string;
  userDataDir: string;
}): "desk" | "other" | "unverifiable" {
  if (input.listenerPid === null || input.image === null) return "unverifiable";
  if (input.listenerPid !== input.singletonPid) return "other";
  const root = input.appRoot.replace(/\/+$/, "");
  if (input.image.exe !== root && !input.image.exe.startsWith(`${root}/`)) return "other";
  return ` ${input.image.args} `.includes(` --user-data-dir=${input.userDataDir} `) ? "desk" : "other";
}

/**
 * A lock whose pid is alive is the Desk Chrome's only when that pid uses the Desk profile, so a pid the system gave to
 * another process after a crash reads as dead; an unreadable process list trusts the pid (fail closed).
 */
export function singletonState(input: { lock: { host: string; pid: number } | null; alive: boolean; users: readonly number[] | null }): SingletonState {
  if (input.lock === null) return "none";
  if (!input.alive) return "dead";
  return input.users === null || input.users.includes(input.lock.pid) ? "alive" : "dead";
}

/**
 * A dead lock that names another host (the machine was renamed) would make Chrome ask about a "profile in use on another
 * computer"; Desk removes it, but only when it can see that no process uses the profile.
 */
export function staleLockToClear(input: {
  lock: { host: string; pid: number } | null;
  host: string;
  state: SingletonState;
  users: readonly number[] | null;
}): boolean {
  return input.lock !== null && input.state === "dead" && input.lock.host !== input.host && input.users !== null && input.users.length === 0;
}
