import { describe, expect, it } from "vitest";
import {
  NATIVE_HOST_NAME,
  TMUX_DESK_LINE,
  agentBrowserConfig,
  agentPolicy,
  deskLauncher,
  doctor,
  hostLauncher,
  nativeHostManifest,
  newDeskConfig,
  type DoctorFinding,
  type VersionInfo,
} from "../src/index.ts";
import {
  FakeChromeProcess,
  FakeChromeProfile,
  FakeDaemonClient,
  FakeDevToolsHttp,
  FakeInstanceLock,
  FakeListenerInfo,
  FakeLoginShell,
  FakePathModes,
  FakeTmux,
  MemoryAppVersions,
  MemoryConfigStore,
  MemoryNativeHostDir,
  MemoryTextFiles,
} from "../src/testing/index.ts";

const home = "/Users/alex";
const deskHome = `${home}/.desk`;
const VERSION = "0.4.0";
const config = newDeskConfig({ home, platform: "darwin", chromePort: 9417, gatewayPort: 9583 });
const info: VersionInfo = { version: VERSION, channel: "stable", branch: null, commit: "a".repeat(40), dirty: false, builtAt: "2026-10-07T00:00:00Z", node: "26.10.0", compat: {} };
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** A healthy Desk: every row passes. */
function setup() {
  const files = new MemoryTextFiles({
    [`${home}/.local/bin/desk`]: deskLauncher({ deskHome, platform: "darwin" }),
    [`${deskHome}/bin/desk-nmhost`]: hostLauncher({ deskHome, platform: "darwin" }),
    [`${deskHome}/agent-browser.json`]: json(agentBrowserConfig({ config, deskHome })),
    [`${deskHome}/agent-policy.json`]: json(agentPolicy("open")),
    [`${home}/.tmux.conf`]: `${TMUX_DESK_LINE}\n`,
  });
  const versions = new MemoryAppVersions();
  versions.installed.push(VERSION);
  versions.builds.set(VERSION, "b".repeat(64));
  versions.currentVersion = VERSION;
  const chrome = new FakeChromeProcess("155.0.8059.40");
  const profile = new FakeChromeProfile();
  const hosts = new MemoryNativeHostDir();
  void hosts.write(NATIVE_HOST_NAME, nativeHostManifest(deskHome));
  const lock = new FakeInstanceLock();
  lock.holders.set("watch", { pid: 6200, build: VERSION });
  const shell = new FakeLoginShell("/bin/zsh");
  shell.commands.set("desk", `${home}/.local/bin/desk`);
  const daemon = new FakeDaemonClient();
  const ports = {
    config: new MemoryConfigStore(config),
    files,
    modes: new FakePathModes(),
    versions,
    chromeFor: () => ({ chrome, profile, hosts }),
    devTools: new FakeDevToolsHttp(),
    listeners: new FakeListenerInfo(),
    lock,
    daemon,
    tmux: new FakeTmux({ running: false }),
    shell,
  };
  const run = (fix = false, change: Partial<VersionInfo> = {}) => doctor(ports, { home, deskHome, platform: "darwin", info: { ...info, ...change }, fix });
  return { ...ports, chrome, profile, hosts, run };
}

type Desk = ReturnType<typeof setup>;
const problems = (findings: DoctorFinding[]) => findings.filter((f) => f.level === "problem" || f.level === "warning");

