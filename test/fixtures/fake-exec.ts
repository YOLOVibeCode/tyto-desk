import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STUB = fileURLToPath(new URL("./fake-exec.mjs", import.meta.url));

export type Rule = { match: string[]; stdout?: string; stderr?: string; exit?: number };
export type Call = { argv: string[]; env: Record<string, string> };

/** Single-quoted for /bin/sh. */
function shQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** An executable named `name` that records its calls and answers by `rules` (fixtures/fake-exec.mjs). */
export async function fakeExecutable(name: string, rules: Rule[]): Promise<{ path: string; calls(): Promise<Call[]> }> {
  const dir = await mkdtemp(join(tmpdir(), `fake-${name}-`));
  const scenario = join(dir, "scenario.json");
  const log = join(dir, "calls.log");
  await writeFile(scenario, JSON.stringify({ rules }));
  await writeFile(log, "");
  await mkdir(join(dir, "bin"));
  const path = join(dir, "bin", name);
  await writeFile(path, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(STUB)} ${shQuote(scenario)} ${shQuote(log)} "$@"\n`);
  await chmod(path, 0o755);
  return {
    path,
    calls: async () =>
      (await readFile(log, "utf8"))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Call),
  };
}
