/**
 * Starts or reuses the Desk Chrome (docs/IMPLEMENTATION.md §14 step 6, through §6.1's launch) and gives its debugging
 * port and browser WebSocket, or `null` when it cannot. Adapter: packages/cli.
 */
export interface DeskBrowser {
  ensure(): Promise<{ port: number; wsUrl: string } | null>;
}