describe("desk doctor (docs/IMPLEMENTATION.md §15.2)", () => {
  it("doctor finds nothing wrong with a healthy Desk and exits 0", async () => {
    const result = await setup().run();

    expect(problems(result.findings)).toEqual([]);
    expect(result.code).toBe(0);
  });

  it.each<[string, (desk: Desk) => Promise<void> | void, string, string]>([
    ["Chrome older than 155", (desk) => void (desk.chrome.installed = "154.0.1.2"), "chrome", "update Chrome"],
    ["Chrome missing", (desk) => void (desk.chrome.installed = null), "chrome", "install Google Chrome"],
    ["no current version", (desk) => void (desk.versions.currentVersion = null), "current", "desk install --from"],
    ["a current version whose files changed", (desk) => void desk.versions.damaged.add(VERSION), "current", "install it again"],
    ["a missing desk launcher", (desk) => desk.files.remove(`${home}/.local/bin/desk`), "launchers", "desk install --from"],
    ["a changed host launcher", (desk) => desk.files.write(`${deskHome}/bin/desk-nmhost`, "#!/bin/sh\n", 0o700), "launchers", "desk doctor --fix"],
    ["desk missing from a login shell's PATH", (desk) => void desk.shell.commands.clear(), "path", ".local/bin first on your PATH"],
    ["a changed host manifest", (desk) => desk.hosts.write(NATIVE_HOST_NAME, "{}"), "host-manifest", "desk doctor --fix"],
    ["an agent config with a forbidden key", (desk) => desk.files.write(`${deskHome}/agent-browser.json`, json({ restore: "main" }), 0o600), "agent-config", "desk doctor --fix"],
    ["a missing agent policy", (desk) => desk.files.remove(`${deskHome}/agent-policy.json`), "agent-policy", "desk doctor --fix"],
    ["a daemon on a version without a common protocol", (desk) => void (desk.daemon.stale = true), "daemon", "Restart now"],
    ["no desk watch", (desk) => void desk.lock.holders.delete("watch"), "watch", "run desk"],
    ["a desk watch older than current", (desk) => void desk.lock.holders.set("watch", { pid: 6200, build: "0.3.0" }), "watch", "replaces it"],
    ["~/.desk open to others", (desk) => void desk.modes.paths.set(deskHome, { kind: "dir", mode: 0o755, mine: true }), "modes", "chmod 700"],
    ["run/ as a symlink", (desk) => void desk.modes.paths.set(`${deskHome}/run`, { kind: "link", mode: 0o777, mine: true }), "modes", "not a link"],
    ["the Desk profile inside iCloud Drive", (desk) => desk.config.save({ ...config, chrome: { ...config.chrome, userDataDir: `${home}/Library/Mobile Documents/Desk/Chrome` } }), "cloud", "out of the synced folder"],
    ["no tmux line", (desk) => desk.files.remove(`${home}/.tmux.conf`), "tmux", "desk install --from"],
    ["a login shell exporting AGENT_BROWSER_CDP", (desk) => void (desk.shell.names = ["HOME", "AGENT_BROWSER_CDP"]), "login-shell", "unset"],
    ["a login shell exporting ANTHROPIC_API_KEY", (desk) => void (desk.shell.names = ["HOME", "ANTHROPIC_API_KEY"]), "login-shell", "unset"],
    ["a -desk- file in ~/.agent-browser/sessions", (desk) => desk.files.write(`${home}/.agent-browser/sessions/state-desk-p_1.json`, "{}", 0o600), "agent-state", "delete them"],
    ["background mode on", (desk) => void (desk.profile.localState = { background_mode: { enabled: true } }), "background-mode", "background apps"],
    ["another program on the Desk port", (desk) => void (desk.devTools.answering = true), "desk-port", "quit it"],
  ])("doctor reports %s and names its fix", async (_problem, change, check, fix) => {
    const desk = setup();
    await change(desk);

    const result = await desk.run();
    const finding = problems(result.findings).find((f) => f.check === check);

    expect(finding?.fix).toContain(fix);
  });

  it.each([
    ["a dev build", { channel: "dev" as const }],
    ["a dirty build", { dirty: true }],
    ["an edge build", { channel: "edge" as const }],
  ])("doctor warns that %s is code nobody released", async (_kind, change) => {
    const result = await setup().run(false, change);

    expect(result.findings).toContainEqual(expect.objectContaining({ check: "build", level: "warning" }));
    expect(result.code).toBe(0);
  });

  it("doctor says to run checklist U when Chrome's major version changed since its last run", async () => {
    const desk = setup();
    await desk.run();
    desk.chrome.installed = "156.0.1.2";

    const result = await desk.run();

    expect(result.findings).toContainEqual(expect.objectContaining({ check: "chrome", level: "warning", fix: expect.stringContaining("checklist U") }));
  });

  it("doctor --fix rewrites the agent config, the policy and the host manifest and never stops the daemon", async () => {
    const desk = setup();
    await desk.files.write(`${deskHome}/agent-browser.json`, json({ restore: "main" }), 0o600);
    await desk.files.remove(`${deskHome}/agent-policy.json`);
    await desk.hosts.write(NATIVE_HOST_NAME, "{}");

    const result = await desk.run(true);

    expect(await desk.files.read(`${deskHome}/agent-browser.json`)).toBe(json(agentBrowserConfig({ config, deskHome })));
    expect(await desk.files.read(`${deskHome}/agent-policy.json`)).toBe(json(agentPolicy("open")));
    expect(await desk.hosts.read(NATIVE_HOST_NAME)).toBe(nativeHostManifest(deskHome));
    expect(result.findings.filter((f) => f.level === "fixed").map((f) => f.check).sort()).toEqual(["agent-config", "agent-policy", "host-manifest"]);
    expect(desk.daemon.notices).toEqual([]);
    expect(result.code).toBe(0);
  });

  it("doctor lists the names a login shell exports and never their values", async () => {
    const desk = setup();
    desk.shell.names = ["HOME", "AGENT_BROWSER_NAMESPACE", "ANTHROPIC_API_KEY"];

    const result = await desk.run();
    const text = JSON.stringify(result.findings);

    expect(text).toContain("AGENT_BROWSER_NAMESPACE");
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).not.toMatch(/=/);
  });
});
