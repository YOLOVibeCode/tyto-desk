/**
 * Owner-merge (docs/IMPLEMENTATION.md §23.1, D50, D81): a pull request that touches an owner-merge path
 * (`scripts/delivery/owner-paths.json`), the release PR, and a pull request whose files the API did not list in full,
 * lose their auto-merge, get the `owner-merge` label, and get one comment saying so. The owner merges them after
 * reading the diff, or, except the release PR, the agent session acting for the owner does, by the owner's rule, which
 * the comment states in full (D81). When no such reason remains, the label goes. `owner-merge.yml` runs the base
 * branch's copy on `pull_request_target`, reading the pull request through the API as data. Dependency-free: Node and
 * gh only.
 */
import { ghJson, ghOk, pullRequestFiles } from "./gh.mjs";
import { ownerPathOf } from "./owner-paths.mjs";

/** @typedef {import("./run.mjs").Runner} Runner */
/** @typedef {import("./owner-paths.mjs").OwnerPaths} OwnerPaths */

export const LABEL = "owner-merge";
/** The comment's marker. Only a comment by the workflow's own bot counts. */
export const MARKER = "<!-- desk:owner-merge -->";
export const BOT = "github-actions[bot]";
/** The reason the release PR is owner-merge. */
const RELEASE_PR = "the release PR";

/**
 * Whether a pull request is owner-merge. The files API lists at most 3,000 files, and an owner-merge path can sort past
 * them, so a list that is empty or shorter than the pull request's `changed_files`, or a pull request that does not say
 * how many files it changes, is owner-merge too.
 * @param {{ files: readonly string[]; headRef: string; config: OwnerPaths; listed?: number; changedFiles?: number | null }} pr
 *   `listed` is how many entries the API listed (default: every file); `changedFiles` is the pull request's
 *   `changed_files` (default: `listed`), `null` when the API did not say
 * @returns {{ ownerMerge: boolean; reasons: string[] }} `reasons` are owner-path patterns, "the release PR", or why the
 *   file list cannot be trusted
 */
export function ownerMergeDecision({ files, headRef, config, listed = files.length, changedFiles = listed }) {
  /** @type {Set<string>} */
  const reasons = new Set();
  if (config.branches.includes(headRef)) reasons.add(RELEASE_PR);
  if (files.length === 0) reasons.add("the API listed no files");
  else if (changedFiles === null) reasons.add("the API did not say how many files the pull request changes");
  else if (listed < changedFiles) reasons.add(`the API listed only ${listed} of ${changedFiles} files`);
  for (const file of files) {
    const pattern = ownerPathOf(file, config.paths);
    if (pattern !== null) reasons.add(pattern);
  }
  return { ownerMerge: reasons.size > 0, reasons: [...reasons] };
}

/**
 * The owner's decision, in the owner's words: asked on 2026-10-07 who merges owner-merge PRs, the owner chose "Merge
 * after a security review (Recommended)" (D81).
 */
export const OWNER_DECISION =
  "I merge them with your gh login, but only after all checks pass AND a separate security-review agent reads the sensitive files' diff and signs off. A refusal stops the merge and I tell you why.";

/** Every condition under which the agent session acting for the owner merges an owner-merge PR (CONTRIBUTING rule 6, D81). */
const SESSION_RULE = [
  "1. Every check is green on the exact head SHA.",
  "2. At least two independent security-review agents, neither of them its author, each read the full diff of every owner-merge path it changes and posted a verdict comment, APPROVE or APPROVE_WITH_NITS, that names the full 40-character head SHA and lists the owner-merge files it read.",
  "3. Only verdict comments posted by the owner's GitHub login count (each comment's `user.login`): the repository is public, and anyone can post the same text.",
  "4. A REFUSE stops the merge, and the session tells the owner which review refused and why before doing anything else.",
  "5. A REFUSE keeps blocking, on its head and every later head, until a later approving review names each of its blocking reasons as resolved.",
  "6. The merge is `gh pr merge <n> --squash --match-head-commit <sha>`, never `--auto` or `--admin`. Only the operator runs `github-setup.mjs --apply`, and the release PR is never auto-merged.",
];

