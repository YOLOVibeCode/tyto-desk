import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DESK_EXTENSION_ID,
  FORBIDDEN_CHROME_SWITCHES,
  FORBIDDEN_CHROME_SWITCH_VALUES,
  extensionIdFromKey,
  nativeHostManifest,
} from "../packages/core/src/index.ts";
import {
  buildBundles,
  extensionManifestProblems,
  spelledForbiddenSwitches,
  undeclaredBundledPackages,
} from "../scripts/lib/build.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));

function spelled(text: string) {
  return spelledForbiddenSwitches([{ path: "x.js", text }], FORBIDDEN_CHROME_SWITCHES, FORBIDDEN_CHROME_SWITCH_VALUES);
}

/** packages/extension/manifest.json, parsed. */
async function manifest(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(`${repo}packages/extension/manifest.json`, "utf8")) as Record<string, unknown>;
}

const production = await buildBundles(repo);
const paths = production.bundles.map((bundle) => bundle.path);

describe("build", () => {
  it("the build bundles core for a neutral platform, the extension's worker and panel, and the runtime's desk.mjs", () => {
    expect(paths).toEqual(expect.arrayContaining(["core/index.js", "core/testing/index.js", "extension/sw.js", "extension/panel.js", "runtime/desk.mjs"]));
    expect(paths.filter((path) => path.startsWith("runtime/") && path !== "runtime/desk.mjs").every((path) => /^runtime\/chunks\/[^/]+\.mjs$/.test(path))).toBe(true);
  });

  it("no production module spells a forbidden Chrome switch", () => {
    expect(spelledForbiddenSwitches(production.bundles, FORBIDDEN_CHROME_SWITCHES, FORBIDDEN_CHROME_SWITCH_VALUES)).toEqual([]);
  });

  it.each([
    'args.push("--enable-automation");',
    "const a = ['-headless=new'];",
    'run("--remote-debugging-port=0")',
    'run("--enable-blink-features=CSSAnchorPositioning,AutomationControlled")',
    "const a = ['--password-store=basic'];",
  ])("the build refuses a bundle that spells %s", (text) => {
    expect(spelled(text)).toHaveLength(1);
  });

  it.each([
    "[`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`]",
    'run("--enable-blink-features=CSSAnchorPositioning", "--password-store=gnome-libsecret")',
  ])("the build accepts %s", (text) => {
    expect(spelled(text)).toEqual([]);
  });

  it("the id derived from the extension's manifest key is the id the host manifest allows", async () => {
    const id = extensionIdFromKey(String((await manifest()).key));

    expect(id).toBe(DESK_EXTENSION_ID);
    expect(JSON.parse(nativeHostManifest("/Users/alex/.desk")).allowed_origins).toEqual([`chrome-extension://${id}/`]);
    expect(extensionManifestProblems(await manifest(), DESK_EXTENSION_ID)).toEqual([]);
  });

  it("the build refuses a manifest whose key gives another id", async () => {
    const other = { ...(await manifest()), key: "dGVzdA==" };

    expect(extensionManifestProblems(other, DESK_EXTENSION_ID)).toEqual(["the manifest key gives jpignaibiiemhngfjkcpokkamffknabf, not the host manifest's " + DESK_EXTENSION_ID]);
  });

  it("the manifest declares the strict CSP and no external connections", async () => {
    const template = await manifest();

    expect(template.content_security_policy).toEqual({
      extension_pages:
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'",
    });
    expect(template.externally_connectable).toEqual({ ids: [], matches: [] });
    expect(template).not.toHaveProperty("web_accessible_resources");
    expect(template.permissions).toEqual(["sidePanel", "nativeMessaging", "debugger", "tabGroups"]);
  });

  it.each([
    ["web_accessible_resources", { web_accessible_resources: [{ resources: ["panel.html"], matches: ["<all_urls>"] }] }],
    ["externally_connectable left undeclared", { externally_connectable: undefined }],
    ["a CSP that lets pages connect out", { content_security_policy: { extension_pages: "script-src 'self'; connect-src *" } }],
  ])("the build refuses a manifest with %s", async (_label, change) => {
    expect(extensionManifestProblems({ ...(await manifest()), ...change }, DESK_EXTENSION_ID).length).toBeGreaterThan(0);
  });

  it("every package esbuild bundles into desk.mjs or the extension is a dependency, never a devDependency, of its workspace", async () => {
    expect(await undeclaredBundledPackages(repo, production.metafiles)).toEqual([]);
  });

  it.each([
    ["from its devDependencies", { devDependencies: { "@xterm/xterm": "6.0.0" } }, "devDependencies"],
    ["without declaring it", {}, "nothing"],
  ])("the dependency check flags a package a workspace bundles %s", async (_label, manifestFields, declared) => {
    const metafile = {
      inputs: {
        "packages/extension/src/panel.ts": { bytes: 1, imports: [{ path: "node_modules/@xterm/xterm/lib/xterm.mjs", kind: "import-statement" as const }] },
        "node_modules/@xterm/xterm/lib/xterm.mjs": { bytes: 1, imports: [] },
      },
      outputs: {},
    };
    const manifests = {
      "packages/extension/package.json": { name: "@desk/extension", ...manifestFields },
      "node_modules/@xterm/xterm/package.json": { name: "@xterm/xterm" },
    };

    expect(await undeclaredBundledPackages(repo, [{ name: "extension", metafile }], manifests)).toEqual([
      { bundle: "extension", importer: "@desk/extension", bundled: "@xterm/xterm", declaredIn: declared },
    ]);
  });

  it.each(["bufferutil", "utf-8-validate"])("the dependency check leaves out ws's optional %s, which ws tries and runs without", async (tried) => {
    const metafile = {
      inputs: {
        "node_modules/ws/lib/buffer-util.js": { bytes: 1, imports: [{ path: tried, kind: "require-call" as const, external: true }] },
      },
      outputs: {},
    };
    const manifests = { "node_modules/ws/package.json": { name: "ws", devDependencies: { [tried]: "1.0.0" } } };

    expect(await undeclaredBundledPackages(repo, [{ name: "runtime", metafile }], manifests)).toEqual([]);
  });

  it("the dependency check still flags any other external a dependency loads without declaring it", async () => {
    const metafile = {
      inputs: { "node_modules/ws/lib/buffer-util.js": { bytes: 1, imports: [{ path: "left-pad", kind: "require-call" as const, external: true }] } },
      outputs: {},
    };
    const manifests = { "node_modules/ws/package.json": { name: "ws" } };

    expect(await undeclaredBundledPackages(repo, [{ name: "runtime", metafile }], manifests)).toEqual([
      { bundle: "runtime", importer: "ws", bundled: "left-pad", declaredIn: "nothing" },
    ]);
  });

  it("the runtime bundle loads under Node, CommonJS dependencies and all, before it looks for its version.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runtime-"));
    for (const bundle of production.bundles.filter((entry) => entry.path.startsWith("runtime/"))) {
      const file = join(dir, bundle.path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bundle.text);
    }

    const ran = await promisify(execFile)(process.execPath, [join(dir, "runtime", "desk.mjs"), "--version"], {
      env: { PATH: dirname(process.execPath) },
      signal: AbortSignal.timeout(20_000),
    }).then(
      () => ({ code: 0, stderr: "" }),
      (failure: { code?: number; stderr?: string }) => ({ code: failure.code ?? -1, stderr: failure.stderr ?? "" }),
    );

    expect(ran.stderr).toMatch(/version\.json is missing or damaged/);
    expect(ran.code).toBe(70);
  });

  it("production builds drop deskTest, and the test build exposes it", async () => {
    const testBuild = await buildBundles(repo, { testHooks: true });
    const panel = (bundles: { path: string; text: string }[]) => bundles.find((bundle) => bundle.path === "extension/panel.js")?.text ?? "";

    expect(production.bundles.filter((bundle) => bundle.text.includes("deskTest")).map((bundle) => bundle.path)).toEqual([]);
    expect(panel(testBuild.bundles)).toContain("deskTest");
  });
});
