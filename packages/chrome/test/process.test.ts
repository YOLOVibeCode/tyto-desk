import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HttpDevTools, NodeChromeProcess, NodeChromeProfile, NodeNativeHostDir, chromeStartCommand } from "../src/index.ts";
import { fakeExecutable } from "../../../test/fixtures/fake-exec.ts";

const APP = "/Applications/Google Chrome.app";

describe("the installed Chrome", () => {
  it("on macOS Desk starts Chrome through LaunchServices: open -n -a <app> --args and Desk's arguments", () => {
    expect(chromeStartCommand("darwin", APP, ["--remote-debugging-port=9417", "--no-first-run"])).toEqual({
      file: "/usr/bin/open",
      args: ["-n", "-a", APP, "--args", "--remote-debugging-port=9417", "--no-first-run"],
    });
  });

  it("on Linux Desk runs the Chrome binary itself with Desk's arguments", () => {
    expect(chromeStartCommand("linux", "/usr/bin/google-chrome-stable", ["--no-first-run"])).toEqual({
      file: "/usr/bin/google-chrome-stable",
      args: ["--no-first-run"],
    });
  });

  it("ChromeProcess refuses to read the version of a Chrome inside the real home under Vitest", async () => {
    const realHome = process.env.DESK_TEST_REAL_HOME ?? userInfo().homedir;
    const chrome = new NodeChromeProcess({ app: join(realHome, "Applications", "Google Chrome.app"), platform: "darwin", env: process.env });

    await expect(chrome.version()).rejects.toThrow(/real home directory/);
  });

  it("ChromeProcess refuses to start Chrome under Vitest, before it runs anything", async () => {
    const chrome = await fakeExecutable("google-chrome-stable", []);

    const started = await new NodeChromeProcess({ app: chrome.path, platform: "linux", env: process.env }).start(["--no-first-run"]);

    expect(started).toEqual({ ok: false, reason: "gui-refused" });
    expect(await chrome.calls()).toEqual([]);
  });

  it("ChromeProcess reads the version of a Linux Chrome from its --version", async () => {
    const chrome = await fakeExecutable("google-chrome-stable", [{ match: ["--version"], stdout: "Google Chrome 155.0.8059.39 \n" }]);

    expect(await new NodeChromeProcess({ app: chrome.path, platform: "linux", env: {} }).version()).toBe("155.0.8059.39");
  });

  it("ChromeProcess reads the version of a macOS Chrome from its bundle's Info.plist", async () => {
    const app = join(await mkdtemp(join(tmpdir(), "chrome-app-")), "Google Chrome.app");
    await mkdir(join(app, "Contents"), { recursive: true });
    await writeFile(
      join(app, "Contents", "Info.plist"),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n\t<key>CFBundleName</key>\n\t<string>Chrome</string>\n\t<key>CFBundleShortVersionString</key>\n\t<string>155.0.8059.40</string>\n</dict></plist>\n',
    );

    expect(await new NodeChromeProcess({ app, platform: "darwin", env: {} }).version()).toBe("155.0.8059.40");
  });

  it("ChromeProcess reports no version when Chrome is not installed", async () => {
    expect(await new NodeChromeProcess({ app: "/nonexistent/Google Chrome.app", platform: "darwin", env: {} }).version()).toBeNull();
    expect(await new NodeChromeProcess({ app: "/nonexistent/chrome", platform: "linux", env: {} }).version()).toBeNull();
  });
});

describe("the Desk profile", () => {
  it("ChromeProfile reads SingletonLock's host and pid", async () => {
    const profile = await mkdtemp(join(tmpdir(), "profile-"));
    await symlink("alex-mbp.local-4242", join(profile, "SingletonLock"));

    expect(await new NodeChromeProfile(profile).singleton()).toEqual({ host: "alex-mbp.local", pid: 4242 });
  });

  it("ChromeProfile reports no singleton without a lock, or with one it cannot read", async () => {
    const profile = await mkdtemp(join(tmpdir(), "profile-"));
    expect(await new NodeChromeProfile(profile).singleton()).toBeNull();

    await symlink("garbage", join(profile, "SingletonLock"));
    expect(await new NodeChromeProfile(profile).singleton()).toBeNull();
  });

  it("the first-run seed writes Default/Preferences as a 0600 file, once", async () => {
    const profile = join(await mkdtemp(join(tmpdir(), "profile-")), "Chrome");
    const seed = { side_panel: { is_right_aligned: false, id_to_width: { kExtension: 640 } } };

    expect(await new NodeChromeProfile(profile).seedFirstRun(seed)).toBe(true);
    expect(await new NodeChromeProfile(profile).seedFirstRun({ other: true })).toBe(false);
    expect(JSON.parse(await readFile(join(profile, "Default", "Preferences"), "utf8"))).toEqual(seed);
    expect((await stat(join(profile, "Default", "Preferences"))).mode & 0o777).toBe(0o600);
  });

  it("NativeHostDir writes a 0600 manifest into the profile's NativeMessagingHosts and reads it back", async () => {
    const profile = await mkdtemp(join(tmpdir(), "profile-"));
    const hosts = new NodeNativeHostDir(profile);

    await hosts.write("com.noctusoft.desk", '{"name":"com.noctusoft.desk"}\n');

    expect(await hosts.read("com.noctusoft.desk")).toBe('{"name":"com.noctusoft.desk"}\n');
    expect((await stat(join(profile, "NativeMessagingHosts", "com.noctusoft.desk.json"))).mode & 0o777).toBe(0o600);
    expect(await hosts.read("com.example.other")).toBeNull();
    await expect(hosts.write("../escape", "{}")).rejects.toThrow(/host name/);
  });
});

describe("the DevTools HTTP endpoint", () => {
  it("DevToolsHttp reads the browser and its WebSocket from /json/version", async () => {
    let wsUrl = "";
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Chrome/155.0.8059.40", webSocketDebuggerUrl: wsUrl, path: req.url }));
    });
    await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
    const { port } = server.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${port}/devtools/browser/0f1e2d3c`;

    const version = await new HttpDevTools().version(port);
    server.close();

    expect(version).toEqual({ browser: "Chrome/155.0.8059.40", wsUrl });
  });

  it.each([
    ["on another port", (port: number) => `ws://127.0.0.1:${port + 1}/devtools/browser/0f1e2d3c`],
    ["on another host", (port: number) => `ws://10.0.0.5:${port}/devtools/browser/0f1e2d3c`],
    ["for a page rather than the browser", (port: number) => `ws://127.0.0.1:${port}/devtools/page/0f1e2d3c`],
    ["over TLS", (port: number) => `wss://127.0.0.1:${port}/devtools/browser/0f1e2d3c`],
  ])("DevToolsHttp refuses a browser WebSocket URL %s, not the endpoint it asked", async (_label, wsUrlFor) => {
    let wsUrl = "";
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Chrome/155.0.8059.40", webSocketDebuggerUrl: wsUrl }));
    });
    await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
    const { port } = server.address() as AddressInfo;
    wsUrl = wsUrlFor(port);

    const version = await new HttpDevTools().version(port);
    server.close();

    expect(version).toBeNull();
  });

  it("DevToolsHttp reports nothing when nothing answers", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(await new HttpDevTools().version(port)).toBeNull();
  });

  it("DevToolsHttp refuses Desk's ports under Vitest", async () => {
    await expect(new HttpDevTools().version(9417)).rejects.toThrow(/reserved port 9417/);
  });
});
