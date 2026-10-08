/**
 * A profile's `DevToolsActivePort` (docs/IMPLEMENTATION.md §14 step 2): the port and browser path Chrome writes while its
 * remote debugging is on. It survives a clean exit, so whoever reads it verifies the listener. Adapter: packages/chrome.
 */
export interface DevToolsPortFile {
  read(): Promise<{ port: number; path: string } | null>;
}
