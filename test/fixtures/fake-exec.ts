import { chmod, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STUB = fileURLToPath(new URL("./fake-exec.mjs", import.meta.url));

export type Rule = { match: string[]; stdout?: string; stderr?: string; exit?: number };
export type Call = { argv: string[]; env: Record<string, string> };

/** Single-quoted for /bin/sh. */
export function shQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/**
 * One executable file per test run, made from `text` once and hard-linked under every name that asks for it. macOS
 * checks a new executable file the first time it runs (about 0.3 s, one file at a time across the whole run), and a
 * hard link is that same file, so only the first stub of each kind pays. `text` must find what differs between stubs
 * from the stub's own path (`$0`), never hold it.
 */
export async function linkSharedExecutable(kind: string, text: string, path: string): Promise<void> {
  const dir = join(tmpdir(), "shared-executables");
  const shared = join(dir, kind);
  await mkdir(dir, { recursive: true });
  const draft = `${shared}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await writeFile(draft, text);
  await chmod(draft, 0o755);
  try {
    await link(draft, shared);
  } catch (err) {
    if (errorCode(err) !== "EEXIST") throw err;
  } finally {
    await rm(draft, { force: true });
  }
  if ((await readFile(shared, "utf8")) !== text) throw new Error(`the shared ${kind} stub holds other text`);
  await link(shared, path);
}

/**
 * An executable named `name` that records its calls and answers by `rules` (fixtures/fake-exec.mjs). It is
 * `<dir>/bin/<name>`, and finds its scenario and call log in `<dir>`.
 */
export async function fakeExecutable(name: string, rules: Rule[]): Promise<{ path: string; calls(): Promise<Call[]> }> {
  const dir = await mkdtemp(join(tmpdir(), `fake-${name}-`));
  const scenario = join(dir, "scenario.json");
  const log = join(dir, "calls.log");
  await writeFile(scenario, JSON.stringify({ rules }));
  await writeFile(log, "");
  await mkdir(join(dir, "bin"));
  const path = join(dir, "bin", name);
  const wrapper = `#!/bin/sh\nhere=\${0%/*}/..\nexec ${shQuote(process.execPath)} ${shQuote(STUB)} "$here/scenario.json" "$here/calls.log" "$@"\n`;
  await linkSharedExecutable("fake-exec", wrapper, path);
  return {
    path,
    calls: async () =>
      (await readFile(log, "utf8"))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Call),
  };
}
