import { build, type Plugin } from "esbuild";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkCoreSource, coreBoundaryViolations } from "../../../scripts/lib/core-boundary.mjs";

const core = fileURLToPath(new URL("..", import.meta.url));

describe("core purity", () => {
  it("core source imports no node: module, child_process, fs, net, http, WebSocket, node-pty, @xterm or chrome API", async () => {
    const violations = await coreBoundaryViolations(core);

    expect(violations.filter((v) => v.rule === "import")).toEqual([]);
  });

  it("core source uses no Buffer, process or require", async () => {
    const violations = await coreBoundaryViolations(core);

    expect(violations.filter((v) => v.rule === "global")).toEqual([]);
  });

  it("core bundles for a neutral platform without any Node builtin", async () => {
    const builtins = new Set(builtinModules);
    const reached: string[] = [];
    const recordBuiltins: Plugin = {
      name: "record-node-builtins",
      setup(bundle) {
        bundle.onResolve({ filter: /.*/ }, (args) => {
          if (args.path.startsWith("node:") || builtins.has(args.path.split("/")[0] ?? "")) reached.push(args.path);
          return undefined;
        });
      },
    };

    const result = await build({
      entryPoints: [join(core, "src/index.ts"), join(core, "src/testing/index.ts")],
      bundle: true,
      platform: "neutral",
      format: "esm",
      write: false,
      outdir: "out",
      logLevel: "silent",
      plugins: [recordBuiltins],
    });

    expect(reached).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.outputFiles).toHaveLength(2);
  });

  it.each([
    ['import { readFile } from "node:fs/promises";', "import"],
    ['import fs from "fs";', "import"],
    ['import { spawn } from "child_process";', "import"],
    ['export { connect } from "net";', "import"],
    ['const http = await import("http");', "import"],
    ["const name = 'os'; const os = await import(name);", "import"],
    ['import type { Stats } from "node:fs";', "import"],
    ['type Stats = import("node:fs").Stats;', "import"],
    ['import { WebSocket } from "ws";', "import"],
    ['const socket = new WebSocket("ws://127.0.0.1:9583");', "import"],
    ['import { spawn } from "node-pty";', "import"],
    ['import { spawn } from "@lydell/node-pty";', "import"],
    ['import { Terminal } from "@xterm/xterm";', "import"],
    ['chrome.runtime.connectNative("com.noctusoft.desk");', "import"],
    ["const api = globalThis.chrome;", "import"],
    ['const api = globalThis["chrome"];', "import"],
    ['const name = "chrome"; const api = globalThis[name];', "import"],
    ['await fetch("http://127.0.0.1:9417/json/version");', "import"],
    ['import { app } from "electron";', "import"],
    ['import { chromium } from "playwright-core";', "import"],
    ['import puppeteer from "puppeteer-core";', "import"],
    ['import Anthropic from "@anthropic-ai/sdk";', "import"],
    ['import OpenAI from "openai";', "import"],
    ['const bytes = Buffer.from("x");', "global"],
    ["const home = process.env.HOME;", "global"],
    ["const env = globalThis.process.env;", "global"],
    ['const fs = require("fs");', "global"],
    ["const dir = __dirname;", "global"],
    ["setImmediate(() => undefined);", "global"],
  ])("the core boundary lint flags %s", (source, rule) => {
    expect(checkCoreSource(source, "fixture.ts").map((v) => v.rule)).toContain(rule);
  });

  it.each([
    '// process.env, Buffer and require("fs") in a comment',
    'const text = "process.env, chrome.runtime and node:fs in a string";',
    "const ChromeProcess = 1; const pane = { process: 1, chrome: 2 }; pane.process; pane.chrome;",
    'import { sha256 } from "./bytes/sha256.ts";',
    'import type { PortProbe } from "../ports/port-probe.ts";',
  ])("the core boundary lint passes %s", (source) => {
    expect(checkCoreSource(source, "fixture.ts")).toEqual([]);
  });

  it("the core boundary lint names the file and line, never more of the source", () => {
    expect(checkCoreSource('\n\nimport fs from "fs";', "src/x.ts")).toEqual([
      { file: "src/x.ts", line: 3, rule: "import", detail: 'module "fs"' },
    ]);
  });
});
