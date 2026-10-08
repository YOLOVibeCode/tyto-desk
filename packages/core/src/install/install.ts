import { NATIVE_HOST_NAME } from "../extension/desk-extension.ts";
import { nativeHostLauncher, nativeHostManifest } from "../extension/native-host.ts";
import { pollUntil } from "../launch/poll.ts";
import type { AppVersions } from "../ports/app-versions.ts";
import type { Clock } from "../ports/clock.ts";
import type { CodeSigning } from "../ports/code-signing.ts";
import type { InstanceLock } from "../ports/instance-lock.ts";
import type { NativeHostDir } from "../ports/native-host-dir.ts";
import type { Prompter } from "../ports/prompter.ts";
import type { TextFiles } from "../ports/text-files.ts";
import { parseVersionInfo } from "../version/version-info.ts";
import { nextInstalled, parseInstalled, serializeInstalled, type InstalledVersion } from "./installed.ts";
import { deskLauncher, hostLauncher } from "./launchers.ts";
import { stateTooNew } from "./state-compat.ts";

export type InstallPorts = {
  lock: InstanceLock;
  versions: AppVersions;
  signing: CodeSigning;
  prompter: Prompter;
  files: TextFiles;
  hosts: NativeHostDir;
  clock: Clock;
};

export type InstallInput = {
  /** A runtime `npm run pack` (or a release) produced: version.json, files.sha256, and the files it lists. */
  from: string;
  deskHome: string;
  home: string;
  platform: string;
  /** Where the runtime came from, for installed.json: `dev` for a checkout's build. */
  provenance: string;
  /** Now, as UTC ISO 8601. */
  now: string;
  /** What `desk update` asked for: the runtime's version.json must name exactly this (§23.5 rule 2). */
  expected?: { version: string; channel: string; commit: string };
  /** The prompt names a downgrade as one (§23.5 rule 9). */
  downgrade?: boolean;
};

/** §6.5: 64 needs an interactive terminal · 65 a check failed · 75 another install runs · 77 the operator declined. */
export type InstallResult = { ok: true; version: string; message: string } | { ok: false; code: 64 | 65 | 75 | 77; message: string };

const INSTALL_LOCK_MS = 10_000;
const LAUNCHER = 0o700;
const PRIVATE = 0o600;

/** Whether installed.json's entry for a version is one (installed.json validates only its own keys, §4.3). */
function isRecordedVersion(value: unknown): value is InstalledVersion {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { build?: unknown }).build === "string";
}

/**
 * `desk install --from <dir>`, the version steps (docs/IMPLEMENTATION.md §15.1, §23.5 rules 1–4; slice 1c). Under
 * `run/install.lock`: a damaged installed.json stops it before anything changes; the runtime is copied into a staging
 * directory and verified (files.sha256, a readable version.json, and on macOS `codesign --verify --strict` on Desk
 * Terminal) before it is renamed into `app/<version>`. Installing an installed version changes nothing of it (D98): its
 * files and what installed.json recorded for it stay, and another build of it is discarded. `current` switches only
 * after the operator confirms on a TTY; then installed.json records it, and the launchers and the Desk host manifest are
 * written. Nothing here starts Chrome. Retention (keep three) is slice D2's: 1c removes no version.
 */
