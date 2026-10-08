import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nodePin, parseNodeRuntime, readNodeRuntime } from "../scripts/delivery/lib/node-runtime.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));

describe("Desk Terminal's pinned Node (scripts/delivery/node-runtime.json, docs/IMPLEMENTATION.md §15.1, §23.6)", () => {
  it("Desk Terminal's Node is the version .nvmrc names", async () => {
    const runtime = await readNodeRuntime(repo);

    expect(runtime.version).toBe((await readFile(`${repo}.nvmrc`, "utf8")).trim());
  });

  it("Desk Terminal's Node for darwin-arm64 is pinned by the sha256 of nodejs.org's tarball and of its bin/node", async () => {
    const pin = nodePin(await readNodeRuntime(repo), "darwin", "arm64");

    expect(pin).toEqual({
      archive: "node-v26.10.0-darwin-arm64.tar.gz",
      archiveSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      binarySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("the live container's Node is pinned by the same tarball the live image installs", async () => {
    const pin = nodePin(await readNodeRuntime(repo), "linux", "arm64");
    const dockerfile = await readFile(`${repo}test/live/image/Dockerfile`, "utf8");

    expect(pin?.archive).toBe("node-v26.10.0-linux-arm64.tar.xz");
    expect(dockerfile).toContain(`ARG NODE_SHA256=${pin?.archiveSha256}`);
    expect(dockerfile).toContain("ARG NODE_VERSION=26.10.0");
  });

  it.each([
    ["darwin", "x64"],
    ["win32", "arm64"],
    ["linux", "x64"],
  ])("there is no pinned Node for %s-%s, where Desk does not run", async (platform, arch) => {
    expect(nodePin(await readNodeRuntime(repo), platform, arch)).toBeNull();
  });
});

describe("the Node pin refuses what it cannot trust (the security reviews of PR #8)", () => {
  /** The repo's pin, as JSON, with `change` applied to a copy. */
  async function pinWith(change: (pin: Record<string, unknown> & { platforms: Record<string, Record<string, unknown>> }) => void): Promise<unknown> {
    const pin = JSON.parse(await readFile(`${repo}scripts/delivery/node-runtime.json`, "utf8")) as Record<string, unknown> & {
      platforms: Record<string, Record<string, unknown>>;
    };
    change(pin);
    return pin;
  }

  it("the pin names nodejs.org's own directory for its version as its source", async () => {
    expect((await readNodeRuntime(repo)).source).toBe("https://nodejs.org/dist/v26.10.0/");
  });

  it.each<[string, (pin: Record<string, unknown> & { platforms: Record<string, Record<string, unknown>> }) => void, RegExp]>([
    ["a version that is not X.Y.Z", (pin) => (pin.version = "26.10"), /exact Node version/],
    ["a pre-release version", (pin) => (pin.version = "26.10.0-rc.1"), /exact Node version/],
    ["a version with a leading v", (pin) => (pin.version = "v26.10.0"), /exact Node version/],
    ["a version with a trailing newline", (pin) => (pin.version = "26.10.0\n"), /exact Node version/],
    ["a version part of more than four digits", (pin) => (pin.version = "26.10000.0"), /exact Node version/],
    ["a version that is not a string", (pin) => (pin.version = ["26.10.0"]), /exact Node version/],
    ["a source in another of nodejs.org's directories", (pin) => (pin.source = "https://nodejs.org/dist/v26.9.0/"), /source is not https:\/\/nodejs\.org\/dist\/v26\.10\.0\//],
    ["a key that differs from a known one only in case", (pin) => (pin.Version = "26.10.0"), /unknown key "Version"/],
    ["a digest one character too long", (pin) => ((pin.platforms["darwin-arm64"] ?? {}).archiveSha256 = "a".repeat(65)), /darwin-arm64 entry is malformed/],
    ["a digest that is not a string", (pin) => ((pin.platforms["darwin-arm64"] ?? {}).binarySha256 = ["a".repeat(64)]), /darwin-arm64 entry is malformed/],
    ["a version with a leading zero", (pin) => (pin.version = "26.010.0"), /exact Node version/],
    ["a source other than nodejs.org's directory for the version", (pin) => (pin.source = "https://example.com/dist/v26.10.0/"), /source/],
    ["no source", (pin) => delete pin.source, /source/],
    ["no platforms", (pin) => delete (pin as Record<string, unknown>).platforms, /has no platforms/],
    ["platforms that are an array", (pin) => ((pin as Record<string, unknown>).platforms = []), /has no platforms/],
    ["a key it does not know", (pin) => (pin.url = "https://example.com/node.tar.gz"), /unknown key "url"/],
    ["a platform Desk does not build for", (pin) => (pin.platforms["darwin-x64"] = { ...pin.platforms["darwin-arm64"] }), /darwin-x64/],
    ["a __proto__ platform", (pin) => Object.defineProperty(pin.platforms, "__proto__", { value: {}, enumerable: true }), /"__proto__"/],
    ["a constructor platform", (pin) => (pin.platforms["constructor"] = { ...pin.platforms["darwin-arm64"] }), /"constructor"/],
    [
      "an entry it only inherits",
      (pin) => (pin.platforms = Object.assign(Object.create({ "linux-arm64": pin.platforms["linux-arm64"] }) as Record<string, Record<string, unknown>>, { "darwin-arm64": pin.platforms["darwin-arm64"] })),
      /has no linux-arm64 entry/,
    ],
    ["a missing platform", (pin) => delete pin.platforms["linux-arm64"], /linux-arm64/],
    ["an entry that is not an object", (pin) => ((pin.platforms as Record<string, unknown>)["darwin-arm64"] = null), /darwin-arm64 entry is malformed/],
    ["an entry that is an array", (pin) => ((pin.platforms as Record<string, unknown>)["darwin-arm64"] = []), /darwin-arm64 entry is malformed/],
    ["an entry with a key it does not know", (pin) => ((pin.platforms["darwin-arm64"] ?? {}).url = "https://example.com/node.tar.gz"), /darwin-arm64 entry has an unknown key "url"/],
    ["an archive that is a URL", (pin) => ((pin.platforms["darwin-arm64"] ?? {}).archive = "https://example.com/node-v26.10.0-darwin-arm64.tar.gz"), /darwin-arm64 archive/],
    ["an archive path that leaves the directory", (pin) => ((pin.platforms["darwin-arm64"] ?? {}).archive = "../../etc/node.tar.gz"), /archive/],
    ["an archive of another version", (pin) => ((pin.platforms["darwin-arm64"] ?? {}).archive = "node-v26.9.0-darwin-arm64.tar.gz"), /archive/],
    ["an archive of another platform", (pin) => ((pin.platforms["darwin-arm64"] ?? {}).archive = "node-v26.10.0-linux-arm64.tar.gz"), /archive/],
    ["a digest of the wrong length", (pin) => ((pin.platforms["darwin-arm64"] ?? {}).archiveSha256 = "ab"), /darwin-arm64 entry is malformed/],
    ["a digest in capitals", (pin) => ((pin.platforms["linux-arm64"] ?? {}).binarySha256 = "A".repeat(64)), /linux-arm64 entry is malformed/],
  ])("the pin is refused with %s", async (_, change, why) => {
    const pin = await pinWith(change);

    expect(() => parseNodeRuntime(pin)).toThrow(why);
  });

  it("a __proto__ platform in the file's own text is refused too", async () => {
    const text = (await readFile(`${repo}scripts/delivery/node-runtime.json`, "utf8")).replace('"platforms": {', '"platforms": { "__proto__": {},');

    expect(() => parseNodeRuntime(JSON.parse(text))).toThrow(/"__proto__"/);
  });

  it.each<[string, (pin: Record<string, unknown> & { platforms: Record<string, Record<string, unknown>> }) => void]>([
    ["a top-level key", (p) => (p["x\n::error title=pin::injected"] = 1)],
    ["an entry's key", (p) => ((p.platforms["darwin-arm64"] ?? {})["x\n::error title=pin::injected"] = 1)],
  ])("a refusal stays one line: %s from the file is quoted, so a newline in it cannot start a line", async (_, change) => {
    const pin = await pinWith(change);

    expect(() => parseNodeRuntime(pin)).toThrow('"x\\n::error title=pin::injected"');
  });

  /** The three places a name from the file reaches a refusal: a top-level key, a platform, an entry's key. */
  const SITES: [string, (p: Record<string, unknown> & { platforms: Record<string, Record<string, unknown>> }, name: string) => void][] = [
    ["a top-level key", (p, name) => (p[name] = 1)],
    ["a platform", (p, name) => (p.platforms[name] = { ...p.platforms["darwin-arm64"] })],
    ["an entry's key", (p, name) => ((p.platforms["darwin-arm64"] ?? {})[name] = 1)],
  ];
  const escaped = (text: string) => text.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

  describe.each(SITES)("a name from the file as %s", (_, put) => {
    it.each([
      ["a line separator", "a\u2028::error::x"],
      ["a next-line control", "a\u0085::error::x"],
      ["a C1 control sequence introducer", "a\u009b2J"],
      ["a right-to-left override", "a\u202e::error::x"],
      ["a delete", "a\u007f::error::x"],
      ["two of them", "a\u2028\u2028::error::x"],
      ["an astral character", "a\u{1f600}b"],
    ])("a refusal shows %s from the file as escapes, so no terminal or log viewer acts on it", async (_, name) => {
      const pin = await pinWith((p) => put(p, name));

      expect(() => parseNodeRuntime(pin)).toThrow(`"${escaped(name)}"`);
      expect(() => parseNodeRuntime(pin)).toThrow(expect.objectContaining({ message: expect.stringMatching(/^[\x20-\x7e]+$/) }));
    });

    it("a refusal names three names all, with no count", async () => {
      const pin = await pinWith((p) => {
        for (const name of ["k1", "k2", "k3"]) put(p, name);
      });

      expect(() => parseNodeRuntime(pin)).toThrow(expect.objectContaining({ message: expect.stringMatching(/"k1", "k2", "k3"$/) }));
    });

    it("a refusal names at most three names, then how many more there are", async () => {
      const pin = await pinWith((p) => {
        for (const name of ["k1", "k2", "k3", "k4", "k5"]) put(p, name);
      });

      expect(() => parseNodeRuntime(pin)).toThrow(expect.objectContaining({ message: expect.stringMatching(/"k1", "k2", "k3" and 2 more$/) }));
    });

    it("a refusal cuts a long name to its first 64 characters, so it stays short whatever the file holds", async () => {
      const pin = await pinWith((p) => put(p, "\u2028".repeat(100_000)));

      expect(() => parseNodeRuntime(pin)).toThrow(`"${"\\u2028".repeat(64)}..."`);
      expect(() => parseNodeRuntime(pin)).toThrow(expect.objectContaining({ message: expect.stringMatching(/^.{1,600}$/) }));
    });
  });

  it("the pin reads only its own fields, never ones it inherits", async () => {
    const pin = await pinWith(() => undefined);
    const entry = (pin as { platforms: Record<string, Record<string, unknown>> }).platforms["darwin-arm64"] ?? {};
    const inheritedEntry = await pinWith((p) => {
      p.platforms["darwin-arm64"] = Object.assign(Object.create({ archive: entry.archive }) as Record<string, unknown>, { archiveSha256: entry.archiveSha256, binarySha256: entry.binarySha256 });
    });

    expect(() => parseNodeRuntime(Object.create(pin as object))).toThrow(/exact Node version/);
    expect(() => parseNodeRuntime(inheritedEntry)).toThrow(/darwin-arm64 archive/);
  });

  /** A checkout whose pin file is the repo's, changed by `change`. */
  async function pinFile(change: (text: string) => string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pin-"));
    await mkdir(join(root, "scripts", "delivery"), { recursive: true });
    await writeFile(join(root, "scripts", "delivery", "node-runtime.json"), change(await readFile(`${repo}scripts/delivery/node-runtime.json`, "utf8")));
    return root;
  }

  it.each([
    ["a duplicate key, whose last value would win", (text: string) => text.replace('"binarySha256": "', '"binarySha256": "' + "f".repeat(64) + '",\n      "binarySha256": "')],
    ["compact JSON", (text: string) => `${JSON.stringify(JSON.parse(text))}\n`],
    ["no trailing newline", (text: string) => text.trimEnd()],
    ["CRLF line endings", (text: string) => text.replace(/\n/g, "\r\n")],
    ["an escaped key", (text: string) => text.replace('"version"', '"\\u0076ersion"')],
    ["a value nested too deep to write back", (text: string) => text.replace('"version"', `"deep": ${"[".repeat(100_000)}${"]".repeat(100_000)},\n  "version"`)],
  ])("readNodeRuntime refuses a pin file that is not in its canonical form: %s", async (_, change) => {
    await expect(readNodeRuntime(await pinFile(change))).rejects.toThrow(
      /^node-runtime\.json is not in its canonical form \(2-space JSON, LF line endings, one trailing newline, no duplicate or escaped keys\)$/,
    );
  });

  it("readNodeRuntime refuses a pin file with a byte-order mark as not JSON", async () => {
    await expect(readNodeRuntime(await pinFile((text) => `\ufeff${text}`))).rejects.toThrow(/^node-runtime\.json is not JSON$/);
  });

  it("readNodeRuntime refuses a pin file that is a symbolic link, whose diff would show only its target", async () => {
    const elsewhere = await pinFile((text) => text);
    const root = await mkdtemp(join(tmpdir(), "pin-"));
    await mkdir(join(root, "scripts", "delivery"), { recursive: true });
    await symlink(join(elsewhere, "scripts", "delivery", "node-runtime.json"), join(root, "scripts", "delivery", "node-runtime.json"));

    await expect(readNodeRuntime(root)).rejects.toThrow(/^scripts\/delivery\/node-runtime\.json is not a regular file$/);
  });

  it("a refusal stays one line: a platform name from the file is quoted as JSON, so a newline in it cannot start a line", async () => {
    const pin = await pinWith((p) => (p.platforms["x\n::error title=pin::injected"] = { ...p.platforms["darwin-arm64"] }));

    expect(() => parseNodeRuntime(pin)).toThrow(expect.objectContaining({ message: expect.not.stringContaining("\n") }));
    expect(() => parseNodeRuntime(pin)).toThrow('"x\\n::error title=pin::injected"');
  });

  it.each([
    ["is not JSON", "{ not json", /^node-runtime\.json is not JSON$/],
    ["is not an object", "[]\n", /^node-runtime\.json is not an object$/],
  ])("readNodeRuntime refuses a pin file that %s", async (_, text, why) => {
    const root = await mkdtemp(join(tmpdir(), "pin-"));
    await mkdir(join(root, "scripts", "delivery"), { recursive: true });
    await writeFile(join(root, "scripts", "delivery", "node-runtime.json"), text);

    await expect(readNodeRuntime(root)).rejects.toThrow(why);
  });

  it("readNodeRuntime refuses a checkout without a pin file", async () => {
    await expect(readNodeRuntime(await mkdtemp(join(tmpdir(), "pin-")))).rejects.toThrow(/^scripts\/delivery\/node-runtime\.json cannot be read$/);
  });
});
