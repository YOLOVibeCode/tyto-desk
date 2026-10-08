import { AGENT_BROWSER_CONFIG_FILE, AGENT_POLICY_FILE, FORBIDDEN_AGENT_BROWSER_KEYS, agentBrowserConfig, agentPolicy } from "../agents/agent-browser.ts";
import { policyModeOf } from "../agents/controls.ts";
import type { DeskConfig } from "../config/schema.ts";
import { NATIVE_HOST_NAME } from "../extension/desk-extension.ts";
import { nativeHostLauncher, nativeHostManifest } from "../extension/native-host.ts";
import { isManagedFile } from "../install/extras.ts";
import { parseInstalled } from "../install/installed.ts";
import { deskLauncher, hostLauncher } from "../install/launchers.ts";
import { listenerIsDesk } from "../launch/classify.ts";
import type { AppVersions } from "../ports/app-versions.ts";
import type { ChromeProcess } from "../ports/chrome-process.ts";
import type { ChromeProfile } from "../ports/chrome-profile.ts";
import type { ConfigStore } from "../ports/config-store.ts";
import type { DaemonClient } from "../ports/daemon-client.ts";
import type { DevToolsHttp } from "../ports/dev-tools-http.ts";
import type { InstanceLock } from "../ports/instance-lock.ts";
import type { ListenerInfo } from "../ports/listener-info.ts";
import type { GhVersion } from "../ports/gh-version.ts";
import type { AutofillVerdict, SecurityProbe } from "../ports/security-probe.ts";
import type { LoginShell } from "../ports/login-shell.ts";
import type { NativeHostDir } from "../ports/native-host-dir.ts";
import type { PathModes } from "../ports/path-modes.ts";
import type { TextFiles } from "../ports/text-files.ts";
import type { Tmux } from "../ports/tmux.ts";
import { agentGate } from "../pty/agent-env.ts";
import type { VersionInfo } from "../version/version-info.ts";

/** One row of `desk doctor` (docs/IMPLEMENTATION.md §15.2): every problem names its fix. */
export type DoctorFinding = { check: string; level: "ok" | "warning" | "problem" | "fixed"; message: string; fix?: string };

export type DoctorPorts = {
  config: ConfigStore;
  files: TextFiles;
  modes: PathModes;
  versions: AppVersions;
  /** The Desk Chrome's process, profile and host directory, which the config names. */
  chromeFor(config: DeskConfig): { chrome: ChromeProcess; profile: ChromeProfile; hosts: NativeHostDir };
  devTools: DevToolsHttp;
  listeners: ListenerInfo;
  lock: InstanceLock;
  daemon: DaemonClient;
  tmux: Tmux | null;
  shell: LoginShell;
  gh: GhVersion;
  /** The main Chrome's profile (its `Local State`, read only) and its native-host manifests (§14, §15.2). */
  main: { profile: ChromeProfile; hosts: NativeHostDir };
  security: SecurityProbe;
};

export type DoctorInput = {
  home: string;
  deskHome: string;
  platform: string;
  /** The version doctor runs as, from its version.json. */
  info: VersionInfo;
  /** `--fix`: rewrite what lives in `~/.desk` and the Desk host manifest. */
  fix: boolean;
  /** `--autofill-probe`: ask Chrome to fill a throwaway password and see whether it wants your screen lock first (M17). */
  autofillProbe?: boolean;
};

const PRIVATE = 0o600;
const CLOUD_FOLDERS = ["Library/Mobile Documents", "Library/CloudStorage", "Dropbox", "Google Drive", "OneDrive"];
/** Agent variables a login shell must not export: Desk's own are set only in its panes. */
const DESK_AGENT_VARIABLES = new Set(["AGENT_BROWSER_CONFIG", "AGENT_BROWSER_SESSION"]);

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function major(version: string): number | null {
  const match = /^(\d+)\./.exec(version);
  return match === null ? null : Number(match[1]);
}