/** @param {string[]} reasons @param {readonly string[]} paths */
function commentBody(reasons, paths) {
  const what = reasons.map((reason) => (paths.includes(reason) ? `\`${reason}\`` : reason)).join(", ");
  const off = "Auto-merge is off and is turned off again whenever someone turns it on.";
  if (reasons.includes(RELEASE_PR)) {
    const text = [
      `This pull request is owner-merge (${what}).`,
      "Merging it releases Desk: only the owner marks it ready and merges it, by hand (RELEASING; IMPLEMENTATION §23.8).",
      "Agents never merge it, mark it ready, turn its auto-merge on, or remove the label.",
      off,
    ].join(" ");
    return `${text}\n\n${MARKER}`;
  }
  return [
    [
      `This pull request is owner-merge (${what}).`,
      "It changes the delivery pipeline, release code or the agent rules, or the API did not list all of its files.",
      off,
      "Agents never turn its auto-merge on or remove the label.",
    ].join(" "),
    [
      "The owner merges it after reading its diff, or the agent session acting for the owner merges it with the owner's gh login.",
      `The owner's decision (2026-10-07): "${OWNER_DECISION}"`,
      "The session merges only when all of these hold (CONTRIBUTING, rule 6; IMPLEMENTATION §23.1, D81):",
    ].join(" "),
    SESSION_RULE.join("\n"),
    MARKER,
  ].join("\n\n");
}

/**
 * Reads the pull request through the API, decides, and turns auto-merge off, labels and comments once, or removes the
 * label. Auto-merge goes off first, so a failure later leaves the pull request unable to merge itself.
 * @param {Runner} gh
 * @param {{ repository: string; number: number; headRef: string; config: OwnerPaths }} pr
 * @returns {Promise<{ ownerMerge: boolean; reasons: string[]; actions: string[] }>}
 */
export async function ownerMerge(gh, { repository, number, headRef, config }) {
  // The files first, then the pull request: a push in between shows as more changed files than listed, never fewer.
  const { files, listed } = await pullRequestFiles(gh, repository, number);
  const pull = /** @type {{ auto_merge?: unknown; labels?: { name?: unknown }[]; changed_files?: unknown }} */ (
    (await ghJson(gh, ["api", "--method", "GET", `repos/${repository}/pulls/${number}`])) ?? {}
  );
  const changedFiles = typeof pull.changed_files === "number" ? pull.changed_files : null;
  const decision = ownerMergeDecision({ files, headRef, config, listed, changedFiles });
  const labeled = (pull.labels ?? []).some((label) => label.name === LABEL);
  /** @type {string[]} */
  const actions = [];
  if (!decision.ownerMerge) {
    if (labeled) {
      await ghJson(gh, ["api", "--method", "DELETE", `repos/${repository}/issues/${number}/labels/${LABEL}`]);
      actions.push("removed the owner-merge label");
    }
    return { ...decision, actions };
  }
  if (pull.auto_merge !== null && pull.auto_merge !== undefined) {
    await ghOk(gh, ["pr", "merge", String(number), "--repo", repository, "--disable-auto"]);
    actions.push("turned auto-merge off");
  }
  await ghJson(gh, ["api", "--method", "POST", `repos/${repository}/issues/${number}/labels`, "--input", "-"], {
    input: JSON.stringify({ labels: [LABEL] }),
  });
  actions.push("labeled it owner-merge");
  const pages = await ghJson(gh, [
    "api",
    "--method",
    "GET",
    "--paginate",
    "--slurp",
    `repos/${repository}/issues/${number}/comments?per_page=100`,
  ]);
  const comments = Array.isArray(pages) ? pages.flat() : [];
  const commented = comments.some((comment) => {
    const { user, body } = /** @type {{ user?: { login?: unknown }; body?: unknown }} */ (comment ?? {});
    return user?.login === BOT && typeof body === "string" && body.includes(MARKER);
  });
  if (!commented) {
    await ghJson(gh, ["api", "--method", "POST", `repos/${repository}/issues/${number}/comments`, "--input", "-"], {
      input: JSON.stringify({ body: commentBody(decision.reasons, config.paths) }),
    });
    actions.push("commented");
  }
  return { ...decision, actions };
}
