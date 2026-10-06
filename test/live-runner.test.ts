import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CACHE_VOLUME,
  MAX_DESK_CONTAINERS,
  OWNER_LABEL,
  RESOURCE_LABEL,
  RUNNER_LABEL,
  canStartDeskContainer,
  chromePin,
  depsVolumeName,
  dockerignoreText,
  imageTag,
  leftoverContainers,
  phase1RunArgs,
  phase2RunArgs,
  repoPathAllowed,
  runnerRefusal,
  suiteRefusal,
} from "../scripts/lib/live.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));

const home = "/Users/alex";
const colima = { name: "colima", endpoint: "unix:///Users/alex/.colima/default/docker.sock" };
const vm = { name: "colima", osType: "linux", architecture: "aarch64" };
const onTheMac = { env: {}, home, context: colima, info: vm };

describe("where the live harness runs", () => {
  it.each([
    { label: "the runner on the Mac with Colima running", refusal: () => runnerRefusal(onTheMac), refused: false },
    {
      label: "the runner with Colima under COLIMA_HOME",
      refusal: () =>
        runnerRefusal({
          ...onTheMac,
          env: { COLIMA_HOME: "/Users/alex/vms" },
          context: { name: "colima", endpoint: "unix:///Users/alex/vms/default/docker.sock" },
        }),
      refused: false,
    },
    { label: "the runner without a colima context", refusal: () => runnerRefusal({ ...onTheMac, context: null }), refused: true },
    { label: "the runner while the Colima VM is stopped", refusal: () => runnerRefusal({ ...onTheMac, info: null }), refused: true },
    {
      label: "the runner with a colima context that points at Docker Desktop",
      refusal: () =>
        runnerRefusal({ ...onTheMac, context: { name: "colima", endpoint: "unix:///Users/alex/.docker/run/docker.sock" } }),
      refused: true,
    },
    {
      label: "the runner with a colima context on a TCP endpoint",
      refusal: () => runnerRefusal({ ...onTheMac, context: { name: "colima", endpoint: "tcp://10.0.0.5:2376" } }),
      refused: true,
    },
    {
      label: "the runner with a colima context that climbs out of ~/.colima",
      refusal: () =>
        runnerRefusal({ ...onTheMac, context: { name: "colima", endpoint: "unix:///Users/alex/.colima/../.docker/docker.sock" } }),
      refused: true,
    },
    {
      label: "the runner against a daemon that is not a Colima VM",
      refusal: () => runnerRefusal({ ...onTheMac, info: { ...vm, name: "docker-desktop" } }),
      refused: true,
    },
    {
      label: "the runner against an x86_64 Colima VM",
      refusal: () => runnerRefusal({ ...onTheMac, info: { ...vm, architecture: "x86_64" } }),
      refused: true,
    },
    {
      label: "the runner inside the test container",
      refusal: () => runnerRefusal({ ...onTheMac, env: { DESK_IN_CONTAINER: "1" } }),
      refused: true,
    },
    {
      label: "the suite in the Linux test container",
      refusal: () => suiteRefusal({ platform: "linux", env: { DESK_IN_CONTAINER: "1" } }),
      refused: false,
    },
    {
      label: "the suite on the Mac",
      refusal: () => suiteRefusal({ platform: "darwin", env: { DESK_IN_CONTAINER: "1" } }),
      refused: true,
    },
    { label: "the suite on Linux outside the container", refusal: () => suiteRefusal({ platform: "linux", env: {} }), refused: true },
    {
      label: "the suite with DESK_IN_CONTAINER=true",
      refusal: () => suiteRefusal({ platform: "linux", env: { DESK_IN_CONTAINER: "true" } }),
      refused: true,
    },
  ])(
    "the live runner refuses to run anywhere but Colima, and the suite anywhere but the Linux container ($label)",
    ({ refusal, refused }) => {
      const reason = refusal();

      expect(reason !== null).toBe(refused);
      if (reason !== null) expect(reason.length).toBeGreaterThan(0);
    },
  );
});

