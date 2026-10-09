import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/delivery/install.sh", import.meta.url));
const REPO = "YOLOVibeCode/tyto-desk";
const COMMIT = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const TARBALL = "desk-0.4.0-darwin-arm64.tar.gz";
// gzip: GNU tar runs it for -z (macOS's bsdtar decompresses itself); ln: the stub gh's link case.
const TOOLS = ["awk", "basename", "cat", "chmod", "cp", "grep", "gzip", "head", "ln", "mkdir", "mktemp", "od", "rm", "shasum", "tr", "wc"];
const MAIN = "9".repeat(40);
const TAG_OBJECT = "7".repeat(40);

/** Each call as one line, its arguments separated by US. */
const RECORD = `{ printf '%s\\037' "\${0##*/}" "$@"; printf '\\n'; } >> "$STUB_LOG"`;

const STUBS: Record<string, string> = {
  uname: `#!/bin/sh\ncase "$1" in -s) echo "$STUB_UNAME_S" ;; -m) echo "$STUB_UNAME_M" ;; esac\n`,
  gh: `#!/bin/sh
${RECORD}
# A gh told to ask another host or repo would answer for it: install.sh must never pass GH_HOST or GH_REPO on.
if [ -n "$GH_HOST$GH_REPO" ]; then echo "GH_HOST or GH_REPO reached gh" >&2; exit 3; fi
case "$1" in
  --version) echo "\${STUB_GH_PREFIX}gh version $STUB_GH_VERSION (2026-01-01)"; exit 0 ;;
  auth) exit "$STUB_GH_AUTH" ;;
  api)
    if [ -n "$STUB_API_FAIL" ]; then echo "$STUB_API_FAIL" >&2; exit 1; fi
    case "$2" in
      */git/ref/tags/*) echo "$STUB_TAG_REF"; exit 0 ;;
      */git/tags/*)
        # A tag object STUB_TAGS names answers with its file; any other, with STUB_PEELED or the commit.
        sha=\${2##*/}
        if [ -n "$STUB_TAGS" ] && [ -f "$STUB_TAGS/$sha" ]; then cat "$STUB_TAGS/$sha"; exit 0; fi
        echo "\${STUB_PEELED:-commit $STUB_COMMIT}"; exit 0 ;;
      */branches/main) echo "$STUB_MAIN"; exit 0 ;;
      */compare/*) echo "$STUB_COMPARE"; exit 0 ;;
    esac ;;
  release)
    case "$2" in
      download)
        if [ -n "$STUB_DOWNLOAD_FAIL" ]; then echo "$STUB_DOWNLOAD_FAIL" >&2; exit 1; fi
        dir=""; prev=""
        for arg in "$@"; do [ "$prev" = "--dir" ] && dir=$arg; prev=$arg; done
        cp "$STUB_RELEASE"/* "$dir"/
        if [ -n "$STUB_LINK_SUMS" ]; then rm "$dir/SHA256SUMS"; ln -s "$STUB_RELEASE/SHA256SUMS" "$dir/SHA256SUMS"; fi
        exit 0 ;;
      verify-asset) exit "$STUB_VERIFY_ASSET" ;;
    esac ;;
  attestation) exit "$STUB_ATTEST" ;;
esac
exit 1
`,
  tar: `#!/bin/sh
${RECORD}
if [ "$1" = "-tzf" ] && [ -n "$STUB_TAR_LIST" ]; then cat "$STUB_TAR_LIST"; exit 0; fi
if [ "$1" = "-tvzf" ] && [ -n "$STUB_TAR_VLIST" ]; then cat "$STUB_TAR_VLIST"; exit 0; fi
exec "$STUB_REAL_TAR" "$@"
`,
};

const DESK_NODE = `#!/bin/sh\n${RECORD}\nexit "\${STUB_DESK_EXIT:-0}"\n`;

type Ran = { code: number; stderr: string; calls: string[][]; /** TMPDIR for the run, where install.sh makes its own. */ tmp: string };

