import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A node_modules holding the PTY package and its platform package for `platform`-arm64, as npm installs them there, so
 * the test does not depend on which platform packages this machine has installed.
 */
export async function ptyPackages(platform: string): Promise<string> {
  const modules = await mkdtemp(join(tmpdir(), "node-modules-"));
  const files: Record<string, string> = {
    "@lydell/node-pty/package.json": '{"name":"@lydell/node-pty","version":"1.2.0-beta.15"}\n',
    "@lydell/node-pty/index.js": "module.exports = require(`@lydell/node-pty-${process.platform}-${process.arch}`);\n",
    [`@lydell/node-pty-${platform}-arm64/package.json`]: `{"name":"@lydell/node-pty-${platform}-arm64","version":"1.2.0-beta.15"}\n`,
    [`@lydell/node-pty-${platform}-arm64/prebuilds/${platform}-arm64/pty.node`]: "native module\n",
  };
  if (platform === "darwin") files["@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/spawn-helper"] = "#!/bin/sh\n";
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(modules, path, ".."), { recursive: true });
    await writeFile(join(modules, path), text);
  }
  if (platform === "darwin") await chmod(join(modules, "@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/spawn-helper"), 0o755);
  return modules;
}