describe("the live runner's containers", () => {
  const ours = (runner: string) => ({ [OWNER_LABEL]: "1", [RUNNER_LABEL]: runner });
  const alive = (pid: number) => pid === 12;

  it("the live runner removes leftover desk-live containers and nobody else's", () => {
    const containers = [
      { id: "a1", name: "desk-live-run-a1", state: "exited", labels: ours("mac:10") },
      { id: "b2", name: "desk-live-run-b2", state: "running", labels: ours("mac:11") },
      { id: "c3", name: "desk-live-run-c3", state: "running", labels: ours("mac:12") },
      { id: "d4", name: "desk-live-deps-d4", state: "created", labels: ours("mac:12") },
      { id: "e5", name: "desk-live-run-e5", state: "running", labels: ours("other-mac:11") },
      { id: "f6", name: "er-postgres", state: "exited", labels: ours("mac:10") },
      { id: "g7", name: "desk-live-made-by-hand", state: "exited", labels: {} },
      { id: "h8", name: "desk-lab-smoke", state: "exited", labels: {} },
      // Made by hand from a harness image: labels an image carries reach its containers, but never a runner label.
      { id: "i9", name: "desk-live-from-the-image", state: "exited", labels: { [OWNER_LABEL]: "1", [RESOURCE_LABEL]: "1" } },
    ];

    expect(leftoverContainers(containers, { host: "mac", alive }).map((c) => c.name)).toEqual([
      "desk-live-run-a1",
      "desk-live-run-b2",
      "desk-live-deps-d4",
    ]);
  });

  it.each([
    [0, true],
    [1, true],
    [MAX_DESK_CONTAINERS, false],
    [MAX_DESK_CONTAINERS + 1, false],
  ])("the live runner starts a container only while fewer than two Desk containers run (%i running)", (running, allowed) => {
    const containers = Array.from({ length: running }, (_, i) => ({
      id: `r${i}`,
      name: `desk-live-run-r${i}`,
      state: "running",
      labels: ours(`mac:${100 + i}`),
    }));
    const others = [{ id: "x", name: "er-redis", state: "running", labels: {} }];

    expect(canStartDeskContainer([...containers, ...others])).toBe(allowed);
  });

  it("phase 1 installs dependencies into a volume keyed by the package-lock hash", () => {
    const lock = '{"name":"tyto-desk","lockfileVersion":3}';

    expect(depsVolumeName(lock)).toMatch(/^desk-live-deps-[0-9a-f]{16}$/);
    expect(depsVolumeName(lock)).toBe(depsVolumeName(lock));
    expect(depsVolumeName(lock)).not.toBe(depsVolumeName(`${lock}\n`));
  });

  it("phase 1 copies the package files into the dependency volume with the network on and the repo read-only", () => {
    const args = phase1RunArgs({
      name: "desk-live-deps-1a2b3c4d",
      runner: "mac:42",
      image: "desk-live:0123456789abcdef",
      repo: "/Users/alex/Dev/tyto-desk",
      depsVolume: "desk-live-deps-0123456789abcdef",
    });

    expect(args.slice(0, 4)).toEqual(["--context", "colima", "run", "--rm"]);
    expect(args).not.toContain("--network");
    expect(pairs(args, "--volume")).toEqual([
      "/Users/alex/Dev/tyto-desk:/src:ro",
      "desk-live-deps-0123456789abcdef:/work/node_modules",
      `${CACHE_VOLUME}:/cache`,
    ]);
    expect(pairs(args, "--label")).toEqual([`${OWNER_LABEL}=1`, `${RUNNER_LABEL}=mac:42`]);
    expect(args.slice(-3)).toEqual(["desk-live:0123456789abcdef", "node", "/src/test/live/harness/install.mjs"]);
  });

  it("phase 2 runs the suite with no network, the lab's limits and seccomp profile, the repo read-only and the dependency volume", () => {
    const args = phase2RunArgs({
      name: "desk-live-run-1a2b3c4d",
      runner: "mac:42",
      image: "desk-live:0123456789abcdef",
      repo: "/Users/alex/Dev/tyto-desk",
      depsVolume: "desk-live-deps-0123456789abcdef",
      vitestArgs: ["pty"],
    });

    expect(args.slice(0, 4)).toEqual(["--context", "colima", "run", "--rm"]);
    expect(pairs(args, "--network")).toEqual(["none"]);
    expect(pairs(args, "--shm-size")).toEqual(["1g"]);
    expect(pairs(args, "--memory")).toEqual(["3g"]);
    expect(pairs(args, "--cpus")).toEqual(["3"]);
    expect(pairs(args, "--security-opt")).toEqual(["seccomp=/Users/alex/Dev/tyto-desk/test/live/chrome-seccomp.json"]);
    expect(pairs(args, "--volume")).toEqual([
      "/Users/alex/Dev/tyto-desk:/src:ro",
      "desk-live-deps-0123456789abcdef:/work/node_modules:ro",
    ]);
    expect(pairs(args, "--env")).toContain("DESK_IN_CONTAINER=1");
    expect(args).toContain("--interactive");
    expect(args).not.toContain("--publish");
    expect(args.slice(-4)).toEqual(["desk-live:0123456789abcdef", "node", "/src/test/live/harness/run.mjs", "pty"]);
  });
});