export async function installVersion(ports: InstallPorts, input: InstallInput): Promise<InstallResult> {
  const lock = await pollUntil(ports.clock, INSTALL_LOCK_MS, 100, async () => {
    const attempt = await ports.lock.acquire("install");
    return attempt.ok ? attempt : null;
  });
  if (lock === null) return { ok: false, code: 75, message: "another desk install is running; run it again once it is done" };
  try {
    const installedPath = `${input.deskHome}/installed.json`;
    const previousText = await ports.files.read(installedPath);
    const previous = previousText === null ? null : parseInstalled(previousText);
    if (previousText !== null && previous === null) {
      return { ok: false, code: 65, message: `${installedPath} is damaged; move it aside and run desk install again; nothing was installed` };
    }

    const staged = await ports.versions.stage(input.from);
    if (!staged.ok) {
      return { ok: false, code: 65, message: `the runtime at ${input.from} does not match its files.sha256 (${staged.reason}); nothing was installed` };
    }
    const info = parseVersionInfo(staged.versionJson);
    const expected = input.expected;
    if (info !== null && expected !== undefined && (info.version !== expected.version || info.channel !== expected.channel || info.commit !== expected.commit)) {
      await ports.versions.discard(staged.staging);
      return {
        ok: false,
        code: 65,
        message: `the download's version.json names ${info.version} (${info.channel}, ${info.commit}), not ${expected.version} (${expected.channel}, ${expected.commit}); nothing was installed`,
      };
    }
    const verified = info !== null && (input.platform !== "darwin" || (await ports.signing.verify(`${staged.staging}/Desk Terminal.app`)));
    if (info === null || !verified) {
      await ports.versions.discard(staged.staging);
      const what = info === null ? "its version.json is damaged" : "Desk Terminal's signature does not verify";
      return { ok: false, code: 65, message: `the runtime at ${input.from} is refused: ${what}; nothing was installed` };
    }
    // A version that would become current must read every state file on disk, or it would move one aside (rule 6).
    const tooNew = (await ports.versions.current()) === info.version ? null : await stateTooNew(ports.files, input.deskHome, info);
    if (tooNew !== null) {
      await ports.versions.discard(staged.staging);
      return { ok: false, code: 65, message: `${tooNew}; nothing was installed` };
    }
    const alreadyInstalled = (await ports.versions.list()).includes(info.version);
    if (alreadyInstalled && expected !== undefined) {
      // A verified build never stands in for another one installed under its name: the installed copy must be recorded as
      // that commit and channel, as desk update requires (§23.5, D114).
      const recorded = previous?.versions[info.version];
      if (recorded?.commit !== expected.commit || recorded.channel !== expected.channel) {
        await ports.versions.discard(staged.staging);
        return { ok: false, code: 65, message: `another build of Desk ${info.version} is installed, not ${expected.channel} at ${expected.commit}; nothing changed` };
      }
    }
    let build = staged.build;
    if (alreadyInstalled) {
      await ports.versions.discard(staged.staging);
      const installedBuild = await ports.versions.build(info.version);
      if (installedBuild === null) {
        return {
          ok: false,
          code: 65,
          message: `Desk ${info.version} is installed, but its copy in ${input.deskHome}/app/${info.version} is damaged (no files.sha256); nothing changed`,
        };
      }
      build = installedBuild;
    } else {
      await ports.versions.commit(staged.staging, info.version);
    }

    const before = await ports.versions.current();
    const alreadyCurrent = before === info.version;
    if (!alreadyCurrent) {
      const consent = await ports.prompter.confirm(
        `${input.downgrade === true ? "This is a downgrade. " : ""}Make Desk ${info.version} the current version? Running shells and tmux sessions keep running; the next desk loads it.`,
      );
      if (!consent.ok) {
        return { ok: false, code: 64, message: `Desk ${info.version} is installed; making it current needs an interactive terminal` };
      }
      if (!consent.yes) return { ok: false, code: 77, message: `Desk ${info.version} is installed but not current: you declined` };
      await ports.versions.use(info.version);
    }

    // An installed version keeps what installed.json recorded when its files were installed.
    const recorded: unknown = alreadyInstalled ? previous?.versions[info.version] : undefined;
    const entry =
      !isRecordedVersion(recorded)
        ? { version: info.version, channel: info.channel, build, provenance: input.provenance, commit: info.commit, installedAt: input.now }
        : { ...recorded, version: info.version };
    // Without an installed.json yet, the version current named before the switch is still the previous one.
    const base = previous ?? { version: 1 as const, current: before, previous: null, versions: {}, files: [] };
    await ports.files.write(installedPath, serializeInstalled(nextInstalled(base, entry, true)), PRIVATE);

    const launchers = { deskHome: input.deskHome, platform: input.platform };
    await ports.files.write(`${input.home}/.local/bin/desk`, deskLauncher(launchers), LAUNCHER);
    await ports.files.write(nativeHostLauncher(input.deskHome), hostLauncher(launchers), LAUNCHER);
    const manifest = nativeHostManifest(input.deskHome);
    if ((await ports.hosts.read(NATIVE_HOST_NAME)) !== manifest) await ports.hosts.write(NATIVE_HOST_NAME, manifest);
    const kept = build === staged.build ? "" : `; ${input.from} is another build of it, and the installed copy stays as it was`;
    return {
      ok: true,
      version: info.version,
      message: alreadyCurrent ? `${info.version} is installed and current${kept}; run desk` : `Installed ${info.version}${kept}; run desk`,
    };
  } finally {
    await lock.release();
  }
}
