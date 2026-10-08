import { pollUntil } from "../launch/poll.ts";
import type { AppVersions } from "../ports/app-versions.ts";
import type { Clock } from "../ports/clock.ts";
import type { InstanceLock } from "../ports/instance-lock.ts";
import type { ProcessInfo } from "../ports/process-info.ts";
import type { Prompter } from "../ports/prompter.ts";
import type { TextFiles } from "../ports/text-files.ts";
import { compareVersions } from "../release/semver.ts";
import { parseVersionInfo } from "../version/version-info.ts";
import { parseInstalled, serializeInstalled, type Installed } from "./installed.ts";

export type VersionsPorts = { versions: AppVersions; files: TextFiles; lock: InstanceLock; processes: ProcessInfo; prompter: Prompter; clock: Clock };

/** §6.5: 64 needs an interactive terminal · 65 refused · 75 another install runs · 77 the operator declined. */
export type VersionsResult = { code: 0 | 64 | 65 | 75 | 77; message: string };

const INSTALL_LOCK_MS = 10_000;
/** The state files `desk use` checks (§23.5 rule 6): each one's `version` against the target's `compat.state`. */
const STATE_FILES = ["config", "layout", "panes", "installed"] as const;

/** The version a path under `app/` belongs to (`…/app/0.3.1/node/desk-node` → `0.3.1`), or `null`. */
function versionOfPath(appDir: string, path: string): string | null {
  const prefix = `${appDir}/`;
  if (!path.startsWith(prefix)) return null;
  const name = path.slice(prefix.length).split("/")[0] ?? "";
  return name === "" || name === "current" || name.startsWith(".") ? null : name;
}

/**
 * The versions running Desk processes use, with who uses each: the daemon and `desk watch` from their locks, and any
 * other process whose executable lies under `app/<version>` (native hosts). `null` when the processes cannot be listed.
 */
async function versionsInUse(ports: VersionsPorts, deskHome: string): Promise<Map<string, string[]> | null> {
  const used = new Map<string, string[]>();
  const mark = (version: string, who: string) => used.set(version, [...(used.get(version) ?? []), who]);
  const known = new Set<number>();
  for (const [name, who] of [["ptyd", "terminal daemon"], ["watch", "desk watch"]] as const) {
    const holder = await ports.lock.holder(name);
    if (holder === null) continue;
    known.add(holder.pid);
    if (holder.build !== null) mark(holder.build, who);
  }
  const appDir = `${deskHome}/app`;
  const running = await ports.processes.executablesUnder(appDir);
  if (running === null) return null;
  for (const { pid, exe } of running) {
    const version = versionOfPath(appDir, exe);
    if (version !== null && !known.has(pid) && !(used.get(version) ?? []).includes("native host")) mark(version, "native host");
  }
  return used;
}

async function withInstallLock<T>(ports: VersionsPorts, run: () => Promise<T>): Promise<T | VersionsResult> {
  const lock = await pollUntil(ports.clock, INSTALL_LOCK_MS, 100, async () => {
    const attempt = await ports.lock.acquire("install");
    return attempt.ok ? attempt : null;
  });
  if (lock === null) return { code: 75, message: "another desk install is running; run it again once it is done" };
  try {
    return await run();
  } finally {
    await lock.release();
  }
}

async function readInstalled(ports: VersionsPorts, deskHome: string): Promise<Installed | null> {
  return parseInstalled((await ports.files.read(`${deskHome}/installed.json`)) ?? "");
}

/** `desk versions` (§23.5): each installed version, newest first, with its channel, provenance and install date. */
export async function listVersions(ports: VersionsPorts, input: { deskHome: string }): Promise<{ code: 0 | 65; message: string }> {
  const installed = await readInstalled(ports, input.deskHome);
  if (installed === null) return { code: 65, message: `${input.deskHome}/installed.json is missing or damaged` };
  const used = (await versionsInUse(ports, input.deskHome)) ?? new Map<string, string[]>();
  const names = [...(await ports.versions.list())].sort((a, b) => compareVersions(b, a));
  const lines = names.map((version) => {
    const recorded = installed.versions[version];
    const marks = [
      ...(version === installed.current ? ["current"] : []),
      ...(version === installed.previous ? ["previous"] : []),
      ...(used.get(version) ?? []),
    ];
    const facts = [version, recorded?.channel ?? "?", recorded?.provenance ?? "?", recorded?.installedAt.slice(0, 10) ?? "?"];
    return [...facts, ...(marks.length > 0 ? [marks.join(", ")] : [])].join("  ");
  });
  return { code: 0, message: lines.join("\n") };
}

