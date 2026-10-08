/**
 * Each live file's Chrome debugging port, from Desk's range (docs/IMPLEMENTATION.md §5); its Desk config takes the next
 * port for the guarded endpoint. One port per file means a Chrome that an earlier file failed to close can never answer
 * for this file's Chrome, and `startDeskChrome` refuses a port that already answers. The container has its own network
 * namespace, so nothing outside the suite holds these.
 */
export const LIVE_PORTS = {
  chrome: 9417,
  extension: 9427,
  agentBrowser: 9437,
  desk: 9447,
  persistence: 9457,
  gateway: 9467,
  focus: 9477,
  survive: 9497,
  terminal: 9507,
  reuse: 9517,
  watch: 9527,
  agents: 9547,
  install: 9557,
  update: 9567,
} as const;
