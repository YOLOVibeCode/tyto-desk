/**
 * Who listens on a TCP port on 127.0.0.1, and what that process is (docs/IMPLEMENTATION.md §3, §6.1 step 4). Adapter:
 * packages/node (`lsof` for the listener; `ps`, or `/proc/<pid>/exe` on Linux, for the image). `null` means unknown.
 */
export interface ListenerInfo {
  listenerPid(port: number): Promise<number | null>;
  /** The process's executable path and its argument line. */
  image(pid: number): Promise<{ exe: string; args: string } | null>;
}
