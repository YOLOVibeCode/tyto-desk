import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { importCookies, importNativeHost, type DeskBrowser, type ImportResult, type Picker, type Prompter } from "@desk/core";
import { CdpCookieBrowser, HttpDevTools, NodeChromeProfile, NodeDevToolsPortFile, NodeNativeHostDir } from "@desk/chrome";
import { FileConfigStore, FileLogSink, NodeCodeSigning, NodeListenerInfo, NodeTextFiles, SystemClock } from "@desk/node";
import { launchCommand } from "./launch.ts";

/** Where the main Chrome keeps its default profile. */
export function mainChromeUserDataDir(home: string, platform: string): string {
  return platform === "darwin" ? join(home, "Library", "Application Support", "Google", "Chrome") : join(home, ".config", "google-chrome");
}

/** The Desk Chrome, started or reused as `desk` does, and its browser WebSocket. */
class LaunchingDeskBrowser implements DeskBrowser {
  private readonly launch: () => Promise<{ code: number }>;
  private readonly deskHome: string;

  constructor(launch: () => Promise<{ code: number }>, deskHome: string) {
    this.launch = launch;
    this.deskHome = deskHome;
  }

  async ensure(): Promise<{ port: number; wsUrl: string } | null> {
    if ((await this.launch()).code !== 0) return null;
    const config = await new FileConfigStore(this.deskHome).load();
    if (config === null) return null;
    const version = await new HttpDevTools().version(config.chrome.port);
    return version === null ? null : { port: config.chrome.port, wsUrl: version.wsUrl };
  }
}

/** `desk import cookies [--domains a,b]` (docs/IMPLEMENTATION.md §14): core's flow over the Chrome and Node adapters. */
export async function importCookiesCommand(input: {
  env: NodeJS.ProcessEnv;
  platform: string;
  home: string;
  deskHome: string;
  version: string;
  appDir: string;
  prompter: Prompter;
  picker: Picker;
  say: (line: string) => void;
  domains?: readonly string[];
}): Promise<ImportResult> {
  const config = await new FileConfigStore(input.deskHome).load();
  if (config === null) return { code: 75, message: "Desk has no config yet: run desk first" };
  const mainDir = mainChromeUserDataDir(input.home, input.platform);
  const audit = new FileLogSink(join(input.deskHome, "logs", "audit.log"));
  const result = await importCookies(
    {
      prompter: input.prompter,
      picker: input.picker,
      out: { say: input.say },
      portFile: new NodeDevToolsPortFile(mainDir),
      mainProfile: new NodeChromeProfile(mainDir),
      deskProfile: new NodeChromeProfile(config.chrome.userDataDir),
      listeners: new NodeListenerInfo(),
      browsers: new CdpCookieBrowser(),
      desk: new LaunchingDeskBrowser(
        () => launchCommand({ env: input.env, platform: input.platform, home: input.home, deskHome: input.deskHome, version: input.version, appDir: input.appDir }),
        input.deskHome,
      ),
      clock: new SystemClock(),
      audit,
    },
    // Where Chrome's executable lives, as launch finds it: the app bundle on macOS, the real wrapper's directory on Linux.
    {
      appRoot: input.platform === "darwin" ? config.chrome.app : dirname(await realpath(config.chrome.app).catch(() => config.chrome.app)),
      deskUserDataDir: config.chrome.userDataDir,
      ...(input.domains === undefined ? {} : { domains: input.domains }),
    },
  );
  // The audit line is on disk before desk exits.
  await audit.flushed();
  return result;
}

/** `desk import native-hosts --host <name>` (docs/IMPLEMENTATION.md §14): core's flow over the Chrome and Node adapters. */
export async function importNativeHostCommand(input: {
  platform: string;
  home: string;
  deskHome: string;
  host: string;
  prompter: Prompter;
  say: (line: string) => void;
}): Promise<ImportResult> {
  const config = await new FileConfigStore(input.deskHome).load();
  if (config === null) return { code: 75, message: "Desk has no config yet: run desk first" };
  const mainDir = mainChromeUserDataDir(input.home, input.platform);
  const main = new NodeNativeHostDir(mainDir);
  const audit = new FileLogSink(join(input.deskHome, "logs", "audit.log"));
  const result = await importNativeHost(
    {
      catalog: main,
      mainHosts: main,
      deskHosts: new NodeNativeHostDir(config.chrome.userDataDir),
      signing: new NodeCodeSigning(),
      files: new NodeTextFiles(),
      prompter: input.prompter,
      out: { say: input.say },
      audit,
    },
    { deskHome: input.deskHome, host: input.host },
  );
  await audit.flushed();
  return result;
}
