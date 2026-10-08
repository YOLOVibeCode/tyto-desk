/** The account's login shell (docs/IMPLEMENTATION.md §3). Adapter: packages/node (the passwd entry). */
export interface LoginShell {
  /** The shell the account's passwd entry names, or `null` when it names none. */
  passwdShell(): Promise<string | null>;
  /**
   * The names a login, interactive shell exports, never their values (§15.3: `[shell, "-l", "-i", "-c", "env | cut -d= -f1"]`,
   * 10 s); `null` when it could not be run.
   */
  exportedNames(): Promise<readonly string[] | null>;
  /** Where a login shell finds `command` on its PATH (`command -v`), or `null`. */
  which(command: string): Promise<string | null>;
}
