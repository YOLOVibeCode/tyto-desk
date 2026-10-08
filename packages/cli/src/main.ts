import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseVersionInfo, setToggleKey, versionLine, type Picker, type Prompter, type VersionInfo } from "@desk/core";
import { ConfigFileError, FileConfigStore, FileLogSink, logCrashes } from "@desk/node";
import { runHost } from "@desk/nmhost";
import { agentPolicyCommand, agentsCommand } from "./agents.ts";
import { cdpCommand } from "./cdp.ts";
import { doctorCommand } from "./doctor.ts";
import { uninstallCommand } from "./uninstall.ts";
import { updateCommand } from "./update.ts";
import { versionsCommand } from "./versions.ts";
import { newPortCommand } from "./config.ts";
import { deskPaths, installCommand } from "./install.ts";
import { launchCommand } from "./launch.ts";
import { importCookiesCommand, importNativeHostCommand } from "./import.ts";
import { TtyPicker, TtyPrompter } from "./prompter.ts";
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
  /** A picker the tests script (desk import cookies). */
  picker?: Picker;
};

const USAGE = [
  "usage: desk                       start the Desk Chrome with the terminal panel",
  "       desk --version [--json]    this version, its channel, commit and build time",
  "       desk quit [--all]          close the Desk Chrome; --all also stops the terminal daemon and desk watch",
  "       desk cdp [--raw] [--ws]    the guarded endpoint for CDP clients; --raw the browser's own port",
  "       desk tab current|mine      the tab you are looking at, or this pane's agent tab (made in the background)",
  "       desk status                Chrome, desk watch, the terminal daemon, panes alive or exited, the agents",
  "       desk doctor [--fix]        what is wrong and how to fix it; --fix rewrites only what lives in ~/.desk",
  "       desk uninstall [--profile] remove what install added, after you confirm; --profile also the Desk profile",
  "       desk versions | desk use <version> | desk rollback   the installed versions, and switching between them",
  "       desk update [--channel stable|edge] [--version X.Y.Z] [--check]   install a newer release after checking its provenance",
  "       desk daemon restart        restart the terminal daemon after you confirm (tmux sessions survive)",
  "       desk config new-port       move the guarded endpoint to a new free port",
  "       desk config toggle-key <key>   the shortcut that shows, focuses or hides the panel (Command+Shift+Period)",
  "       desk import cookies [--domains a,b]   move cookies you choose from your main Chrome into Desk",
  "       desk import native-hosts --host <name>   copy one of your main Chrome's native-messaging hosts into Desk",
  "       desk config agent-policy strict|open   whether agents may read cookies, storage and saved state",
  "       desk agents [pause|resume|detach]       Desk's agent sessions; pause refuses every command but close",
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
        env: input.env,
      });
      if (result.code === 0) say(result.message);
      else fail(result.code, result.message);
      return result.code;
    }
    if (command === "update") {
      let channel: "stable" | "edge" | undefined;
      let wanted: string | undefined;
      let check = false;
      for (let i = 0; i < rest.length; i += 1) {
        const flag = rest[i];
        const value = rest[i + 1];
        if (flag === "--check" && !check) check = true;
        else if (flag === "--channel" && channel === undefined && (value === "stable" || value === "edge")) {
          channel = value;
          i += 1;
        } else if (flag === "--version" && wanted === undefined && value !== undefined && /^\d+\.\d+\.\d+$/.test(value)) {
          wanted = value;
          i += 1;
        } else return usage();
      }
      const result = await updateCommand({
        env: input.env,
        platform: input.platform,
        arch: process.arch,
        home,
        deskHome,
        info: version.info,
        prompter: input.prompter ?? new TtyPrompter(input.stdin, stdout),
        ...(channel === undefined ? {} : { channel }),
        ...(wanted === undefined ? {} : { version: wanted }),
        check,
      });
      if (result.code === 0) say(result.message);
      else fail(result.code, result.message);
      return result.code;
    }
    if (command === "versions" || command === "use" || command === "rollback") {
      const prompter = input.prompter ?? new TtyPrompter(input.stdin, stdout);
      const target = rest[0];
      if (command === "use" ? rest.length !== 1 || target === undefined : rest.length !== 0) return usage();
      const result =
        command === "use" && target !== undefined
          ? await versionsCommand({ deskHome, prompter, action: "use", version: target })
          : await versionsCommand({ deskHome, prompter, action: command === "versions" ? "list" : "rollback" });
      if (result.code === 0) say(result.message);
      else fail(result.code, result.message);
      return result.code;
    }
    if (command === "uninstall") {
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--profile")) return usage();
      const result = await uninstallCommand({
        home,
        deskHome,
        version: version.info.version,
        profile: rest[0] === "--profile",
        prompter: input.prompter ?? new TtyPrompter(input.stdin, stdout),
      });
      if (result.code === 0) say(result.message);
      else fail(result.code, result.message);
      return result.code;
    }
    if (command === "doctor") {
      const flags = new Set(rest);
      if (flags.size !== rest.length || rest.some((flag) => flag !== "--fix" && flag !== "--autofill-probe")) return usage();
      const result = await doctorCommand({
        env: input.env,
        platform: input.platform,
        home,
        deskHome,
        info: version.info,
        fix: flags.has("--fix"),
        ...(flags.has("--autofill-probe") ? { autofillProbe: true, prompter: input.prompter ?? new TtyPrompter(input.stdin, stdout), say } : {}),
      });
      say(result.message);
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
    if (command === "agents") {
      const action = rest[0] ?? "list";
      if (rest.length > 1 || (action !== "list" && action !== "pause" && action !== "resume" && action !== "detach")) return usage();
      const result = await agentsCommand({
        env: input.env,
        home,
        deskHome,
        version: version.info.version,
        prompter: input.prompter ?? new TtyPrompter(input.stdin, stdout),
        action,
      });
      if (result.code === 0) say(result.message);
      else fail(result.code, result.message);
      return result.code;
    }
    if (command === "import" && rest[0] === "native-hosts") {
      const host = rest[2];
      if (rest.length !== 3 || rest[1] !== "--host" || host === undefined || !/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(host)) return usage();
      const result = await importNativeHostCommand({ platform: input.platform, home, deskHome, host, prompter: input.prompter ?? new TtyPrompter(input.stdin, stdout), say });
      if (result.code === 0) say(result.message);
      else fail(result.code, result.message);
      return result.code;
    }
    if (command === "import" && rest[0] === "cookies") {
      let domains: string[] | undefined;
      const flags = rest.slice(1);
      if (flags.length === 2 && flags[0] === "--domains" && flags[1] !== undefined && /^[a-z0-9.-]+(,[a-z0-9.-]+)*$/i.test(flags[1])) domains = flags[1].split(",");
      else if (flags.length !== 0) return usage();
      const result = await importCookiesCommand({
        env: input.env,
        platform: input.platform,
        home,
        deskHome,
        version: version.info.version,
        appDir: input.runtimeDir,
        prompter: input.prompter ?? new TtyPrompter(input.stdin, stdout),
        picker: input.picker ?? new TtyPicker(input.stdin, stdout),
        say,
        ...(domains === undefined ? {} : { domains }),
      });
      if (result.code === 0) say(result.message);
      else fail(result.code, result.message);
      return result.code;
    }
    if (command === "config" && rest[0] === "toggle-key") {
      const key = rest[1];
      if (rest.length !== 2 || key === undefined) return usage();
      const result = await setToggleKey({ config: new FileConfigStore(deskHome) }, key);
      if (result.code === 0) say(result.message);
      else fail(result.code, result.message);
      return result.code;
    }
    if (command === "config" && rest[0] === "agent-policy") {
      const mode = rest[1];
      if (rest.length !== 2 || (mode !== "strict" && mode !== "open")) return usage();
      const result = await agentPolicyCommand({
        env: input.env,
        home,
        deskHome,
        version: version.info.version,
        prompter: input.prompter ?? new TtyPrompter(input.stdin, stdout),
        mode,
      });
      if (result.code === 0) say(result.message);
      else fail(result.code, result.message);
      return result.code;
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
      const result = await cdpCommand({ deskHome, home, env: input.env, raw: flags.has("--raw"), ws: flags.has("--ws") });
      if (result.warning !== undefined) stderr.write(`desk: ${result.warning}\n`);
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
