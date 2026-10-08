import { join } from "node:path";
import { userInfo } from "node:os";
import { guiAllowed, installExtras, installVersion, loadOrCreateConfig, type PortProbe, type Prompter, type Random } from "@desk/core";
import { NodeNativeHostDir } from "@desk/chrome";
import { retainAfterInstall } from "./versions.ts";
import {
  CryptoRandom,
  FileConfigStore,
  NodeAppVersions,
  NodeCodeSigning,
  NodeInstanceLock,
  NodeLaunchAgents,
  NodePortProbe,
  NodeTextFiles,
  NodeTmux,
  SystemClock,
  findTmux,
} from "@desk/node";

export type InstallCommandInput = {
  from: string;
  deskHome: string;
  home: string;
  platform: string;
  prompter: Prompter;
  /** The runtime's channel, from its version.json: a dev build's provenance is `dev`. */
  channel: string;
  probe?: PortProbe;
  random?: Random;
  codesign?: string;
  /** The environment tmux is asked in (its socket), and nothing else of it. */
  env?: NodeJS.ProcessEnv;
};

/** A command's exit code and stdout line, and a warning for stderr. */
export type CommandResult = { code: number; message: string; warning?: string };

/**
 * `desk install --from <dir>` (slice 1c's minimal install, docs/IMPLEMENTATION.md §15.1): the version steps of core's
 * install plan over the Node adapters. The config is made first when there is none, since the host manifest goes into
 * the Desk profile it names.
 */
export async function installCommand(input: InstallCommandInput): Promise<CommandResult> {
  const loaded = await loadOrCreateConfig({
    store: new FileConfigStore(input.deskHome),
    probe: input.probe ?? new NodePortProbe(),
    random: input.random ?? new CryptoRandom(),
    home: input.home,
    platform: input.platform,
  });
  if (!loaded.ok) return { code: loaded.code === "no-free-ports" ? 75 : 65, message: `Desk cannot make a config here (${loaded.code})` };
  const result = await installVersion(
    {
      lock: new NodeInstanceLock(join(input.deskHome, "run")),
      versions: new NodeAppVersions(input.deskHome),
      signing: new NodeCodeSigning(input.codesign),
      prompter: input.prompter,
      files: new NodeTextFiles(),
      hosts: new NodeNativeHostDir(loaded.config.chrome.userDataDir),
      clock: new SystemClock(),
    },
    {
      from: input.from,
      deskHome: input.deskHome,
      home: input.home,
      platform: input.platform,
      provenance: input.channel === "dev" ? "dev" : "directory",
      now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    },
  );
  if (!result.ok) return { code: result.code, message: result.message };
  // The steps after the version steps (§15.1): the skills, then each consent step whose result is missing.
  const env = input.env ?? { HOME: input.home };
  const binary = await findTmux(loaded.config.terminal.tmux);
  const extras = await installExtras(
    {
      lock: new NodeInstanceLock(join(input.deskHome, "run")),
      files: new NodeTextFiles(),
      prompter: input.prompter,
      tmux: binary === null ? null : new NodeTmux(binary, env),
      signing: new NodeCodeSigning(input.codesign),
      agents: new NodeLaunchAgents({ home: input.home, uid: process.getuid?.() ?? 0 }),
      clock: new SystemClock(),
    },
    { home: input.home, deskHome: input.deskHome, platform: input.platform, guiAllowed: guiAllowed(env, input.platform) },
  );
  if (!extras.ok) return { code: extras.code, message: `${result.message}, but ${extras.message}` };
  // Keep three versions, never one a running Desk process uses (§23.5 rule 7).
  await retainAfterInstall(input.deskHome, input.prompter);
  return { code: 0, message: extras.notes.length === 0 ? result.message : `${result.message}. Notes: ${extras.notes.join("; ")}` };
}

/** Where Desk keeps its state: DESK_HOME, which the launchers set, else ~/.desk. */
export function deskPaths(env: NodeJS.ProcessEnv): { home: string; deskHome: string } {
  const home = env.HOME ?? userInfo().homedir;
  return { home, deskHome: env.DESK_HOME ?? join(home, ".desk") };
}
