import { WorkerController } from "@desk/core";
import { BrowserClock, ChromeHostConnector, ChromeSidePanel, ChromeWindows } from "./chrome-adapters.ts";
import { deskBuild } from "./desk-build.ts";

/**
 * The Desk extension's service worker (docs/IMPLEMENTATION.md §9): core's WorkerController over Chrome's APIs. Its own
 * native connection, opened at start, keeps it alive while Chrome runs.
 */
void new WorkerController({
  connector: new ChromeHostConnector(),
  sidePanel: new ChromeSidePanel(),
  windows: new ChromeWindows(),
  clock: new BrowserClock(),
  build: deskBuild(),
}).start();
