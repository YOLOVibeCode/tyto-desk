import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { listenViolations, packageSourceFiles } from "../scripts/lib/listen.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const typeRoots = [join(repo, "node_modules", "@types")];

const header = `
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
declare const socketPath: string;
declare const maybePath: string | undefined;
declare const host: string;
declare const opts: { host: string };
declare const onConnection: () => void;
const server = createServer();
const messages = { listen(handler: () => void): void { handler(); } };
`;

const refused = [
  "server.listen(9583);",
  "server.listen({ port: 9583 });",
  'server.listen(9583, "0.0.0.0");',
  'server.listen({ port: 9583, host: "localhost" });',
  "server.listen();",
  "createHttpServer().listen(9583, () => undefined);",
  'server.listen(process.env.DESK_PORT ?? "9583");',
  "server.listen(socketPath);",
  'server.listen("");',
  'server.listen(" 9583 ");',
  "server.listen(9583, host);",
  "server.listen({ path: maybePath });",
  "server.listen({ path: maybePath, port: 9583 });",
  "server.listen({ path: socketPath, port: 9583 });",
  'server.listen({ host: "127.0.0.1", ...opts, port: 9583 });',
];

const passed = [
  'server.listen(9583, "127.0.0.1");',
  'server.listen({ host: "127.0.0.1", port: 0 });',
  'server.listen({ host: "127.0.0.1", port: 9583 }, () => undefined);',
  'createHttpServer().listen(9583, "127.0.0.1", () => undefined);',
  'server.listen("/tmp/desk-test.sock");',
  "server.listen({ path: socketPath });",
  "const path = socketPath; server.listen({ path });",
  "messages.listen(onConnection);",
];

let results = new Map<string, number>();

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "listen-"));
  const files = new Map<string, string>();
  for (const [index, line] of [...refused, ...passed].entries()) {
    const file = join(dir, `fixture-${index}.ts`);
    await writeFile(file, `${header}${line}\n`);
    files.set(line, file);
  }
  const violations = listenViolations([...files.values()], { typeRoots });
  results = new Map([...files].map(([line, file]) => [line, violations.filter((v) => v.file === file).length]));
});

describe("lint:listen", () => {
  it("every listen() in packages names 127.0.0.1 or a socket path", async () => {
    const files = await packageSourceFiles(repo);

    expect(files.some((file) => file.endsWith("port-probe.ts"))).toBe(true);
    expect(listenViolations(files, { typeRoots })).toEqual([]);
  });

  it.each(refused)("the listen lint flags %s", (line) => {
    expect(results.get(line)).toBe(1);
  });

  it.each(passed)("the listen lint passes %s", (line) => {
    expect(results.get(line)).toBe(0);
  });
});
