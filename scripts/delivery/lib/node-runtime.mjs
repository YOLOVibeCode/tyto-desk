/**
 * Desk Terminal's pinned Node (docs/IMPLEMENTATION.md §15.1, §23.6, D49): `scripts/delivery/node-runtime.json` names the
 * version and, per platform, nodejs.org's archive and the sha256 of the archive and of its `bin/node`. The runtime
 * build copies a Node binary only when its sha256 is the pinned one, and the stamp records the pinned version. It lives
 * under scripts/delivery/, an owner-merge path, with the stamp that reads it (D61).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** @typedef {{ archive: string; archiveSha256: string; binarySha256: string }} NodePin */
/** @typedef {{ version: string; platforms: Record<string, NodePin> }} NodeRuntime */

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The pin, checked: an exact `X.Y.Z` version and well-formed entries. A malformed pin throws: no build goes ahead on it.
 * @param {string} root the checkout
 * @returns {Promise<NodeRuntime>}
 */
export async function readNodeRuntime(root) {
  /** @type {unknown} */
  const json = JSON.parse(await readFile(join(root, "scripts", "delivery", "node-runtime.json"), "utf8"));
  if (typeof json !== "object" || json === null) throw new Error("node-runtime.json is not an object");
  const { version, platforms } = /** @type {Record<string, unknown>} */ (json);
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("node-runtime.json names no exact Node version");
  if (typeof platforms !== "object" || platforms === null) throw new Error("node-runtime.json has no platforms");
  /** @type {Record<string, NodePin>} */
  const checked = {};
  for (const [key, value] of Object.entries(platforms)) {
    const pin = /** @type {Record<string, unknown>} */ (value);
    if (
      typeof pin.archive !== "string" ||
      typeof pin.archiveSha256 !== "string" ||
      !HEX64.test(pin.archiveSha256) ||
      typeof pin.binarySha256 !== "string" ||
      !HEX64.test(pin.binarySha256)
    ) {
      throw new Error(`node-runtime.json's ${key} entry is malformed`);
    }
    checked[key] = { archive: pin.archive, archiveSha256: pin.archiveSha256, binarySha256: pin.binarySha256 };
  }
  return { version, platforms: checked };
}

/**
 * The pin for a platform and architecture, or `null` where Desk Terminal has none: darwin-arm64 for the Mac, and
 * linux-arm64 for the test container only.
 * @param {NodeRuntime} runtime
 * @param {string} platform
 * @param {string} arch
 * @returns {NodePin | null}
 */
export function nodePin(runtime, platform, arch) {
  return Object.hasOwn(runtime.platforms, `${platform}-${arch}`) ? (runtime.platforms[`${platform}-${arch}`] ?? null) : null;
}
