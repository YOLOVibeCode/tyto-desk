/**
 * The user's LaunchAgents (docs/IMPLEMENTATION.md §3, §15.1): Desk's opt-in login agent runs `desk` at login. Adapter:
 * packages/node (the plist under `~/Library/LaunchAgents` through `TextFiles`, and `launchctl` argv; macOS only).
 */
export interface LaunchAgents {
  installed(label: string): Promise<boolean>;
  install(label: string, argv: readonly string[]): Promise<boolean>;
  remove(label: string): Promise<boolean>;
}
