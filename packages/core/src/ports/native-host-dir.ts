/**
 * The Desk profile's `NativeMessagingHosts` directory (docs/IMPLEMENTATION.md §3, §8), which only the Desk Chrome reads.
 * Adapter: packages/chrome. Files are `<name>.json`, 0600, written atomically.
 */
export interface NativeHostDir {
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
  /** Removes a manifest; nothing when there is none. */
  remove(name: string): Promise<void>;
}
