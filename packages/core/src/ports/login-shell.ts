/** The account's login shell (docs/IMPLEMENTATION.md §3). Adapter: packages/node (the passwd entry). */
export interface LoginShell {
  /** The shell the account's passwd entry names, or `null` when it names none. */
  passwdShell(): Promise<string | null>;
}
