// @ts-check
/**
 * A stand-in for tmux, codesign and the other programs Desk's Node adapters run, in Tyto's style
 * (docs/IMPLEMENTATION.md §3): a test writes a wrapper that runs it as `node fake-exec.mjs <scenario.json> <calls.log>
 * <argv…>`. It appends `{argv, env}` to the log as one JSON line, then answers with the scenario's first rule whose
 * `match` is a prefix of the argv: its `stdout`, `stderr` and `exit` (0 by default). With no rule, it exits 0 silently.
 */
import { appendFile, readFile } from "node:fs/promises";

const [scenarioPath = "", logPath = "", ...argv] = process.argv.slice(2);
/** @type {{ rules?: { match: string[]; stdout?: string; stderr?: string; exit?: number }[] }} */
const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
await appendFile(logPath, `${JSON.stringify({ argv, env: process.env })}\n`);
const rule = (scenario.rules ?? []).find((r) => r.match.every((word, i) => argv[i] === word));
if (rule?.stdout) process.stdout.write(rule.stdout);
if (rule?.stderr) process.stderr.write(rule.stderr);
process.exitCode = rule?.exit ?? 0;