let tools = "";
let realTar = "";

function which(tool: string): string {
  return execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
}

/** A release dir holding the tarball (built by the real tar from `files`) and a SHA256SUMS that names it. */
async function release(
  files: Record<string, string>,
  options: { link?: boolean; sums?: (sha: string) => string | Buffer; raw?: string; mode?: Record<string, number>; readOnly?: string[] } = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "install-sh-release-"));
  const source = join(dir, "source");
  for (const [path, text] of Object.entries(files)) {
    const full = join(source, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, text);
    await chmod(full, options.mode?.[path] ?? 0o755);
  }
  if (options.link === true) await symlink("/etc", join(source, "desk-0.4.0", "etc"));
  for (const path of options.readOnly ?? []) await chmod(join(source, path), 0o555);
  const assets = join(dir, "assets");
  await mkdir(assets);
  if (options.raw === undefined) execFileSync(realTar, ["-czf", join(assets, TARBALL), "-C", source, "desk-0.4.0"]);
  else await writeFile(join(assets, TARBALL), options.raw);
  // The tarball keeps the read-only modes; the source gets its own back, so the suite's cleanup can remove it.
  for (const path of options.readOnly ?? []) await chmod(join(source, path), 0o755);
  const sha = createHash("sha256").update(await readFile(join(assets, TARBALL))).digest("hex");
  await writeFile(join(assets, "SHA256SUMS"), options.sums?.(sha) ?? `${sha}  ${TARBALL}\n`);
  return assets;
}

const RUNTIME = {
  "desk-0.4.0/version.json": "{}",
  "desk-0.4.0/desk.mjs": "",
  "desk-0.4.0/Desk Terminal.app/Contents/MacOS/desk-node": DESK_NODE,
};

async function run(input: {
  args?: string[];
  env?: Record<string, string>;
  assets?: string;
  stdin?: boolean;
  withGh?: boolean;
  cwd?: string;
  pathFirst?: string;
  /** DESK_GH as the stub's path relative to /, which names the stub once install.sh has gone to /. */
  relativeGh?: boolean;
}): Promise<Ran> {
  const dir = await mkdtemp(join(tmpdir(), "install-sh-"));
  const bin = join(dir, "bin");
  await mkdir(bin);
  for (const [name, text] of Object.entries(STUBS)) {
    if (name === "gh" && input.withGh === false) continue;
    await writeFile(join(bin, name), text);
    await chmod(join(bin, name), 0o755);
  }
  const log = join(dir, "calls.log");
  await writeFile(log, "");
  const env: Record<string, string> = {
    PATH: `${input.pathFirst === undefined ? "" : `${input.pathFirst}:`}${bin}:${tools}`,
    HOME: dir,
    TMPDIR: dir,
    STUB_LOG: log,
    STUB_REAL_TAR: realTar,
    STUB_UNAME_S: "Darwin",
    STUB_UNAME_M: "arm64",
    STUB_GH_VERSION: "2.102.0",
    STUB_GH_PREFIX: "",
    STUB_GH_AUTH: "0",
    STUB_API_FAIL: "",
    DESK_GH: input.relativeGh === true ? join(bin, "gh").replace(/^\/+/, "") : join(bin, "gh"),
    STUB_COMMIT: COMMIT,
    STUB_TAG_REF: `commit ${COMMIT}`,
    STUB_MAIN: MAIN,
    STUB_COMPARE: "ahead",
    STUB_RELEASE: input.assets ?? (await release(RUNTIME)),
    STUB_VERIFY_ASSET: "0",
    STUB_ATTEST: "0",
    STUB_TAR_LIST: "",
    STUB_TAR_VLIST: "",
    STUB_LINK_SUMS: "",
    STUB_DOWNLOAD_FAIL: "",
    STUB_TAGS: "",
    ...input.env,
  };
  const args = input.args ?? ["--version", "0.4.0"];
  const code = await new Promise<{ code: number; stderr: string }>((resolve) => {
    const child = execFile("/bin/bash", input.stdin === true ? ["-s", "--", ...args] : [SCRIPT, ...args], { env, timeout: 30_000, ...(input.cwd === undefined ? {} : { cwd: input.cwd }) }, (err, _stdout, stderr) => {
      resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stderr });
    });
    if (input.stdin === true) child.stdin?.end(execFileSync("/bin/cat", [SCRIPT]));
    else child.stdin?.end();
  });
  const calls = (await readFile(log, "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\u001f").slice(0, -1));
  return { ...code, calls, tmp: dir };
}

