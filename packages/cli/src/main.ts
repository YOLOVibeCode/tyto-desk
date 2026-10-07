import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseVersionInfo, versionLine, type Prompter, type VersionInfo } from "@desk/core";
import { ConfigFileError } from "@desk/node";
import { runHost } from "@desk/nmhost";
import { deskPaths, installCommand } from "./install.ts";
import { launchCommand } from "./launch.ts";
import { TtyPrompter } from "./prompter.ts";

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
