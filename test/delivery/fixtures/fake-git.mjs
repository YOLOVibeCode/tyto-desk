#!/usr/bin/env node
// Stand-in for git in offline tests (Tyto's stub style). It appends its argv as a JSON line to FAKE_GIT_LOG and
// answers the few commands the stamp runs from FAKE_GIT_* variables:
//   FAKE_GIT_HEAD           what `rev-parse HEAD` prints (exit 128 when unset)
//   FAKE_GIT_BRANCH         what `symbolic-ref` prints (exit 1, detached, when unset)
//   FAKE_GIT_STATUS         `status --porcelain -z` output, with "|" standing for NUL
//   FAKE_GIT_STATUS_EXIT    the exit code of `status` (default 0; any other prints nothing)
//   FAKE_GIT_UNTRACKED      `ls-files --others -z` output, with "|" standing for NUL
//   FAKE_GIT_LS_FILES_EXIT  the exit code of `ls-files` (default 0; any other prints nothing)
//   FAKE_GIT_FETCH_EXIT     the exit code of `fetch` (default 0)
//   FAKE_GIT_ANCESTOR_EXIT  the exit code of `merge-base --is-ancestor` (default 0: an ancestor)
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_GIT_LOG) appendFileSync(process.env.FAKE_GIT_LOG, `${JSON.stringify(argv)}\n`);

const nul = (text) => (text ?? "").replaceAll("|", "\0");
const exitCode = (name, fallback) => Number(process.env[name] ?? fallback);

/** Prints `text` and exits 0, or fails with the exit code `name` gives, printing nothing. */
function answer(name, text) {
  const code = exitCode(name, 0);
  if (code !== 0) {
    process.stderr.write(`fatal: ${argv[0]} failed\n`);
    process.exit(code);
  }
  process.stdout.write(text);
}

switch (argv[0]) {
  case "rev-parse":
    if (process.env.FAKE_GIT_HEAD === undefined) {
      process.stderr.write("fatal: not a git repository\n");
      process.exit(128);
    }
    process.stdout.write(`${process.env.FAKE_GIT_HEAD}\n`);
    break;
  case "symbolic-ref":
    if (process.env.FAKE_GIT_BRANCH === undefined) process.exit(1);
    process.stdout.write(`${process.env.FAKE_GIT_BRANCH}\n`);
    break;
  case "status":
    answer("FAKE_GIT_STATUS_EXIT", nul(process.env.FAKE_GIT_STATUS));
    break;
  case "ls-files":
    answer("FAKE_GIT_LS_FILES_EXIT", nul(process.env.FAKE_GIT_UNTRACKED));
    break;
  case "fetch":
    process.exit(exitCode("FAKE_GIT_FETCH_EXIT", 0));
    break;
  case "merge-base":
    process.exit(exitCode("FAKE_GIT_ANCESTOR_EXIT", 0));
    break;
  default:
    process.stderr.write(`fake-git: unexpected command ${argv[0]}\n`);
    process.exit(2);
}