const named = (ran: Ran, name: string) => ran.calls.filter((call) => call[0] === name).map((call) => call.slice(1));
const extracted = (ran: Ran) => named(ran, "tar").some((argv) => argv[0] === "-xzf");

beforeAll(async () => {
  realTar = which("tar");
  tools = await mkdtemp(join(tmpdir(), "install-sh-tools-"));
  for (const tool of TOOLS) await symlink(which(tool), join(tools, tool));
});

describe("install.sh, the fresh-Mac installer (docs/IMPLEMENTATION.md §23.5)", () => {
  it("install.sh installs the version it was given: it runs that runtime's desk install with the release and its commit", async () => {
    const ran = await run({});

    expect(ran.code).toBe(0);
    const [node] = named(ran, "desk-node");
    expect(node?.[0]).toMatch(/\/desk-0\.4\.0\/desk\.mjs$/);
    expect(node?.slice(1)).toEqual(["install", "--from", node?.[0]?.replace(/\/desk\.mjs$/, ""), "--release", "0.4.0", "--commit", COMMIT]);
  });

  it("install.sh checks the tarball's provenance as desk update does: release.yml on the tag, its commit, no self-hosted runner", async () => {
    const ran = await run({});

    const gh = named(ran, "gh");
    expect(gh).toContainEqual(["api", `repos/${REPO}/git/ref/tags/v0.4.0`, "--jq", ".object.type + \" \" + .object.sha"]);
    expect(gh).toContainEqual(["api", `repos/${REPO}/branches/main`, "--jq", ".commit.sha"]);
    expect(gh).toContainEqual(["api", `repos/${REPO}/compare/${COMMIT}...${MAIN}`, "--jq", ".status"]);
    expect(gh.filter((argv) => argv[0] === "release" && argv[1] === "verify-asset").map((argv) => argv[3]?.split("/").pop())).toEqual([TARBALL, "SHA256SUMS"]);
    const attest = gh.find((argv) => argv[0] === "attestation");
    expect(attest?.slice(3)).toEqual([
      "--repo",
      REPO,
      "--cert-identity",
      `https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/v0.4.0`,
      "--source-ref",
      "refs/tags/v0.4.0",
      "--source-digest",
      COMMIT,
      "--deny-self-hosted-runners",
    ]);
  });

  it("install.sh peels an annotated tag to its commit", async () => {
    const ran = await run({ env: { STUB_TAG_REF: `tag ${TAG_OBJECT}` } });

    expect(ran.code).toBe(0);
    expect(named(ran, "gh")).toContainEqual(["api", `repos/${REPO}/git/tags/${TAG_OBJECT}`, "--jq", ".object.type + \" \" + .object.sha"]);
    expect(named(ran, "desk-node")[0]).toContain(COMMIT);
  });

  it("install.sh takes a commit that is main's head as on main, without asking compare", async () => {
    const ran = await run({ env: { STUB_MAIN: COMMIT, STUB_COMPARE: "diverged" } });

    expect(ran.code).toBe(0);
    expect(named(ran, "gh").filter((argv) => argv[1]?.includes("/compare/"))).toEqual([]);
  });

  it.each([
    ["Linux on arm64", { STUB_UNAME_S: "Linux" }],
    ["macOS on Intel", { STUB_UNAME_M: "x86_64" }],
  ])("install.sh refuses %s before it asks gh anything", async (_, env) => {
    const ran = await run({ env });

    expect(ran.code).toBe(65);
    expect(named(ran, "gh")).toEqual([]);
  });

  it.each([
    ["older than 2.102.0", { env: { STUB_GH_VERSION: "2.101.9" } }],
    ["of an older major version", { env: { STUB_GH_VERSION: "1.200.0" } }],
    ["one whose version line is not gh's own", { env: { STUB_GH_PREFIX: "not " } }],
    ["signed out", { env: { STUB_GH_AUTH: "1" } }],
    ["missing", { withGh: false }],
    ["named by a relative DESK_GH", { env: { DESK_GH: "gh" } }, "DESK_GH must be the absolute path of gh"],
  ])("install.sh refuses a gh that is %s (69) and downloads nothing", async (_, input, message?: string) => {
    const ran = await run(input);

    expect(ran.code).toBe(69);
    if (message !== undefined) expect(ran.stderr).toContain(message);
    expect(named(ran, "gh").filter((argv) => argv[0] === "api" || argv[0] === "release")).toEqual([]);
  });

  const zeros = "0".repeat(64);
  it.each<[string, { env?: Record<string, string>; sums?: (sha: string) => string | Buffer; raw?: string }, "download" | "tar"]>([
    ["the commit is not on main", { env: { STUB_COMPARE: "diverged" } }, "download"],
    ["the commit is ahead of main", { env: { STUB_COMPARE: "behind" } }, "download"],
    ["GitHub calls the commits identical but main's head is another", { env: { STUB_COMPARE: "identical" } }, "download"],
    ["the tag peels to a tag a third time", { env: { STUB_TAG_REF: `tag ${TAG_OBJECT}`, STUB_PEELED: `tag ${TAG_OBJECT}` } }, "download"],
    ["the tag's ref names more than a commit", { env: { STUB_TAG_REF: `commit ${COMMIT}0` } }, "download"],
    ["the tag's ref names no commit", { env: { STUB_TAG_REF: "tree " + "1".repeat(40) } }, "download"],
    ["GitHub names no head for main", { env: { STUB_MAIN: "" } }, "download"],
    ["the sha256 differs from SHA256SUMS", { sums: () => `${zeros}  ${TARBALL}\n` }, "tar"],
    ["SHA256SUMS names the tarball twice", { sums: (sha) => `${sha}  ${TARBALL}\n${zeros}  ${TARBALL}\n` }, "tar"],
    ["SHA256SUMS names the tarball twice, the right digest last", { sums: (sha) => `${zeros}  ${TARBALL}\n${sha}  ${TARBALL}\n` }, "tar"],
    ["SHA256SUMS names the tarball again on an indented line", { sums: (sha) => `${sha}  ${TARBALL}\n  ${zeros}  ${TARBALL}\r\n` }, "tar"],
    ["SHA256SUMS holds a byte-order mark, which core would trim", { sums: (sha) => `${sha}  ${TARBALL}\n\ufeff${zeros}  ${TARBALL}\n` }, "tar"],
    ["SHA256SUMS holds a no-break space, which core would trim", { sums: (sha) => `${sha}  ${TARBALL}\n\u00a0${zeros}  ${TARBALL}\n` }, "tar"],
    ["SHA256SUMS holds a NUL", { sums: (sha) => `${sha}  ${TARBALL}\u0000\n` }, "tar"],
    ["SHA256SUMS is longer than 4 KiB, in lines each short enough", { sums: (sha) => `${sha}  ${TARBALL}\n${`${"#".repeat(90)}\n`.repeat(60)}` }, "tar"],
    ["SHA256SUMS holds a byte that is not UTF-8, read in a UTF-8 locale", { env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }, sums: (sha) => Buffer.concat([Buffer.from(`${sha}  ${TARBALL}\n`), Buffer.from([0xff, 0x0a])]) }, "tar"],
    ["verify-asset refuses it", { env: { STUB_VERIFY_ASSET: "1" } }, "tar"],
    ["its provenance is refused", { env: { STUB_ATTEST: "1" } }, "tar"],
    ["the download is not gzip", { raw: "PK\u0003\u0004 a zip, not a gzip" }, "tar"],
  ])("install.sh verifies before tar reads anything it downloaded: when %s it exits 65", async (_, input, before) => {
    const assets =
      input.sums !== undefined ? await release(RUNTIME, { sums: input.sums }) : input.raw !== undefined ? await release(RUNTIME, { raw: input.raw }) : undefined;

    const ran = await run({ ...(input.env === undefined ? {} : { env: input.env }), ...(assets === undefined ? {} : { assets }) });

    expect(ran.code).toBe(65);
    expect(named(ran, "tar")).toEqual([]);
    expect(named(ran, "desk-node")).toEqual([]);
    if (before === "download") expect(named(ran, "gh").filter((argv) => argv[0] === "release" && argv[1] === "download")).toEqual([]);
  });

  it.each([
    ["outside desk-0.4.0/", "desk-0.4.0/\nother/evil\n"],
    ["that climbs out with ..", "desk-0.4.0/\ndesk-0.4.0/../../evil\n"],
    ["that is absolute", "desk-0.4.0/\n/etc/evil\n"],
  ])("install.sh refuses a tarball member %s and extracts nothing", async (_, listing) => {
    const list = join(await mkdtemp(join(tmpdir(), "install-sh-list-")), "members");
    await writeFile(list, listing);

    const ran = await run({ env: { STUB_TAR_LIST: list } });

    expect(ran.code).toBe(65);
    expect(extracted(ran)).toBe(false);
  });

  it("install.sh refuses a download that is not gzip before tar reads it", async () => {
    const ran = await run({ assets: await release(RUNTIME, { raw: "PK\u0003\u0004 a zip, not a gzip" }) });

    expect(ran.code).toBe(65);
    expect(named(ran, "tar")).toEqual([]);
  });

  it("install.sh runs from /, so a tool in the directory it was started from is never run, even with . first on PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "install-sh-cwd-"));
    const marker = join(dir, "ran");
    // uname is the first tool it runs, and tar the last.
    for (const tool of ["uname", "tar"]) {
      await writeFile(join(dir, tool), `#!/bin/sh\n: > ${marker}\nexit 1\n`);
      await chmod(join(dir, tool), 0o755);
    }

    const ran = await run({ cwd: dir, pathFirst: "." });

    expect(ran.code).toBe(0);
    expect(await readFile(marker, "utf8").then(() => true, () => false)).toBe(false);
  });

  it("install.sh refuses a download that is a symbolic link", async () => {
    const ran = await run({ env: { STUB_LINK_SUMS: "1" } });

    expect(ran.code).toBe(65);
    expect(named(ran, "tar")).toEqual([]);
  });

  it("install.sh refuses a DESK_GH that is set but empty, and never falls back to Homebrew's gh", async () => {
    const ran = await run({ env: { DESK_GH: "" } });

    expect(ran.code).toBe(69);
    expect(ran.stderr).toContain("DESK_GH must be the absolute path of gh");
  });

  it.each([
    ["a tab between the digest and the name", (sha: string) => `${sha}\t${TARBALL}\n`],
    ["one space only", (sha: string) => `${sha} ${TARBALL}\n`],
    ["a trailing field", (sha: string) => `${sha}  ${TARBALL} extra\n`],
  ])("install.sh reads SHA256SUMS as core does: a line with %s names nothing, and the download is refused", async (_, sums) => {
    const ran = await run({ assets: await release(RUNTIME, { sums }) });

    expect(ran.code).toBe(65);
    expect(extracted(ran)).toBe(false);
  });

  it("install.sh refuses a tarball whose listing shows a hard link, and extracts nothing", async () => {
    const list = join(await mkdtemp(join(tmpdir(), "install-sh-list-")), "verbose");
    await writeFile(list, "drwxr-xr-x  0 a a 0 Oct  7 12:00 desk-0.4.0/\n-rw-r--r--  0 a a 0 Oct  7 12:00 desk-0.4.0/a link to desk-0.4.0/b\n");

    const ran = await run({ env: { STUB_TAR_VLIST: list } });

    expect(ran.code).toBe(65);
    expect(extracted(ran)).toBe(false);
  });

  it.each([
    ["a FIFO", "prw-r--r--  0 a a 0 Oct  7 12:00 desk-0.4.0/fifo\n"],
    ["a character device", "crw-r--r--  0 a a 1,3 Oct  7 12:00 desk-0.4.0/null\n"],
    ["a block device", "brw-r--r--  0 a a 1,3 Oct  7 12:00 desk-0.4.0/disk\n"],
  ])("install.sh refuses a tarball whose listing shows %s, and extracts nothing", async (_, line) => {
    const list = join(await mkdtemp(join(tmpdir(), "install-sh-list-")), "verbose");
    await writeFile(list, `drwxr-xr-x  0 a a 0 Oct  7 12:00 desk-0.4.0/\n${line}`);

    const ran = await run({ env: { STUB_TAR_VLIST: list } });

    expect(ran.code).toBe(65);
    expect(ran.stderr).toContain("not a file or a directory");
    expect(extracted(ran)).toBe(false);
  });

  it.each([
    ["no desk-node", { "desk-0.4.0/version.json": "{}", "desk-0.4.0/desk.mjs": "" }, false],
    ["no desk.mjs", { "desk-0.4.0/version.json": "{}", "desk-0.4.0/Desk Terminal.app/Contents/MacOS/desk-node": DESK_NODE }, false],
    ["a desk-node that is not executable", RUNTIME, true],
  ])("install.sh refuses a tarball without a Desk runtime in it (%s) with 65 and runs nothing from it", async (_, files, notExecutable) => {
    const ran = await run({ assets: await release(files, notExecutable ? { mode: { "desk-0.4.0/Desk Terminal.app/Contents/MacOS/desk-node": 0o644 } } : {}) });

    expect(ran.code).toBe(65);
    expect(ran.stderr).toContain("holds no Desk runtime");
    expect(named(ran, "desk-node")).toEqual([]);
  });

  it("install.sh refuses a member under a sibling of desk-0.4.0/ whose name only starts the same", async () => {
    const list = join(await mkdtemp(join(tmpdir(), "install-sh-list-")), "members");
    await writeFile(list, "desk-0.4.0/\ndesk-0.4.0x/evil\n");

    const ran = await run({ env: { STUB_TAR_LIST: list } });

    expect(ran.code).toBe(65);
    expect(extracted(ran)).toBe(false);
  });

  it("install.sh passes desk install's own exit code on: 77 when you decline", async () => {
    const ran = await run({ env: { STUB_DESK_EXIT: "77" } });

    expect(named(ran, "desk-node")).toHaveLength(1);
    expect(ran.code).toBe(77);
  });

  it.each([
    ["it installs", {}],
    ["it refuses after downloading", { env: { STUB_VERIFY_ASSET: "1" } }],
  ])("install.sh removes its temporary directory when %s", async (_, input) => {
    const ran = await run(input);

    expect((await readdir(ran.tmp)).filter((name) => name.startsWith("desk-install."))).toEqual([]);
  });

  it("install.sh removes its temporary directory and keeps the exit code when the tarball holds a read-only directory", async () => {
    const files = { ...RUNTIME, "desk-0.4.0/locked/file": "x" };
    const ran = await run({ assets: await release(files, { readOnly: ["desk-0.4.0/locked"] }) });

    expect(ran.code).toBe(0);
    expect(ran.stderr).not.toContain("rm:");
    expect((await readdir(ran.tmp)).filter((name) => name.startsWith("desk-install."))).toEqual([]);
  });

  it("install.sh exits 75 when it cannot make its temporary directory, and downloads nothing", async () => {
    const ran = await run({ env: { TMPDIR: "/nonexistent-desk-tmp" } });

    expect(ran.code).toBe(75);
    expect(named(ran, "gh").filter((argv) => argv[0] === "api" || argv[0] === "release")).toEqual([]);
  });

  it.each([
    ["the release has no such assets", "no assets match the file pattern", 65],
    ["the download cannot reach GitHub", "error connecting to github.com", 75],
  ])("install.sh installs nothing when %s", async (_, failure, code) => {
    const ran = await run({ env: { STUB_DOWNLOAD_FAIL: failure } });

    expect(ran.code).toBe(code);
    expect(named(ran, "tar")).toEqual([]);
  });

  it("install.sh peels an annotated tag twice, and no further", async () => {
    const tags = await mkdtemp(join(tmpdir(), "install-sh-tags-"));
    const [t1, t2, t3] = ["a", "b", "c"].map((c) => c.repeat(40));
    await writeFile(join(tags, t1 ?? ""), `tag ${t2}\n`);
    await writeFile(join(tags, t2 ?? ""), `commit ${COMMIT}\n`);
    const twice = await run({ env: { STUB_TAG_REF: `tag ${t1}`, STUB_TAGS: tags } });
    await writeFile(join(tags, t2 ?? ""), `tag ${t3}\n`);
    await writeFile(join(tags, t3 ?? ""), `commit ${COMMIT}\n`);

    const thrice = await run({ env: { STUB_TAG_REF: `tag ${t1}`, STUB_TAGS: tags } });

    expect(twice.code).toBe(0);
    expect(thrice.code).toBe(65);
    expect(extracted(thrice)).toBe(false);
  });

  it.each([
    ["names a member outside desk-0.4.0/", "STUB_TAR_LIST", "desk-0.4.0/\nother/evil"],
    ["shows a FIFO", "STUB_TAR_VLIST", "drwxr-xr-x  0 a a 0 Oct  7 12:00 desk-0.4.0/\nprw-r--r--  0 a a 0 Oct  7 12:00 desk-0.4.0/fifo"],
  ])("install.sh reads the last line of a tarball listing with no newline: one that %s is refused", async (_, variable, listing) => {
    const list = join(await mkdtemp(join(tmpdir(), "install-sh-list-")), "listing");
    await writeFile(list, listing);

    const ran = await run({ env: { [variable]: list } });

    expect(ran.code).toBe(65);
    expect(extracted(ran)).toBe(false);
  });

  it("install.sh never reports success after a fatal shell error, which bash 3.2 would otherwise exit 0 on", async () => {
    // BASH_ENV (the operator's environment) makes mkdir a function that reads an unset variable: under set -u that is a
    // fatal error in the main shell, after a command that succeeded.
    const env = join(await mkdtemp(join(tmpdir(), "install-sh-env-")), "env.sh");
    await writeFile(env, 'mkdir() { : "${DESK_TEST_NEVER_SET}"; }\n');

    const ran = await run({ env: { BASH_ENV: env } });

    expect(ran.code).not.toBe(0);
    expect(named(ran, "desk-node")).toEqual([]);
  });

  it.each([
    ["names no member", "STUB_TAR_LIST"],
    ["shows no entry", "STUB_TAR_VLIST"],
  ])("install.sh refuses a tarball whose listing %s, and extracts nothing", async (_, variable) => {
    const list = join(await mkdtemp(join(tmpdir(), "install-sh-list-")), "empty");
    await writeFile(list, "");

    const ran = await run({ env: { [variable]: list } });

    expect(ran.code).toBe(65);
    expect(extracted(ran)).toBe(false);
  });

  it("install.sh refuses a SHA256SUMS line longer than 256 characters before it trims it", async () => {
    // Trimmed first, these 300 spaces and an x would be one short line.
    const ran = await run({ assets: await release(RUNTIME, { sums: (sha) => `${sha}  ${TARBALL}\n${" ".repeat(300)}x\n` }) });

    expect(ran.code).toBe(65);
    expect(ran.stderr).toContain("a line longer than 256 characters");
    expect(named(ran, "tar")).toEqual([]);
  });

  it("install.sh turns an exit of 0 before its last line into 70, on every bash", async () => {
    // BASH_ENV (the operator's environment) makes mkdir end the script with 0, long before desk install.
    const env = join(await mkdtemp(join(tmpdir(), "install-sh-env-")), "env.sh");
    await writeFile(env, "mkdir() { exit 0; }\n");

    const ran = await run({ env: { BASH_ENV: env } });

    expect(ran.code).toBe(70);
    expect(named(ran, "desk-node")).toEqual([]);
  });

  it("install.sh says in one line that no temporary directory could be made", async () => {
    const ran = await run({ env: { TMPDIR: "/nonexistent-desk-tmp" } });

    expect(ran.stderr.trim().split("\n").filter((line) => !line.startsWith("install.sh: using DESK_GH="))).toEqual([
      "install.sh: no temporary directory could be made; nothing was installed",
    ]);
  });

  it("install.sh reads a SHA256SUMS whose last line has no newline", async () => {
    const ran = await run({ assets: await release(RUNTIME, { sums: (sha) => `${sha}  ${TARBALL}` }) });

    expect(ran.code).toBe(0);
  });

  it("install.sh reads SHA256SUMS lines trimmed, as core does: CRLF line endings still name the tarball", async () => {
    const ran = await run({ assets: await release(RUNTIME, { sums: (sha) => `${sha}  ${TARBALL}\r\n` }) });

    expect(ran.code).toBe(0);
  });

  it("install.sh refuses a DESK_GH that is not executable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "install-sh-gh-"));
    await writeFile(join(dir, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });

    const ran = await run({ env: { DESK_GH: join(dir, "gh") } });

    expect(ran.code).toBe(69);
    expect(ran.stderr).toContain("DESK_GH must be the absolute path of gh");
  });

  it("install.sh never passes GH_HOST or GH_REPO on to gh", async () => {
    const ran = await run({ env: { GH_HOST: "ghe.example.test", GH_REPO: "someone/else" } });

    expect(ran.code).toBe(0);
  });

  it("install.sh refuses a relative DESK_GH even when it names a gh from /, and runs it never", async () => {
    const ran = await run({ relativeGh: true });

    expect(ran.code).toBe(69);
    expect(ran.stderr).toContain("DESK_GH must be the absolute path of gh");
    expect(named(ran, "gh")).toEqual([]);
  });

  it("install.sh refuses a tarball that holds a link and extracts nothing", async () => {
    const ran = await run({ assets: await release(RUNTIME, { link: true }) });

    expect(ran.code).toBe(65);
    expect(extracted(ran)).toBe(false);
  });

  it.each([
    ["it cannot reach GitHub", "error connecting to api.github.com", 75],
    ["GitHub has no such release", "HTTP 404: Not Found", 65],
  ])("install.sh installs nothing when %s", async (_, failure, code) => {
    const ran = await run({ env: { STUB_API_FAIL: failure } });

    expect(ran.code).toBe(code);
    expect(named(ran, "gh").filter((argv) => argv[0] === "release")).toEqual([]);
  });

  it.each([[[]], [["--version"]], [["--version", "v0.4.0"]], [["--version", "0.4"]], [["--version", "00.4.0"]], [["--version", "0.4.0\n1.0.0"]], [["--version", "0.4.0", "--version", "0.4.0"]]])(
    "install.sh %j is a usage error (64)",
    async (args) => {
      const ran = await run({ args });

      expect(ran.code).toBe(64);
      expect(ran.calls).toEqual([]);
    },
  );

  it("install.sh refuses to run through a pipe", async () => {
    const ran = await run({ stdin: true });

    expect(ran.code).toBe(64);
    expect(ran.calls).toEqual([]);
  });
});
