/**
 * The argv runner every delivery script uses for git and gh (docs/IMPLEMENTATION.md §0 safety): an argv array, never a
 * shell string; an explicit environment; an AbortSignal timeout; capped output. A non-zero exit is a result, not an
 * exception, and so are a missing executable and a timeout (code -1).
 */
import { spawn } from "node:child_process";

/** @typedef {{ code: number; stdout: string; stderr: string }} RunResult */
/** @typedef {{ input?: string; timeoutMs?: number }} RunOptions */
/** @typedef {(args: string[], options?: RunOptions) => Promise<RunResult>} Runner */

/** The most output one call may return; more is a failed call. */
export const OUTPUT_CAP = 64 * 1024 * 1024;

/**
 * @param {string[]} command the executable and any leading arguments, e.g. `["git"]` or `[node, "fake-git.mjs"]`
 * @param {{ cwd?: string; env: Record<string, string>; timeoutMs: number }} options
 * @returns {Runner}
 */
export function argvRunner(command, options) {
  const [file, ...prefix] = command;
  if (file === undefined) throw new Error("argvRunner needs an executable");
  return (args, call = {}) =>
    new Promise((resolve) => {
      const signal = AbortSignal.timeout(call.timeoutMs ?? options.timeoutMs);
      /** @type {Buffer[]} */
      const out = [];
      /** @type {Buffer[]} */
      const err = [];
      let size = 0;
      let settled = false;
      /** @param {RunResult} result */
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const child = spawn(file, [...prefix, ...args], {
        cwd: options.cwd,
        env: options.env,
        signal,
        stdio: ["pipe", "pipe", "pipe"],
      });
      /** @param {Buffer[]} chunks @returns {(chunk: Buffer) => void} */
      const collect = (chunks) => (chunk) => {
        size += chunk.length;
        if (size > OUTPUT_CAP) {
          child.kill("SIGKILL");
          finish({ code: -1, stdout: "", stderr: `${file}: output over ${OUTPUT_CAP} bytes` });
          return;
        }
        chunks.push(chunk);
      };
      child.stdout.on("data", collect(out));
      child.stderr.on("data", collect(err));
      child.on("error", (error) => {
        const reason = signal.aborted ? "timed out" : error.message;
        finish({ code: -1, stdout: "", stderr: `${file}: ${reason}` });
      });
      child.on("close", (code) => {
        finish({
          code: code ?? -1,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(call.input ?? "");
    });
}

/**
 * The variables a child process gets from `env`: only `names` that are set, plus `extra`. Never the whole environment.
 * @param {Record<string, string | undefined>} env
 * @param {readonly string[]} names
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function pickEnv(env, names, extra = {}) {
  /** @type {Record<string, string>} */
  const picked = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) picked[name] = value;
  }
  return { ...picked, ...extra };
}
