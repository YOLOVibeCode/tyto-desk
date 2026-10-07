import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ports = fileURLToPath(new URL("../src/ports/", import.meta.url));

/** What a port may import besides other ports: the data types it carries, never a plan that uses it. */
const CARRIED_TYPES = new Set(["protocol/messages.ts", "config/schema.ts"]);

/** Each relative module a port file names, as a path under src/. */
async function portImports(): Promise<{ port: string; module: string }[]> {
  const found: { port: string; module: string }[] = [];
  for (const port of (await readdir(ports)).filter((name) => name.endsWith(".ts"))) {
    const text = await readFile(join(ports, port), "utf8");
    for (const match of text.matchAll(/\bfrom\s+"(\.{1,2}\/[^"]+)"/g)) {
      found.push({ port, module: posix.normalize(posix.join("ports", match[1] ?? "")) });
    }
  }
  return found;
}

describe("the ports (docs/IMPLEMENTATION.md §3)", () => {
  it("a port imports only other ports and the data types they carry, never a plan that uses it", async () => {
    const plans = (await portImports()).filter(({ module }) => !module.startsWith("ports/") && !CARRIED_TYPES.has(module));

    expect(plans).toEqual([]);
  });
});
