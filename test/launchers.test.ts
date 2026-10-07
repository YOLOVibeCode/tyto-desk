import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { deskLauncher, hostLauncher, terminalBinary } from "../packages/core/src/index.ts";

const run = promisify(execFile);

/**
 * A DESK_HOME with two installed versions whose Desk Terminal is a stub that prints the argv and the environment it got,
 * and `current` pointing at the first.
 */
async function installedVersions(platform: string) {
  const deskHome = join(await realpath(await mkdtemp(join(tmpdir(), "launchers-"))), ".desk");
  for (const version of ["0.3.0", "0.3.1"]) {
    const terminal = join(deskHome, "app", version, terminalBinary(platform));
    await mkdir(join(terminal, ".."), { recursive: true });
    await writeFile(
      terminal,
      `#!/bin/sh\nprintf '%s\\n' "${version}" "$@"\nprintf 'NODE_OPTIONS=%s DESK_HOME=%s DESK_ALLOW_GUI=%s\\n' "\${NODE_OPTIONS-unset}" "\${DESK_HOME-unset}" "\${DESK_ALLOW_GUI-unset}"\n`,
    );
    await chmod(terminal, 0o755);
  }
  await symlink("0.3.0", join(deskHome, "app", "current"));
  const launchers = { desk: join(deskHome, "launch-desk"), host: join(deskHome, "launch-host") };
  await writeFile(launchers.desk, deskLauncher({ deskHome, platform }), { mode: 0o700 });
  await writeFile(launchers.host, hostLauncher({ deskHome, platform }), { mode: 0o700 });
  return { deskHome, launchers };
}

const ENV = { PATH: "/usr/bin:/bin", NODE_OPTIONS: "--require /tmp/evil.js", NODE_PATH: "/tmp", HOME: tmpdir() };

describe("the launchers", () => {
  it.each(["darwin", "linux"])(
    "the launchers resolve current once and exec that version's Desk Terminal (%s)",
    async (platform) => {
      const { deskHome, launchers } = await installedVersions(platform);

      const { stdout } = await run(launchers.desk, ["--version"], { env: ENV });

      expect(stdout.split("\n")).toEqual([
        "0.3.0",
        join(deskHome, "app", "0.3.0", "desk.mjs"),
        "--version",
        `NODE_OPTIONS=unset DESK_HOME=${deskHome} DESK_ALLOW_GUI=1`,
        "",
      ]);
    },
  );

  it("the host launcher runs that version's nmhost entry with Chrome's arguments, and without the GUI", async () => {
    const { deskHome, launchers } = await installedVersions("darwin");

    const { stdout } = await run(launchers.host, ["chrome-extension://nmnljgjkacmplpfllopodplgmpjogdbf/"], { env: ENV });

    expect(stdout.split("\n")).toEqual([
      "0.3.0",
      join(deskHome, "app", "0.3.0", "desk.mjs"),
      "nmhost",
      "chrome-extension://nmnljgjkacmplpfllopodplgmpjogdbf/",
      `NODE_OPTIONS=unset DESK_HOME=${deskHome} DESK_ALLOW_GUI=unset`,
      "",
    ]);
  });

  it("a launcher runs the version current names when it starts, never a path through current", async () => {
    const { deskHome, launchers } = await installedVersions("linux");
    const first = await run(launchers.desk, [], { env: ENV });
    await symlink("0.3.1", join(deskHome, "app", ".current-next"));
    await rename(join(deskHome, "app", ".current-next"), join(deskHome, "app", "current"));

    const second = await run(launchers.desk, [], { env: ENV });

    expect(first.stdout.split("\n")[1]).toBe(join(deskHome, "app", "0.3.0", "desk.mjs"));
    expect(second.stdout.split("\n")[1]).toBe(join(deskHome, "app", "0.3.1", "desk.mjs"));
    expect(`${first.stdout}${second.stdout}`).not.toContain("/current/");
  });

  it("a launcher with no current version says so and exits 69", async () => {
    const deskHome = join(await mkdtemp(join(tmpdir(), "launchers-")), ".desk");
    const launcher = join(await mkdtemp(join(tmpdir(), "bin-")), "desk");
    await writeFile(launcher, deskLauncher({ deskHome, platform: "linux" }), { mode: 0o700 });

    const failed = await run(launcher, [], { env: ENV }).catch((err: unknown) => err as { code: number; stderr: string });

    expect(failed).toMatchObject({ code: 69, stderr: expect.stringContaining("run desk install") });
  });
});
