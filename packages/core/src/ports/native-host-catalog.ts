/**
 * The native-host manifests a Chrome profile holds, by name (docs/IMPLEMENTATION.md §14: the main profile's, for
 * `desk import native-hosts`). Adapter: packages/chrome (`<profile>/NativeMessagingHosts/*.json`).
 */
export interface NativeHostCatalog {
  names(): Promise<string[]>;
}
