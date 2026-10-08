import { rm } from "node:fs/promises";
import type { TreeRemover } from "@desk/core";
import { assertPathAllowed } from "./test-guard.ts";

/** `rm -r` without following links out of the tree (Node's `rm` removes a link, never its target), for uninstall. */
export class NodeTreeRemover implements TreeRemover {
  async remove(path: string): Promise<void> {
    await assertPathAllowed(path);
    await rm(path, { recursive: true, force: true });
  }
}
