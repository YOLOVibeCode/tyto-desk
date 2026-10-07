import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The repository root. */
export const repo = fileURLToPath(new URL("../..", import.meta.url));

/** A stub executable under test/delivery/fixtures, run with the Node that runs the tests. */
export function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

/** Git with no user or system configuration, so a test never runs the operator's hooks, signing or aliases. */
export const gitEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

export async function git(root: string, args: string[]): Promise<string> {
  const identity = ["-c", "user.name=Desk Test", "-c", "user.email=desk-test@example.test", "-c", "init.defaultBranch=main"];
  const { stdout } = await run("git", [...identity, ...args], { cwd: root, env: gitEnv });
  return stdout.trim();
}

/** Writes `files` under a new temp directory and returns it. */
export async function tempTree(prefix: string, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

/** A git checkout with `files` committed on `branch`; returns its root and HEAD. */
export async function gitCheckout(
  files: Record<string, string>,
  branch = "main",
): Promise<{ root: string; head: string }> {
  const root = await tempTree("checkout-", files);
  await git(root, ["init", "-q", "-b", branch]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "init", "--no-gpg-sign"]);
  return { root, head: await git(root, ["rev-parse", "HEAD"]) };
}

export type Exit = { code: number; stdout: string; stderr: string };

/** Runs a Node script to completion; a non-zero exit is a result. */
export async function runScript(script: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<Exit> {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], {
      cwd: options.cwd ?? repo,
      env: options.env ?? gitEnv,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}
