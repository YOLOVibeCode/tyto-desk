import { cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHROME_CACHE_DIR, CI_CACHE_DIR, USERNS_LIMIT, chromeCacheFile, chromePin, imageFileAllowed, imageTag } from "../scripts/lib/live.mjs";
import { ci, exists, harness, inActions, modes, onTheMac, phase2Call, repo, run, subcommand, withoutContext } from "./fixtures/live-runner-harness.ts";

describe("the live runner script, driving a stub docker: interrupts, docker contexts, phases and the image", () => {
  it.each(modes)("a missing docker CLI is one test:live line, not a stack trace ($mode)", async ({ scenario, options }) => {
    const live = await harness(scenario);

    const { code, err } = await live.run({ ...options, docker: join(live.home, "no-such-docker") });

    expect(code).toBe(1);
    expect(err).toMatch(/^test:live: docker is not installed or not on PATH/);
    expect(err).not.toMatch(/\n\s+at /);
  });

  it("npm run test:live -- --ci refuses outside GitHub Actions before it runs docker", async () => {
    const result = await run(process.execPath, [join(repo, "scripts", "live.mjs"), "--ci"], {
      env: { PATH: dirname(process.execPath), HOME: tmpdir() },
      timeout: 20_000,
    }).then(
      () => ({ code: 0, stderr: "" }),
      (failure: { code?: number; stderr?: string }) => ({ code: failure.code ?? -1, stderr: failure.stderr ?? "" }),
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^test:live: --ci runs only in GitHub Actions/);
  });

  it.each(modes)(
    "the first interrupt stops the suite through its container, and the results still come out ($mode)",
    async ({ scenario, options }) => {
      const live = await harness((home) => ({ ...scenario(home), phase2: { untilKilled: true, done: 143, exit: 143 } }));
      const signals = new EventEmitter();

      const { code, out, err } = await live.run({
        ...options,
        signals,
        onOut: (text) => {
          if (text.includes("suite running")) signals.emit("SIGINT");
        },
      });
      const calls = await live.calls();

      expect(code).toBe(130);
      expect(err).toMatch(/SIGINT: stopping the suite/);
      expect(calls.some((call) => subcommand(call) === "kill" && call.includes("SIGTERM"))).toBe(true);
      expect(calls.map(subcommand)).toContain("cp");
      expect(out).toMatch(/3 passed/);
    },
  );

  it.each(modes)("a second interrupt removes the run's containers and copies nothing ($mode)", async ({ scenario, options }) => {
    const live = await harness((home) => ({
      ...scenario(home),
      phase2: { untilKilled: true, ignoreKill: true, done: 0, exit: 0 },
    }));
    const signals = new EventEmitter();

    const { code, out, err } = await live.run({
      ...options,
      signals,
      onOut: (text) => {
        if (!text.includes("suite running")) return;
        signals.emit("SIGINT");
        signals.emit("SIGINT");
      },
    });

    expect(code).toBe(130);
    expect(err).toMatch(/SIGINT, removing this run's containers/);
    expect((await live.calls()).map(subcommand)).not.toContain("cp");
    expect(out).not.toMatch(/passed|no results/);
  });

  it("without --ci the live runner drives docker only through the colima context", async () => {
    const live = await harness((home) => ({
      ...onTheMac(home),
      imageCached: false,
      volumesExist: false,
      depsReady: false,
      phase2: { done: 0, exit: 0 },
    }));

    const { code } = await live.run();
    const calls = await live.calls();

    expect(code).toBe(0);
    expect(calls[0]).toEqual(["context", "inspect", "colima"]);
    expect(calls.slice(1).every((call) => call[0] === "--context" && call[1] === "colima")).toBe(true);
    expect(calls.flat().join(" ")).not.toContain(CI_CACHE_DIR);
  });

  it("in GitHub Actions the live runner drives the runner's own engine through the default context and keeps the Chrome .deb where live-run.yml caches it", async () => {
    const live = await harness(() => ({
      ...inActions(),
      imageCached: false,
      volumesExist: false,
      depsReady: false,
      phase2: { done: 0, exit: 0 },
    }));
    const pin = chromePin(await readFile(join(live.checkout, "test", "live", "image", "Dockerfile"), "utf8"));

    const { code } = await live.run(ci);
    const calls = await live.calls();
    const cache = `type=bind,source=${live.home}/${CI_CACHE_DIR},target=/cache`;
    const runs = (marker: string) => calls.filter((call) => subcommand(call) === "run" && call.some((arg) => arg.includes(marker)));
    const fetch = runs("fetch-verified")[0] ?? [];

    expect(code).toBe(0);
    expect(calls.every((call) => call[0] === "--context" && call[1] === "default")).toBe(true);
    expect(calls.flat().join(" ")).not.toMatch(/colima|desk-live-cache/);
    expect(runs("chown")[0]).toContain(`type=bind,source=${live.home}/${CI_CACHE_DIR},target=/volume`);
    expect(fetch).toContain(cache);
    // /cache/chrome/<sha256>/<deb> in the container is ~/.cache/desk-live/chrome/<sha256>/<deb> on the runner, inside
    // ~/.cache/desk-live/chrome, the path live-run.yml restores and saves.
    expect(fetch.slice(-3)).toEqual([pin.url, pin.sha256, `/cache/${chromeCacheFile(pin)}`]);
    expect(chromeCacheFile(pin).startsWith(`${CHROME_CACHE_DIR}/`)).toBe(true);
    expect(runs("build-context")[0]).toContain(`${cache},readonly`);
    expect(runs("install.mjs")[0]).toContain(cache);
    expect(runs("run.mjs")[0]?.slice(-1)).toEqual(["/src/test/live/harness/run.mjs"]);
    expect(await exists(join(live.home, CI_CACHE_DIR))).toBe(true);
    expect(await exists(join(live.checkout, "test-results", "live", "vitest.json"))).toBe(true);
  });

  it("in GitHub Actions phase 2 is the Mac's phase 2, with no network, but for the docker context", async () => {
    const mac = await harness((home) => ({ ...onTheMac(home), phase2: { done: 0, exit: 0 } }));
    const actions = await harness(() => ({ ...inActions(), phase2: { done: 0, exit: 0 } }));

    expect((await mac.run()).code).toBe(0);
    expect((await actions.run(ci)).code).toBe(0);
    const onMac = await phase2Call(mac);
    const inCi = await phase2Call(actions);

    expect(onMac.slice(0, 2)).toEqual(["--context", "colima"]);
    expect(inCi.slice(0, 2)).toEqual(["--context", "default"]);
    expect(inCi.slice(2)).toEqual(onMac.slice(2));
    expect(inCi.join(" ")).toContain("--network none");
  });

  it.each(modes)(
    "phase 2 mounts the checkout's allowlisted top-level files and directories read-only, and nothing else of it ($mode)",
    async ({ scenario, options }) => {
      const live = await harness((home) => ({ ...scenario(home), phase2: { done: 0, exit: 0 } }));
      await mkdir(join(live.checkout, ".git"));
      await writeFile(join(live.checkout, ".git", "config"), "[core]\n");
      await writeFile(join(live.checkout, ".env.local"), "DESK_EXAMPLE=1\n");
      await mkdir(join(live.checkout, "docs"));
      await writeFile(join(live.checkout, "docs", "notes.md"), "notes\n");
      await mkdir(join(live.checkout, "scripts"));
      await writeFile(join(live.checkout, "scripts", "live.mjs"), "\n");
      await symlink("/etc/hosts", join(live.checkout, "vitest.extra.config.ts"));

      const { code } = await live.run(options);
      const call = await phase2Call(live);
      const binds = call.filter((arg, i) => call[i - 1] === "--mount" && arg.startsWith("type=bind,"));

      expect(code).toBe(0);
      expect(binds).toEqual(
        [".npmrc", "package-lock.json", "package.json", "packages", "scripts", "test"].map(
          (name) => `type=bind,source=<repo>/${name},target=/src/${name},readonly`,
        ),
      );
    },
  );

  it("the live image's tag and build context leave out node_modules, so installing the image's tools locally never forces a rebuild", async () => {
    const live = await harness((home) => ({ ...onTheMac(home), imageCached: false, phase2: { done: 0, exit: 0 } }));
    const image = join(live.checkout, "test", "live", "image");
    const files = (await readdir(image, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(image.length + 1));
    const tracked = await Promise.all(
      files.filter((path) => imageFileAllowed(path)).map(async (path) => ({ path, bytes: await readFile(join(image, path)) })),
    );
    const modules = join(image, "tools", "node_modules");
    await mkdir(join(modules, "agent-browser", "bin"), { recursive: true });
    await writeFile(join(modules, "agent-browser", "package.json"), '{"name":"agent-browser"}\n');
    await writeFile(join(modules, "agent-browser", "bin", "agent-browser-linux-arm64"), "binary\n");
    await writeFile(join(modules, ".package-lock.json"), "{}\n");

    expect((await live.run()).code).toBe(0);
    const calls = (await live.calls()).map(withoutContext);
    const helper = calls.find((call) => call.includes("build-context")) ?? [];
    const contextMounts = helper
      .filter((arg, i) => helper[i - 1] === "--mount" && arg.includes(",target=/context"))
      .map((arg) => arg.replaceAll(live.checkout, "<repo>"));
    const fetchBuild = calls.find((call) => call[0] === "build" && call.includes("fetch")) ?? [];

    expect(calls.find((call) => call[0] === "image" && call[1] === "inspect")?.[2]).toBe(imageTag(tracked));
    expect(contextMounts).toEqual(
      ["Dockerfile", "build-context", "fetch-verified", "tools/package-lock.json", "tools/package.json"].map(
        (file) => `type=bind,source=<repo>/test/live/image/${file},target=/context/${file},readonly`,
      ),
    );
    expect(fetchBuild.at(-1)).toBe(image);
    expect((await readFile(join(image, ".dockerignore"), "utf8")).split("\n")).toContain("**/node_modules");
  });

  it("with --ci the live runner refuses before any docker command while Ubuntu's AppArmor limits unprivileged user namespaces", async () => {
    const live = await harness(inActions);

    const { code, err } = await live.run({ ...ci, userns: "1\n" });

    expect(code).toBe(1);
    expect(err).toMatch(/^test:live: /);
    expect(err).toContain(`sudo sysctl -w ${USERNS_LIMIT}=0`);
    expect(await live.calls()).toEqual([]);
  });

  it("with --ci the live runner runs on a kernel without AppArmor's user-namespace limit", async () => {
    const live = await harness(() => ({ ...inActions(), phase2: { done: 0, exit: 0 } }));

    const { code } = await live.run({ ...ci, userns: null });

    expect(code).toBe(0);
  });

  it("on the Mac the live runner leaves the user-namespace limit to the Colima VM", async () => {
    const live = await harness((home) => ({ ...onTheMac(home), phase2: { done: 0, exit: 0 } }));

    const { code } = await live.run({ userns: "1\n" });

    expect(code).toBe(0);
  });
});
