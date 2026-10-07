import type { Runner, RunResult } from "../../scripts/delivery/lib/run.mjs";

/** One recorded call: the argv after `gh`, and what went to its stdin. */
export type GhCall = { args: string[]; input: string };

export type Route = {
  /** Matched against the argv joined with single spaces. */
  match: RegExp;
  reply: (args: string[], input: string) => RunResult;
};

export const ok = (stdout: unknown): RunResult => ({
  code: 0,
  stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
  stderr: "",
});
/** What gh prints for a 404: the error body on stdout, and the status in its message. */
export const notFound = (): RunResult => ({
  code: 1,
  stdout: '{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}',
  stderr: "gh: Not Found (HTTP 404)\n",
});

/**
 * A stand-in for `gh`: each call goes to the first route whose pattern matches, and every call is recorded. A call no
 * route answers fails, so a test sees any request it did not expect.
 */
export function fakeGh(routes: Route[]): { gh: Runner; calls: GhCall[] } {
  const calls: GhCall[] = [];
  const gh: Runner = async (args, options = {}) => {
    const input = options.input ?? "";
    calls.push({ args, input });
    const route = routes.find((candidate) => candidate.match.test(args.join(" ")));
    if (route === undefined) return { code: 1, stdout: "", stderr: `fake gh: no route for ${args.join(" ")}` };
    return route.reply(args, input);
  };
  return { gh, calls };
}
