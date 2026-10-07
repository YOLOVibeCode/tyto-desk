import type { HostChannel } from "./host-channel.ts";

/**
 * Opens native-messaging connections to the Desk host (docs/IMPLEMENTATION.md §3). Adapter: packages/extension
 * (`chrome.runtime.connectNative("com.noctusoft.desk")`). A worker's open connection keeps the worker alive.
 */
export interface HostConnector {
  open(): HostChannel;
}
