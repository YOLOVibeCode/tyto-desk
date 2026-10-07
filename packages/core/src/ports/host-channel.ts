/**
 * One native-messaging connection to `desk-nmhost` (docs/IMPLEMENTATION.md §3, §9). Adapter: packages/extension
 * (`chrome.runtime.Port`). Messages are JSON values; whatever arrives passes core's codecs before it is used.
 */
export interface HostChannel {
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** The host went away; `error` is Chrome's reason when it gave one. */
  onDisconnect(listener: (error: string | null) => void): void;
  disconnect(): void;
}