/**
 * `desk use <version>` (§23.5 rules 3–7): after you confirm (a downgrade is named as one), `current` changes with one
 * rename and installed.json records `previous`, keeping keys it does not know. A version whose `compat.state` is older
 * than a state file on disk is refused before anything is asked: it would move that file aside. Then retention.
 */
export async function useVersion(ports: VersionsPorts, input: { deskHome: string; version: string }): Promise<VersionsResult> {
  const outcome = await withInstallLock(ports, async (): Promise<VersionsResult> => {
    const installed = await readInstalled(ports, input.deskHome);
    if (installed === null) return { code: 65, message: `${input.deskHome}/installed.json is missing or damaged` };
    if (!(await ports.versions.list()).includes(input.version)) return { code: 65, message: `Desk ${input.version} is not installed; desk versions lists what is` };
    const current = await ports.versions.current();
    if (current === input.version) return { code: 0, message: `${input.version} is already current` };
    const info = parseVersionInfo((await ports.files.read(`${input.deskHome}/app/${input.version}/version.json`)) ?? "");
    if (info === null || !(await ports.versions.verify(input.version))) {
      return { code: 65, message: `Desk ${input.version}'s files no longer match its files.sha256; install it again` };
    }
    const reads = (info.compat as { state?: Record<string, unknown> } | null)?.state ?? {};
    for (const name of STATE_FILES) {
      const path = `${input.deskHome}/${name}.json`;
      const text = await ports.files.read(path);
      if (text === null) continue;
      let onDisk: unknown;
      try {
        onDisk = (JSON.parse(text) as { version?: unknown }).version;
      } catch {
        continue;
      }
      const readable = reads[name];
      if (typeof onDisk === "number" && typeof readable === "number" && onDisk > readable) {
        return { code: 65, message: `Desk ${input.version} reads ${name}.json version ${readable}, but ${path} is version ${onDisk}: it would move it aside` };
      }
    }
    const downgrade = current !== null && compareVersions(input.version, current) < 0;
    const consent = await ports.prompter.confirm(
      `${downgrade ? "This is a downgrade. " : ""}Make Desk ${input.version} the current version${current === null ? "" : ` instead of ${current}`}? Running shells and tmux sessions keep running; the next desk loads it.`,
    );
    if (!consent.ok) return { code: 64, message: "desk use needs an interactive terminal to ask you; nothing changed" };
    if (!consent.yes) return { code: 77, message: `${current ?? "The current version"} stays current: you declined` };
    await ports.versions.use(input.version);
    await ports.files.write(`${input.deskHome}/installed.json`, serializeInstalled({ ...installed, current: input.version, previous: current }), 0o600);
    await retainUnderLock(ports, input.deskHome);
    return { code: 0, message: `${input.version} is current; run desk` };
  });
  return outcome;
}

/** `desk rollback` (§23.5): `desk use <previous>`. */
export async function rollbackVersion(ports: VersionsPorts, input: { deskHome: string }): Promise<VersionsResult> {
  const previous = (await readInstalled(ports, input.deskHome))?.previous ?? null;
  if (previous === null) return { code: 65, message: "There is no previous version to roll back to" };
  return useVersion(ports, { deskHome: input.deskHome, version: previous });
}

/**
 * Retention (§23.5 rule 7), under `run/install.lock`: `current`, `previous`, and the most recently installed other
 * version stay, and so does every version a running Desk process uses; when the processes cannot be listed, nothing is
 * removed. installed.json forgets what was removed.
 */
export async function retainVersions(ports: VersionsPorts, input: { deskHome: string }): Promise<void> {
  await withInstallLock(ports, () => retainUnderLock(ports, input.deskHome));
}

async function retainUnderLock(ports: VersionsPorts, deskHome: string): Promise<void> {
  const installed = await readInstalled(ports, deskHome);
  if (installed === null) return;
  const used = await versionsInUse(ports, deskHome);
  if (used === null) return;
  const current = await ports.versions.current();
  const keep = new Set([current, installed.current, installed.previous].filter((version): version is string => version !== null));
  const others = (await ports.versions.list())
    .filter((version) => !keep.has(version))
    .sort((a, b) => (installed.versions[b]?.installedAt ?? "").localeCompare(installed.versions[a]?.installedAt ?? ""));
  const newest = others[0];
  if (newest !== undefined) keep.add(newest);
  const versions = { ...installed.versions };
  for (const version of others) {
    if (keep.has(version) || used.has(version)) continue;
    await ports.versions.remove(version);
    delete versions[version];
  }
  await ports.files.write(`${deskHome}/installed.json`, serializeInstalled({ ...installed, versions }), 0o600);
}
