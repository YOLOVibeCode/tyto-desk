/**
 * The live suite's results on the Mac or the CI runner (docs/IMPLEMENTATION.md §17.3). They come out of the container
 * with `docker cp`, which keeps symbolic links as they are, so code in the container could leave a link to a file
 * outside the checkout for the runner, or an agent opening the results later, to read. The runner therefore checks the
 * whole tree before it reads anything, and reads its two files without following a link.
 */
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Every entry under `dir` that is not a plain file or directory (symbolic links, FIFOs, sockets, devices), as relative
 * paths in walk order. The walk never follows a link.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function unsafeResultEntries(dir) {
  /** @type {string[]} */
  const unsafe = [];
  /** @param {string} relative */
  const walk = async (relative) => {
    const entries = await readdir(join(dir, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (!entry.isFile()) unsafe.push(path);
    }
  };
  await walk("");
  return unsafe;
}

/**
 * A result file's text, or `null` when it is missing, a link, or not a regular file. It is opened with O_NOFOLLOW and
 * checked on the open descriptor, so a link swapped in after the check is never followed.
 * @param {string} path
 * @returns {Promise<string | null>}
 */
export async function readResultFile(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = /** @type {{ code?: string }} */ (err).code;
    if (code === "ENOENT" || code === "ELOOP" || code === "EMLINK" || code === "ENXIO") return null;
    throw err;
  }
  try {
    if (!(await file.stat()).isFile()) return null;
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
