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
import { nextInstalled, parseInstalled, serializeInstalled } from "./installed.ts";
import { deskLauncher, hostLauncher } from "./launchers.ts";

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
};

/** §6.5: 64 needs an interactive terminal · 65 a check failed · 75 another install runs · 77 the operator declined. */
export type InstallResult = { ok: true; version: string; message: string } | { ok: false; code: 64 | 65 | 75 | 77; message: string };

const INSTALL_LOCK_MS = 10_000;
const LAUNCHER = 0o700;
const PRIVATE = 0o600;

/**
 * `desk install --from <dir>`, the version steps (docs/IMPLEMENTATION.md §15.1, §23.5 rules 1–4; slice 1c). Under
 * `run/install.lock`: the runtime is copied into a staging directory and verified (files.sha256, a readable
 * version.json, and on macOS `codesign --verify --strict` on Desk Terminal) before it is renamed into `app/<version>`;
 * an installed version is not copied again. `current` switches only after the operator confirms on a TTY; then
 * installed.json records it, and the launchers and the Desk host manifest are written. Nothing here starts Chrome.
 * Retention (keep three) is slice D2's: 1c removes no version.
 */
export async function installVersion(ports: InstallPorts, input: InstallInput): Promise<InstallResult> {
  const lock = await pollUntil(ports.clock, INSTALL_LOCK_MS, 100, async () => {
    const attempt = await ports.lock.acquire("install");
    return attempt.ok ? attempt : null;
  });
  if (lock === null) return { ok: false, code: 75, message: "another desk install is running; run it again once it is done" };
  try {
    const staged = await ports.versions.stage(input.from);
    if (!staged.ok) {
      return { ok: false, code: 65, message: `the runtime at ${input.from} does not match its files.sha256 (${staged.reason}); nothing was installed` };
    }
    const info = parseVersionInfo(staged.versionJson);
    const verified = info !== null && (input.platform !== "darwin" || (await ports.signing.verify(`${staged.staging}/Desk Terminal.app`)));
    if (info === null || !verified) {
      await ports.versions.discard(staged.staging);
      const what = info === null ? "its version.json is damaged" : "Desk Terminal's signature does not verify";
      return { ok: false, code: 65, message: `the runtime at ${input.from} is refused: ${what}; nothing was installed` };
    }
    if ((await ports.versions.list()).includes(info.version)) await ports.versions.discard(staged.staging);
    else await ports.versions.commit(staged.staging, info.version);

    const before = await ports.versions.current();
    const alreadyCurrent = before === info.version;
    if (!alreadyCurrent) {
      const consent = await ports.prompter.confirm(
        `Make Desk ${info.version} the current version? Running shells and tmux sessions keep running; the next desk loads it.`,
      );
      if (!consent.ok) {
        return { ok: false, code: 64, message: `Desk ${info.version} is installed; making it current needs an interactive terminal` };
      }
      if (!consent.yes) return { ok: false, code: 77, message: `Desk ${info.version} is installed but not current: you declined` };
      await ports.versions.use(info.version);
    }

    const installedPath = `${input.deskHome}/installed.json`;
    const previousText = await ports.files.read(installedPath);
    const previous = previousText === null ? null : parseInstalled(previousText);
    if (previousText !== null && previous === null) {
      return { ok: false, code: 65, message: `${installedPath} is damaged; move it aside and run desk install again` };
    }
    const entry = { version: info.version, channel: info.channel, build: staged.build, provenance: input.provenance, commit: info.commit, installedAt: input.now };
    // Without an installed.json yet, the version current named before the switch is still the previous one.
    const base = previous ?? { version: 1 as const, current: before, previous: null, versions: {}, files: [] };
    await ports.files.write(installedPath, serializeInstalled(nextInstalled(base, entry, true)), PRIVATE);

    const launchers = { deskHome: input.deskHome, platform: input.platform };
    await ports.files.write(`${input.home}/.local/bin/desk`, deskLauncher(launchers), LAUNCHER);
    await ports.files.write(nativeHostLauncher(input.deskHome), hostLauncher(launchers), LAUNCHER);
    const manifest = nativeHostManifest(input.deskHome);
    if ((await ports.hosts.read(NATIVE_HOST_NAME)) !== manifest) await ports.hosts.write(NATIVE_HOST_NAME, manifest);
    return {
      ok: true,
      version: info.version,
      message: alreadyCurrent ? `${info.version} is installed and current; run desk` : `Installed ${info.version}; run desk`,
    };
  } finally {
    await lock.release();
  }
}