/**
 * `desk doctor [--fix]` (docs/IMPLEMENTATION.md §15.2, slice 5b): each row checks one thing and names its fix. `--fix`
 * rewrites only what lives in `~/.desk` (the agent config, a missing policy, the host launcher) and the Desk native-host
 * manifest; it never stops the daemon. Doctor never goes online. `code` is 1 while a problem remains.
 */
export async function doctor(ports: DoctorPorts, input: DoctorInput): Promise<{ code: 0 | 1; findings: DoctorFinding[] }> {
  const findings: DoctorFinding[] = [];
  const add = (finding: DoctorFinding) => findings.push(finding);
  const home = input.home.replace(/\/+$/, "");
  const deskHome = input.deskHome.replace(/\/+$/, "");

  const config = await ports.config.load().catch(() => null);
  if (config === null) {
    add({ check: "config", level: "problem", message: `${deskHome}/config.json is missing or damaged`, fix: "run desk, which makes one" });
    return { code: 1, findings };
  }
  add({ check: "config", level: "ok", message: `ports ${config.chrome.port} (Chrome) and ${config.gateway.port} (guarded)` });
  const { chrome: installedChrome, profile, hosts } = ports.chromeFor(config);

  // Chrome, and whether its major version changed since the last doctor (then the manual checklist U applies).
  const chromeVersion = await installedChrome.version();
  const chromeMajor = chromeVersion === null ? null : major(chromeVersion);
  if (chromeVersion === null || chromeMajor === null) {
    add({ check: "chrome", level: "problem", message: `Google Chrome is not installed at ${config.chrome.app}`, fix: "install Google Chrome" });
  } else if (chromeMajor < config.chrome.minMajor) {
    add({ check: "chrome", level: "problem", message: `Google Chrome ${chromeVersion} is older than ${config.chrome.minMajor}`, fix: "update Chrome" });
  } else {
    let last: unknown = null;
    try {
      last = (JSON.parse((await ports.files.read(`${deskHome}/doctor.json`)) ?? "{}") as { chromeMajor?: unknown }).chromeMajor;
    } catch {
      last = null;
    }
    if (typeof last === "number" && last !== chromeMajor) {
      add({ check: "chrome", level: "warning", message: `Chrome went from ${last} to ${chromeMajor}`, fix: "run checklist U (docs/MANUAL-CHECKS.md)" });
    } else {
      add({ check: "chrome", level: "ok", message: `Google Chrome ${chromeVersion}` });
    }
    await ports.files.write(`${deskHome}/doctor.json`, json({ chromeMajor }), PRIVATE);
  }

  // The installed version: current, its files, and what kind of build it is.
  const current = await ports.versions.current();
  if (current === null) {
    add({ check: "current", level: "problem", message: "no installed version is current", fix: "run desk install --from <dir>" });
  } else if (!(await ports.versions.verify(current))) {
    add({ check: "current", level: "problem", message: `${current}'s files no longer match its files.sha256`, fix: "install it again: desk install --from <dir>" });
  } else {
    add({ check: "current", level: "ok", message: `${current}, its files match files.sha256` });
  }
  if (input.info.channel === "dev" || input.info.channel === "edge" || input.info.dirty) {
    const what = input.info.dirty ? "a dirty dev build" : input.info.channel === "edge" ? "an edge build" : "a dev build";
    add({ check: "build", level: "warning", message: `${input.info.version} is ${what}: code nobody released`, fix: "desk update --channel stable" });
  }

  // The launchers, and desk on a login shell's PATH.
  const launchers = { deskHome, platform: input.platform };
  const deskPath = `${home}/.local/bin/desk`;
  if ((await ports.files.read(deskPath)) !== deskLauncher(launchers)) {
    add({ check: "launchers", level: "problem", message: `${deskPath} is missing or is not Desk's launcher`, fix: "run desk install --from <dir> again" });
  } else if ((await ports.files.read(nativeHostLauncher(deskHome))) !== hostLauncher(launchers)) {
    if (input.fix) {
      await ports.files.write(nativeHostLauncher(deskHome), hostLauncher(launchers), 0o700);
      add({ check: "launchers", level: "fixed", message: `rewrote ${nativeHostLauncher(deskHome)}` });
    } else {
      add({ check: "launchers", level: "problem", message: `${nativeHostLauncher(deskHome)} is not Desk's host launcher`, fix: "desk doctor --fix" });
    }
  } else {
    add({ check: "launchers", level: "ok", message: "both launchers resolve current" });
  }
  const found = await ports.shell.which("desk");
  if (found !== deskPath) {
    add({ check: "path", level: "warning", message: found === null ? "a login shell does not find desk" : `a login shell finds desk at ${found}`, fix: `put ${home}/.local/bin first on your PATH` });
  }

  // The Desk native-host manifest.
  const manifest = nativeHostManifest(deskHome);
  if ((await hosts.read(NATIVE_HOST_NAME)) !== manifest) {
    if (input.fix) {
      await hosts.write(NATIVE_HOST_NAME, manifest);
      add({ check: "host-manifest", level: "fixed", message: "rewrote the Desk native-host manifest" });
    } else {
      add({ check: "host-manifest", level: "problem", message: "the Desk native-host manifest is missing or changed", fix: "desk doctor --fix" });
    }
  } else {
    add({ check: "host-manifest", level: "ok", message: "exact" });
  }

  // The agent config and policy.
  const agentPath = `${deskHome}/${AGENT_BROWSER_CONFIG_FILE}`;
  const expected = json(agentBrowserConfig({ config, deskHome }));
  const agentText = await ports.files.read(agentPath);
  if (agentText !== expected) {
    let forbidden: string[] = [];
    try {
      forbidden = Object.keys(JSON.parse(agentText ?? "{}") as object).filter((key) => FORBIDDEN_AGENT_BROWSER_KEYS.includes(key));
    } catch {
      forbidden = [];
    }
    if (input.fix) {
      await ports.files.write(agentPath, expected, PRIVATE);
      add({ check: "agent-config", level: "fixed", message: `rewrote ${agentPath}` });
    } else {
      const why = forbidden.length > 0 ? `has ${forbidden.join(", ")}` : "is missing or changed";
      add({ check: "agent-config", level: "problem", message: `${agentPath} ${why}`, fix: "desk doctor --fix" });
    }
  } else {
    add({ check: "agent-config", level: "ok", message: "exact" });
  }
  const policyPath = `${deskHome}/${AGENT_POLICY_FILE}`;
  const policyText = await ports.files.read(policyPath);
  const mode = policyText === null ? null : policyModeOf(policyText);
  if (policyText === null) {
    if (input.fix) {
      await ports.files.write(policyPath, json(agentPolicy("open")), PRIVATE);
      add({ check: "agent-policy", level: "fixed", message: "wrote the open policy" });
    } else {
      add({ check: "agent-policy", level: "problem", message: "agent-policy.json is missing: a new agent session would have no policy", fix: "desk doctor --fix" });
    }
  } else {
    add({ check: "agent-policy", level: mode === null ? "warning" : "ok", message: mode === null ? "a policy Desk did not write" : `the ${mode} policy` });
  }

  // The Desk port's listener, the daemon, and desk watch.
  const answering = await ports.devTools.version(config.chrome.port);
  if (answering === null) {
    add({ check: "desk-port", level: "ok", message: `the Desk Chrome is not running (port ${config.chrome.port} is closed)` });
  } else {
    const lock = await profile.singleton();
    const listenerPid = await ports.listeners.listenerPid(config.chrome.port);
    const image = listenerPid === null ? null : await ports.listeners.image(listenerPid);
    const appRoot = input.platform === "darwin" ? config.chrome.app : config.chrome.app.replace(/\/[^/]*$/, "");
    const whose = lock === null ? "other" : listenerIsDesk({ singletonPid: lock.pid, listenerPid, image, appRoot, userDataDir: config.chrome.userDataDir });
    add(
      whose === "desk"
        ? { check: "desk-port", level: "ok", message: `the Desk Chrome listens on ${config.chrome.port}` }
        : { check: "desk-port", level: "problem", message: `another program answers on port ${config.chrome.port}`, fix: "quit it, or run desk, which moves the Desk Chrome to a free port" },
    );
  }
  const opened = await ports.daemon.open("cli");
  if (opened.ok) {
    opened.session.close();
    add({ check: "daemon", level: "ok", message: "the terminal daemon is running" });
  } else if (opened.reason === "stale") {
    add({ check: "daemon", level: "problem", message: "the terminal daemon speaks no protocol version this one does", fix: "Restart now in the panel, or desk daemon restart" });
  } else {
    add({ check: "daemon", level: "ok", message: "the terminal daemon is not running (the panel starts it)" });
  }
  const watch = await ports.lock.holder("watch");
  if (watch === null) add({ check: "watch", level: "warning", message: "desk watch is not running: agents cannot reach the guarded endpoint", fix: "run desk" });
  else if (watch.build !== input.info.version) add({ check: "watch", level: "warning", message: `desk watch runs ${watch.build ?? "an unknown version"}, not ${input.info.version}`, fix: "run desk, which replaces it" });
  else add({ check: "watch", level: "ok", message: "desk watch runs this version" });

  // ~/.desk itself: owner, modes, no symlinks, and not in a synced folder.
  for (const dir of [deskHome, `${deskHome}/run`]) {
    const facts = await ports.modes.stat(dir);
    if (facts !== null && (facts.kind !== "dir" || !facts.mine || (facts.mode & 0o077) !== 0)) {
      add({ check: "modes", level: "problem", message: `${dir} is ${facts.kind === "dir" ? "open to others or not yours" : `a ${facts.kind}`}`, fix: `chmod 700 ${dir}, owned by you, not a link` });
    }
  }
  for (const [what, path] of [["~/.desk", deskHome], ["the Desk profile", config.chrome.userDataDir]] as const) {
    const folder = CLOUD_FOLDERS.find((name) => path.startsWith(`${home}/${name}/`));
    if (folder !== undefined) add({ check: "cloud", level: "problem", message: `${what} is inside ${folder}, which syncs it`, fix: "move it out of the synced folder" });
  }

  // tmux, a login shell's exported names, and saved agent state.
  const gate = await agentGate({ tmux: ports.tmux, files: ports.files, home });
  if (!gate.allowed) add({ check: "tmux", level: "warning", message: "the tmux line is missing from ~/.tmux.conf or the running server", fix: "run desk install --from <dir> again" });
  const names = await ports.shell.exportedNames();
  if (names !== null) {
    const agentNames = names.filter((name) => name.startsWith("AGENT_BROWSER_") && !DESK_AGENT_VARIABLES.has(name));
    if (agentNames.length > 0) add({ check: "login-shell", level: "warning", message: `your login shell exports ${agentNames.join(", ")}`, fix: "unset them where your shell sets them" });
    if (names.includes("ANTHROPIC_API_KEY")) add({ check: "login-shell", level: "warning", message: "your login shell exports ANTHROPIC_API_KEY, which turns Claude Code to API billing", fix: "unset it where your shell sets it" });
  }
  // gh, which desk update needs: installed and new enough (signing in is checked online, by desk update).
  const gh = await ports.gh.installed();
  if (!gh.ok) {
    add(
      gh.reason === "missing"
        ? { check: "gh", level: "warning", message: "gh is not installed, so desk update cannot check where a release came from", fix: "brew install gh, then gh auth login" }
        : { check: "gh", level: "warning", message: "gh is older than 2.102.0, whose attestation checks desk update cannot rely on", fix: "brew upgrade gh" },
    );
  }
  const saved = (await ports.files.names(`${home}/.agent-browser/sessions`)).filter((name) => name.includes("-desk-"));
  if (saved.length > 0) add({ check: "agent-state", level: "problem", message: `~/.agent-browser/sessions holds ${saved.length} file(s) a Desk agent session saved`, fix: "look at them and delete them" });

  // Chrome's own settings Desk relies on.
  if ((await profile.localStatePref("background_mode.enabled")) === true) {
    add({ check: "background-mode", level: "warning", message: "Chrome keeps running in the background after its last window", fix: "turn off Continue running background apps in the Desk Chrome's settings" });
  }

  // The main Chrome (§14): its remote debugging left on, and host manifests desk import copied from it.
  if ((await ports.main.profile.localStatePref("devtools.remote_debugging.user-enabled")) === true) {
    add({
      check: "main-remote-debugging",
      level: "warning",
      message: "your main Chrome's remote debugging is on: any program can ask to control it",
      fix: "turn it off at chrome://inspect/#remote-debugging",
    });
  }
  const installedText = await ports.files.read(`${deskHome}/installed.json`);
  for (const entry of (parseInstalled(installedText ?? "")?.files ?? []).filter(isManagedFile)) {
    if (entry.kind !== "native-host") continue;
    const copy = await hosts.read(entry.name);
    const vendor = await ports.main.hosts.read(entry.name);
    if (copy !== null && vendor === copy) continue;
    add({ check: "native-host-copy", level: "warning", ...copiedHostProblem(entry.name, copy, vendor) });
  }

  if (input.autofillProbe === true) add(autofillFinding(await ports.security.autofill()));

  return { code: findings.some((finding) => finding.level === "problem") ? 1 : 0, findings };
}

