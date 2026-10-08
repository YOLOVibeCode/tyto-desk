/** Removes a directory and everything in it, never following a link out of it (§15.4). Adapter: packages/node. */
export interface TreeRemover {
  remove(path: string): Promise<void>;
}
