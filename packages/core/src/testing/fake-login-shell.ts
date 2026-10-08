import type { LoginShell } from "../ports/login-shell.ts";

/** An account whose passwd entry names `shell`; a login shell exports `names` and finds `commands` on its PATH. */
export class FakeLoginShell implements LoginShell {
  private readonly shell: string | null;
  names: readonly string[] | null = ["HOME", "PATH", "SHELL", "USER"];
  readonly commands = new Map<string, string>();

  constructor(shell: string | null) {
    this.shell = shell;
  }

  async passwdShell(): Promise<string | null> {
    return this.shell;
  }

  async exportedNames(): Promise<readonly string[] | null> {
    return this.names;
  }

  async which(command: string): Promise<string | null> {
    return this.commands.get(command) ?? null;
  }
}
