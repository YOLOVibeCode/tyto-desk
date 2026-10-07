/** Desk Terminal, Desk's own copy of Node, inside an installed version (§15.1). */
export function terminalBinary(platform: string): string {
  return platform === "darwin" ? "Desk Terminal.app/Contents/MacOS/desk-node" : "node/desk-node";
}

/** Single-quoted for /bin/sh. */
function shQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Variables no Desk process inherits (§0 Safety, §15.1). */
const UNSET = "-u NODE_OPTIONS -u NODE_PATH -u NODE_REPL_EXTERNAL_MODULE";

function launcher(input: { deskHome: string; platform: string }, purpose: string, environment: string, entryArgs: string): string {
  const deskHome = input.deskHome.replace(/\/+$/, "");
  const current = `${deskHome}/app/current`;
  return [
    "#!/bin/sh",
    `# ${purpose}, written by desk install. It resolves ${current} once and runs that version's Desk Terminal, never`,
    "# the source tree and never through current, so a process never loads code from two versions (docs/IMPLEMENTATION.md §15.1).",
    `version=$(cd -P -- ${shQuote(current)} 2>/dev/null && pwd -P) || {`,
    `  echo "desk: no current version in ${deskHome.replaceAll('"', "")}/app; run desk install" >&2`,
    "  exit 69",
    "}",
    `exec /usr/bin/env ${UNSET} DESK_HOME=${shQuote(deskHome)}${environment} "$version/${terminalBinary(input.platform)}" "$version/desk.mjs"${entryArgs} "$@"`,
    "",
  ].join("\n");
}

/** `~/.local/bin/desk`: the only launcher that lets Desk open windows (`DESK_ALLOW_GUI=1`, §0). */
export function deskLauncher(input: { deskHome: string; platform: string }): string {
  return launcher(input, "Tyto Desk's desk command", " DESK_ALLOW_GUI=1", "");
}

/** `~/.desk/bin/desk-nmhost`, which Chrome starts for the Desk extension with its origin as the first argument (§8). */
export function hostLauncher(input: { deskHome: string; platform: string }): string {
  return launcher(input, "Tyto Desk's native-messaging host", "", " nmhost");
}
