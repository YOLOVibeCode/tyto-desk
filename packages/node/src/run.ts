import { execFile } from "node:child_process";

/** What a child process left: its exit code (127 when it could not start, 124 after its timeout) and its output. */
export type RunResult = { code: number; stdout: string; stderr: string };

/**
 * Runs `file` with an argv array, never a shell string, an explicit environment, a timeout, and a cap on its output
 * (docs/IMPLEMENTATION.md §0 Safety, §6.6). A non-zero exit is a result, not an exception.
 */
export function runArgv(
  file: string,
  args: readonly string[],
  options: { env: Readonly<Record<string, string>>; timeoutMs: number; maxBytes?: number; cwd?: string },
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        env: { ...options.env },
        encoding: "utf8",
        maxBuffer: options.maxBytes ?? 1024 * 1024,
        signal: AbortSignal.timeout(options.timeoutMs),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { code?: string | number };
        if (failure.name === "AbortError") resolve({ code: 124, stdout, stderr });
        else if (failure.code === "ENOENT" || failure.code === "EACCES") resolve({ code: 127, stdout, stderr });
        else resolve({ code: typeof failure.code === "number" ? failure.code : 1, stdout, stderr });
      },
    );
  });
}
