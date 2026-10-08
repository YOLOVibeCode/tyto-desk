import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LaunchAgents } from "@desk/core";
import { runArgv } from "./run.ts";
import { assertPathAllowed } from "./test-guard.ts";

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * The user's LaunchAgents (macOS): `~/Library/LaunchAgents/<label>.plist` (0644), loaded with `launchctl bootstrap
 * gui/<uid>` and unloaded with `launchctl bootout gui/<uid>/<label>`, argv with 10 s each.
 */
export class NodeLaunchAgents implements LaunchAgents {
  private readonly dir: string;
  private readonly uid: number;
  private readonly launchctl: string;

  constructor(input: { home: string; uid: number; launchctl?: string }) {
    this.dir = join(input.home, "Library", "LaunchAgents");
    this.uid = input.uid;
    this.launchctl = input.launchctl ?? "/bin/launchctl";
  }

  private path(label: string): string {
    if (!/^[A-Za-z0-9.-]+$/.test(label)) throw new RangeError(`not a LaunchAgent label: ${label}`);
    return join(this.dir, `${label}.plist`);
  }

  async installed(label: string): Promise<boolean> {
    const path = this.path(label);
    await assertPathAllowed(path);
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  async install(label: string, argv: readonly string[]): Promise<boolean> {
    const path = this.path(label);
    await assertPathAllowed(path);
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      `  <key>Label</key><string>${escapeXml(label)}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      ...argv.map((arg) => `    <string>${escapeXml(arg)}</string>`),
      "  </array>",
      "  <key>RunAtLoad</key><true/>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
    await mkdir(this.dir, { recursive: true });
    await writeFile(path, plist, { mode: 0o644 });
    const loaded = await runArgv(this.launchctl, ["bootstrap", `gui/${this.uid}`, path], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
    return loaded.code === 0;
  }

  async remove(label: string): Promise<boolean> {
    const path = this.path(label);
    await assertPathAllowed(path);
    await runArgv(this.launchctl, ["bootout", `gui/${this.uid}/${label}`], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
    await rm(path, { force: true });
    return true;
  }
}