describe("the live image and the files it sees", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const files = [
    { path: "Dockerfile", bytes: bytes("FROM scratch\n") },
    { path: "build-context", bytes: bytes("#!/bin/bash\n") },
    { path: "tools/package-lock.json", bytes: bytes("{}\n") },
    { path: "tools/package.json", bytes: bytes("{}\n") },
  ];

  it("the live image is tagged by the content of test/live/image, whatever order the files are read in", () => {
    expect(imageTag(files)).toMatch(/^desk-live:[0-9a-f]{16}$/);
    expect(imageTag([...files].reverse())).toBe(imageTag(files));
  });

  it.each([
    ["a changed byte", files.map((f, i) => (i === 0 ? { ...f, bytes: bytes("FROM scratch \n") } : f))],
    ["a renamed file", files.map((f, i) => (i === 1 ? { ...f, path: "build-context.sh" } : f))],
    ["a new file", [...files, { path: "extra", bytes: bytes("") }]],
  ])("the live image gets a new tag for %s", (_label, changed) => {
    expect(imageTag(changed)).not.toBe(imageTag(files));
  });

  it("the live image tag sorts paths by code unit, not by the machine's locale", () => {
    const upper = [{ path: "B", bytes: bytes("1") }, { path: "a", bytes: bytes("2") }];

    expect(imageTag(upper)).toBe(imageTag([...upper].reverse()));
    expect(imageTag(upper)).toBe(expectedTag([{ path: "B", text: "1" }, { path: "a", text: "2" }]));
  });

  it("the live image pins branded Chrome for linux-arm64 by version and sha256", async () => {
    const pin = chromePin(await readFile(`${repo}test/live/image/Dockerfile`, "utf8"));

    expect(pin.deb).toMatch(/^google-chrome-stable_\d+\.\d+\.\d+\.\d+-\d+_arm64\.deb$/);
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.url).toBe(`https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/${pin.deb}`);
  });

  it.each([
    ["no Chrome pin at all", "FROM debian\n"],
    ["a version without a sha256", "ARG CHROME_DEB=google-chrome-stable_155.0.8059.39-1_arm64.deb\n"],
    ["an amd64 .deb", `ARG CHROME_DEB=google-chrome-stable_155.0.8059.39-1_amd64.deb\nARG CHROME_SHA256=${"a".repeat(64)}\n`],
  ])("the live runner refuses an image with %s", (_label, dockerfile) => {
    expect(() => chromePin(dockerfile)).toThrow(/must pin CHROME_DEB and CHROME_SHA256/);
  });

  it.each([
    "package.json",
    "package-lock.json",
    ".npmrc",
    "tsconfig.base.json",
    "vitest.live.config.ts",
    "packages/core/src/index.ts",
    "test/live/chrome.test.ts",
    "scripts/lib/live.mjs",
  ])("the live container copies %s from the read-only repo", (path) => {
    expect(repoPathAllowed(path)).toBe(true);
  });

  it.each([
    ".env",
    ".git/config",
    "node_modules/vitest/package.json",
    "packages/core/node_modules/x/index.js",
    "test-results/live/vitest.json",
    "dist/core/index.js",
    "docs/IMPLEMENTATION.md",
    "test/live/.desk/config.json",
    "test/.agent-browser/sessions/main.json",
    "../outside.json",
  ])("the live container leaves %s out", (path) => {
    expect(repoPathAllowed(path)).toBe(false);
  });

  it("the repo's .dockerignore is the live container's allowlist", async () => {
    expect(await readFile(`${repo}.dockerignore`, "utf8")).toBe(dockerignoreText());
  });
});

/**
 * The tag scheme spelled out: the sha256 over each file's path, NUL, byte length, NUL and bytes, taken in the order
 * given (the caller lists them in code-unit order of path), as 16 hex digits.
 */
function expectedTag(entries: { path: string; text: string }[]): string {
  const hash = createHash("sha256");
  for (const { path, text } of entries) {
    const data = new TextEncoder().encode(text);
    hash.update(path).update("\0").update(String(data.length)).update("\0").update(data);
  }
  return `desk-live:${hash.digest("hex").slice(0, 16)}`;
}

/** Every value that follows `flag` in a docker argv. */
function pairs(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, i) => (arg === flag && i + 1 < args.length ? [args[i + 1] ?? ""] : []));
}
