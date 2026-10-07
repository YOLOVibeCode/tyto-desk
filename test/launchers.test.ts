import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { deskLauncher, hostLauncher, terminalBinary } from "../packages/core/src/index.ts";
import { linkSharedExecutable } from "./fixtures/fake-exec.ts";

const run = promisify(execFile);

/** A launcher read by /bin/sh, as its #!/bin/sh line has the kernel do (one test below runs one through the kernel). */
const runLauncher = (launcher: string, args: string[]) => run("/bin/sh", [launcher, ...args], { env: ENV });

/**
 * A Desk Terminal stub that prints the version it belongs to (from its own path), its argv, and the environment it got.
 * Every one is the same file, hard-linked (fixtures/fake-exec.ts), so macOS checks it once per run.
 */
const TERMINAL_STUB = [
  "#!/bin/sh",
  'v=\${0%"/Desk Terminal.app/"*}',
  'v=\${v%/node/desk-node}',
  `printf '%s\\n' "\${v##*/}" "$@"`,
  `printf 'NODE_OPTIONS=%s DESK_HOME=%s DESK_ALLOW_GUI=%s\\n' "\${NODE_OPTIONS-unset}" "\${DESK_HOME-unset}" "\${DESK_ALLOW_GUI-unset}"`,
  "",
].join("\n");

/**
 * A DESK_HOME with two installed versions whose Desk Terminal is a stub that prints the argv and the environment it got,
 * and `current` pointing at the first.
 */
async function installedVersions(platform: string) {
  const deskHome = join(await realpath(await mkdtemp(join(tmpdir(), "launchers-"))), ".desk");
  for (const version of ["0.3.0", "0.3.1"]) {
    const terminal = join(deskHome, "app", version, terminalBinary(platform));
    await mkdir(join(terminal, ".."), { recursive: true });
    await linkSharedExecutable("desk-terminal", TERMINAL_STUB, terminal);
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

      const { stdout } = await runLauncher(launchers.desk, ["--version"]);

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

    const { stdout } = await runLauncher(launchers.host, ["chrome-extension://nmnljgjkacmplpfllopodplgmpjogdbf/"]);

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
    const first = await runLauncher(launchers.desk, []);
    await symlink("0.3.1", join(deskHome, "app", ".current-next"));
    await rename(join(deskHome, "app", ".current-next"), join(deskHome, "app", "current"));

    const second = await runLauncher(launchers.desk, []);

    expect(first.stdout.split("\n")[1]).toBe(join(deskHome, "app", "0.3.0", "desk.mjs"));
    expect(second.stdout.split("\n")[1]).toBe(join(deskHome, "app", "0.3.1", "desk.mjs"));
    expect(`${first.stdout}${second.stdout}`).not.toContain("/current/");
  });

  it("a launcher with no current version says so and exits 69 (run through the kernel, as its #!/bin/sh line says)", async () => {
    const deskHome = join(await mkdtemp(join(tmpdir(), "launchers-")), ".desk");
    const launcher = join(await mkdtemp(join(tmpdir(), "bin-")), "desk");
    await writeFile(launcher, deskLauncher({ deskHome, platform: "linux" }), { mode: 0o700 });

    const failed = await run(launcher, [], { env: ENV }).catch((err: unknown) => err as { code: number; stderr: string });

    expect(failed).toMatchObject({ code: 69, stderr: expect.stringContaining("run desk install") });
  });

  it.each([
    ["a command substitution", "h$(echo INJECTED-BY-DESK_HOME)"],
    ["backticks", "h`echo INJECTED-BY-DESK_HOME`"],
    ["a parameter expansion", "h${PATH}"],
    ["a newline that would end the comment", "h\necho INJECTED-BY-DESK_HOME >&2; exit 3\n#"],
    ["a double quote", 'h"q'],
    ["a backslash escape", "h\\tq"],
  ])("a launcher's DESK_HOME is data, never shell code (%s)", async (_label, name) => {
    const deskHome = join(await mkdtemp(join(tmpdir(), "launchers-")), name);
    const launcher = join(await mkdtemp(join(tmpdir(), "bin-")), "desk");
    await writeFile(launcher, deskLauncher({ deskHome, platform: "linux" }), { mode: 0o700 });

    const failed = await runLauncher(launcher, []).catch((err: unknown) => err as { code: number; stderr: string });

    expect(failed).toMatchObject({ code: 69, stderr: `desk: no current version in ${deskHome}/app; run desk install\n` });
  });
});
