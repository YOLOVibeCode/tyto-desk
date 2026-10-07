/**
 * Stops another Desk process by its pid, as `desk quit --all` and a newer `desk` stop `desk watch` (docs/IMPLEMENTATION.md
 * §6.1 step 13, §6.3, §6.4). Never Chrome: Desk quits Chrome only through `BrowserLifecycle`. Adapter: packages/node.
 */
export interface ProcessSignals {
  /** Sends SIGTERM; `false` for pid 1, Desk's own pid, a pid that is not a positive integer, or a process that is gone. */
  terminate(pid: number): Promise<boolean>;
}
