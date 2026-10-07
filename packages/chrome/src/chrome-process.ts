import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { guiAllowed, type ChromeProcess, type ChromeStart } from "@desk/core";
import { NodeDetachedSpawner, assertPathAllowed, runArgv } from "@desk/node";

/** What Chrome's process gets from Desk's: enough to find its display, home and locale. Nothing else is inherited. */
const CHROME_ENV = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "DISPLAY",
  "XAUTHORITY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
];

/**
 * How Desk starts the installed Chrome (docs/IMPLEMENTATION.md §6.1 step 7): on macOS through LaunchServices,
 * `/usr/bin/open -n -a <app> --args …`, so Chrome gets launchd's environment and its own privacy identity; on Linux
 * (the test container) the binary itself.
 */
export function chromeStartCommand(platform: string, app: string, args: readonly string[]): { file: string; args: string[] } {
  return platform === "darwin" ? { file: "/usr/bin/open", args: ["-n", "-a", app, "--args", ...args] } : { file: app, args: [...args] };
}

/**
 * The installed Google Chrome (`ChromeProcess`). It starts Chrome only when `guiAllowed` says so for the environment it
 * was given (never under Vitest), always with the arguments core's `chromeArgs` made, and never signals it.
 */
export class NodeChromeProcess implements ChromeProcess {
  private readonly app: string;
  private readonly platform: string;
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(options: { app: string; platform: string; env: Readonly<Record<string, string | undefined>> }) {
    this.app = options.app;
    this.platform = options.platform;
    this.env = options.env;
  }

  private childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of CHROME_ENV) {
      const value = this.env[name];
      if (value !== undefined) env[name] = value;
    }
    return env;
  }

  async version(): Promise<string | null> {
    await assertPathAllowed(this.app);
    if (this.platform === "darwin") {
      const plist = await readFile(join(this.app, "Contents", "Info.plist"), "utf8").catch(() => null);
      const match = plist === null ? null : /<key>CFBundleShortVersionString<\/key>\s*<string>([0-9.]+)<\/string>/.exec(plist);
      return match?.[1] ?? null;
    }
    const result = await runArgv(this.app, ["--version"], { env: this.childEnv(), timeoutMs: 20_000 });
    return result.code === 0 ? (/(\d+\.\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? null) : null;
  }

  async start(args: readonly string[]): Promise<ChromeStart> {
    if (!guiAllowed(this.env, this.platform)) return { ok: false, reason: "gui-refused" };
    const command = chromeStartCommand(this.platform, this.app, args);
    if (this.platform === "darwin") {
      const opened = await runArgv(command.file, command.args, { env: this.childEnv(), timeoutMs: 10_000 });
      return opened.code === 0 ? { ok: true, pid: null } : { ok: false, reason: "failed" };
    }
    const pid = await new NodeDetachedSpawner().spawn(command.file, command.args, this.childEnv());
    return pid === null ? { ok: false, reason: "failed" } : { ok: true, pid };
  }
}
