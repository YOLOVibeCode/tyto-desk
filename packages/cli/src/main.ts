import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseVersionInfo, versionLine, type Prompter, type VersionInfo } from "@desk/core";
import { ConfigFileError, FileLogSink, logCrashes } from "@desk/node";
import { runHost } from "@desk/nmhost";
import { cdpCommand } from "./cdp.ts";
import { newPortCommand } from "./config.ts";
import { deskPaths, installCommand } from "./install.ts";
import { launchCommand } from "./launch.ts";
import { TtyPrompter } from "./prompter.ts";
import { quitCommand } from "./quit.ts";
import { daemonRestartCommand, statusCommand } from "./status.ts";
import { tabCommand } from "./tab.ts";
import { watchCommand } from "./watch.ts";

export type MainInput = {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  platform: string;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream;
  /** The installed version's directory: desk.mjs and its version.json. */
  runtimeDir: string;
  prompter?: Prompter;
};

const USAGE = [
  "usage: desk                       start the Desk Chrome with the terminal panel",
  "       desk --version [--json]    this version, its channel, commit and build time",
  "       desk quit [--all]          close the Desk Chrome; --all also stops the terminal daemon and desk watch",
  "       desk cdp [--raw] [--ws]    the guarded endpoint for CDP clients; --raw the browser's own port",
  "       desk tab current|mine      the tab you are looking at, or this pane's agent tab (made in the background)",
  "       desk status                Chrome, desk watch, the terminal daemon, panes alive or exited, the agents",
  "       desk daemon restart        restart the terminal daemon after you confirm (tmux sessions survive)",
  "       desk config new-port       move the guarded endpoint to a new free port",
  "       desk install --from <dir>  install a runtime npm run pack built, after you confirm",
].join("\n");

/** Write errors that mean Desk cannot write ~/.desk (§6.5: 73). */
const CANNOT_WRITE = new Set(["EACCES", "EPERM", "EROFS", "ENOSPC", "EDQUOT"]);

async function versionInfo(runtimeDir: string): Promise<{ info: VersionInfo; text: string } | null> {
  const text = await readFile(join(runtimeDir, "version.json"), "utf8").catch(() => null);
  const info = text === null ? null : parseVersionInfo(text);
  return info === null || text === null ? null : { info, text };
}

/**
 * `desk.mjs`'s commands (docs/IMPLEMENTATION.md §6, §8, §15.1, §23.4). The daemon's entry is imported only when the
 * `ptyd` command runs, so nothing else ever loads the PTY package (scripts/lib/pty-boundary.mjs).
 */
export async function main(input: MainInput): Promise<number> {
  const { argv, stdout, stderr } = input;
  const say = (text: string) => stdout.write(`${text}\n`);
  const fail = (code: number, text: string) => {
    stderr.write(`desk: ${text}\n`);
    return code;
  };
  const usage = () => {
    stderr.write(`${USAGE}\n`);
    return 64;
  };
  const [command, ...rest] = argv;
  const version = await versionInfo(input.runtimeDir);
  if (version === null) return fail(70, `${join(input.runtimeDir, "version.json")} is missing or damaged; run desk install`);
  const { home, deskHome } = deskPaths(input.env);
  try {
    if (command === "--version") {
      if (rest.length === 0) say(versionLine(version.info));
      else if (rest.length === 1 && rest[0] === "--json") stdout.write(version.text.endsWith("\n") ? version.text : `${version.text}\n`);
      else return usage();
      return 0;
    }
    if (command === "nmhost") {
      return await runHost({ argv: rest, env: input.env, deskHome, platform: input.platform, stdin: input.stdin, stdout });
    }
    if (command === "ptyd" && rest.length === 0) {
      const daemon = await import("@desk/ptyd/main");
      return await daemon.runDaemon({ deskHome, env: input.env, version: version.info.version });
    }
    if (command === "install") {
      if (rest.length !== 2 || rest[0] !== "--from" || rest[1] === undefined) return usage();
      const result = await installCommand({
        from: rest[1],
        deskHome,
        home,
        platform: input.platform,
        prompter: input.prompter ?? new TtyPrompter(input.stdin, stdout),
        channel: version.info.channel,
      });
      if (result.code === 0) say(result.message);
      else fail(result.code, result.message);
      return result.code;
    }
    if (command === "status") {
      if (rest.length !== 0) return usage();
      const result = await statusCommand({ deskHome, version: version.info.version });
      say(result.message);
      return result.code;
    }
    if (command === "daemon") {
      if (rest.length !== 1 || rest[0] !== "restart") return usage();
      const result = await daemonRestartCommand({ deskHome, version: version.info.version, prompter: input.prompter ?? new TtyPrompter(input.stdin, stdout) });
      if (result.code === 0) say(result.message);
      else fail(result.code, result.message);
      await result.finish?.();
      return result.code;
    }
    if (command === "watch" && rest.length === 0) {
      const watchLog = new FileLogSink(join(deskHome, "logs", "watch.log"));
      logCrashes(process, watchLog, (code) => {
        void watchLog.flushed().then(() => process.exit(code));
      });
      const until = new Promise<void>((resolve) => {
        process.once("SIGTERM", () => resolve());
        process.once("SIGHUP", () => resolve());
      });
      return await watchCommand({ env: input.env, platform: input.platform, deskHome, version: version.info.version, until, log: watchLog });
    }
    if (command === "config") {
      if (rest.length !== 1 || rest[0] !== "new-port") return usage();
      const result = await newPortCommand({ env: input.env, platform: input.platform, deskHome, version: version.info.version, appDir: input.runtimeDir });
      if (result.code === 0) say(result.message);
      else fail(result.code, result.message);
      return result.code;
    }
    if (command === "cdp") {
      const flags = new Set(rest);
      if (flags.size !== rest.length || rest.some((flag) => flag !== "--raw" && flag !== "--ws")) return usage();
      const result = await cdpCommand({ deskHome, raw: flags.has("--raw"), ws: flags.has("--ws") });
      if (result.code === 0) say(result.message);
      else fail(result.code, result.message);
      return result.code;
    }
    if (command === "tab") {
      const which = rest[0];
      if (rest.length !== 1 || (which !== "current" && which !== "mine")) return usage();
      const result = await tabCommand({ deskHome, version: version.info.version, which, pane: input.env.DESK_PANE });
      if (result.code === 0) say(result.message);
      else fail(result.code, result.message);
      return result.code;
    }
    if (command === "quit") {
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--all")) return usage();
      const result = await quitCommand({
        deskHome,
        version: version.info.version,
        all: rest[0] === "--all",
        prompter: input.prompter ?? new TtyPrompter(input.stdin, stdout),
      });
      if (result.code === 0) say(result.message);
      else fail(result.code, result.message);
      await result.finish?.();
      return result.code;
    }
    if (command === undefined) {
      const result = await launchCommand({ env: input.env, platform: input.platform, home, deskHome, version: version.info.version, appDir: input.runtimeDir });
      if (result.code === 0) say(result.message);
      else fail(result.code, result.message);
      return result.code;
    }
    return usage();
  } catch (err) {
    if (err instanceof ConfigFileError) return fail(65, `${join(deskHome, "config.json")}: ${err.message}`);
    const code = err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : "";
    if (CANNOT_WRITE.has(code)) return fail(73, `cannot write ${deskHome} (${code})`);
    return fail(70, `internal error (${err instanceof Error ? err.name : "unknown"})`);
  }
}