/** What is wrong with a host manifest desk import copied (§14), and its fix. */
function copiedHostProblem(name: string, copy: string | null, vendor: string | null): { message: string; fix: string } {
  if (vendor === null) return { message: `${name} is gone from your main Chrome, but Desk still has its copy`, fix: "desk uninstall removes it" };
  if (copy === null) return { message: `the copy of ${name} is gone from the Desk profile`, fix: `desk import native-hosts --host ${name}` };
  return { message: `the copy of ${name} no longer matches your main Chrome's`, fix: `desk import native-hosts --host ${name}` };
}

/** The autofill probe's row (M17): Chrome should want your screen lock before it fills a saved password. */
function autofillFinding(verdict: AutofillVerdict): DoctorFinding {
  switch (verdict) {
    case "held-for-screen-lock":
      return { check: "autofill", level: "ok", message: "Chrome asked for your screen lock before filling the probe's password" };
    case "filled-without-screen-lock":
      return {
        check: "autofill",
        level: "warning",
        message: "Chrome filled a saved password without asking for your screen lock, in a browser local programs can drive",
        fix: "turn on Use your screen lock when filling passwords in the Desk Chrome's Password Manager settings, or keep passwords in 1Password",
      };
    case "not-saved":
      return { check: "autofill", level: "warning", message: "no password was saved on the probe's page, so nothing was tested", fix: "run desk doctor --autofill-probe again and save the throwaway password it shows" };
    case "unavailable":
      return {
        check: "autofill",
        level: "warning",
        message: "the autofill probe could not run, or Chrome offered no saved password to fill",
        fix: "start Desk with desk, run desk doctor --autofill-probe in a terminal, and stay on the probe's tab",
      };
    default: {
      const never: never = verdict;
      throw new Error(`unknown verdict ${String(never)}`);
    }
  }
}

/** One line per finding, problems last, each problem with its fix. */
export function formatDoctor(findings: readonly DoctorFinding[]): string {
  const mark = { ok: "✓", fixed: "✓", warning: "!", problem: "✗" } as const;
  const order = { ok: 0, fixed: 1, warning: 2, problem: 3 } as const;
  return [...findings]
    .sort((a, b) => order[a.level] - order[b.level])
    .map((finding) => `${mark[finding.level]} ${finding.check}: ${finding.message}${finding.fix === undefined ? "" : ` (fix: ${finding.fix})`}`)
    .join("\n");
}
