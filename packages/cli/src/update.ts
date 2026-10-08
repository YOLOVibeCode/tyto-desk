import { join } from "node:path";
import { update, type Prompter, type VersionInfo } from "@desk/core";
import { NodeNativeHostDir } from "@desk/chrome";
import {
  CryptoRandom,
  FileConfigStore,
  NodeAppVersions,
  NodeCodeSigning,
  NodeFileDigest,
  NodeInstanceLock,
  NodeTextFiles,
  NodeTreeRemover,
  SystemClock,
  TarArchive,
} from "@desk/node";
import type { CommandResult } from "./install.ts";
import { GhProvenance } from "./provenance.ts";
import { GitHubReleaseFeed } from "./release-feed.ts";
import { retainAfterInstall } from "./versions.ts";

const REPO = "YOLOVibeCode/tyto-desk";

/**
 * The runtime this machine takes: macOS on arm64; a linux-arm64 pack only inside the Desk test container
 * (`DESK_IN_CONTAINER=1`, as `guiAllowed` reads it), and nowhere else.
 */
export function updateAsset(env: NodeJS.ProcessEnv, platform: string, arch: string): string | null {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux" && arch === "arm64" && env.DESK_IN_CONTAINER === "1") return "linux-arm64";
  return null;
}

/** `desk update [--channel stable|edge] [--version X.Y.Z] [--check]` (docs/IMPLEMENTATION.md §23.5). */
export async function updateCommand(input: {
  env: NodeJS.ProcessEnv;
  platform: string;
  arch: string;
  home: string;
  deskHome: string;
  info: VersionInfo;
  prompter: Prompter;
  channel?: "stable" | "edge";
  version?: string;
  check: boolean;
}): Promise<CommandResult> {
  const asset = updateAsset(input.env, input.platform, input.arch);
  if (asset === null) return { code: 65, message: "desk update installs releases on macOS on arm64 only" };
  const config = await new FileConfigStore(input.deskHome).load();
  if (config === null) return { code: 69, message: "Desk has no config yet; run desk" };
  // The release API's base moves only inside the test container, where a fixture plays GitHub.
  const api = input.env.DESK_IN_CONTAINER === "1" ? input.env.DESK_RELEASE_API : undefined;
  const result = await update(
    {
      feed: new GitHubReleaseFeed({ ...(api === undefined ? {} : { api }), repo: REPO, asset, env: input.env }),
      provenance: new GhProvenance({ repo: REPO, env: input.env }),
      digest: new NodeFileDigest(),
      archive: new TarArchive(),
      random: new CryptoRandom(),
      trees: new NodeTreeRemover(),
      lock: new NodeInstanceLock(join(input.deskHome, "run")),
      versions: new NodeAppVersions(input.deskHome),
      signing: new NodeCodeSigning(),
      prompter: input.prompter,
      files: new NodeTextFiles(),
      hosts: new NodeNativeHostDir(config.chrome.userDataDir),
      clock: new SystemClock(),
    },
    {
      deskHome: input.deskHome,
      home: input.home,
      platform: input.platform,
      asset,
      current: input.info,
      ...(input.channel === undefined ? {} : { channel: input.channel }),
      ...(input.version === undefined ? {} : { version: input.version }),
      check: input.check,
      now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    },
  );
  if (result.code === 0 && result.message.startsWith("Updated to")) await retainAfterInstall(input.deskHome, input.prompter);
  return result;
}
