import type { PathMode, PathModes } from "../ports/path-modes.ts";

/** Paths and their modes as the test sets them; any other path does not exist. */
export class FakePathModes implements PathModes {
  readonly paths = new Map<string, PathMode>();

  async stat(path: string): Promise<PathMode | null> {
    return this.paths.get(path) ?? null;
  }
}
