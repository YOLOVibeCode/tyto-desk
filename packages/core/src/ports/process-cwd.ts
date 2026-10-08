/**
 * The working directory of a process Desk started (docs/IMPLEMENTATION.md §10: new splits and tabs open where the
 * focused pane's shell is). Read from the process, never from what it printed (OSC 7). Adapter: packages/node
 * (`/proc/<pid>/cwd` on Linux, `lsof` on macOS).
 */
export interface ProcessCwd {
  /** The directory, or `null` when the process is gone or it cannot be read. */
  cwdOf(pid: number): Promise<string | null>;
}
