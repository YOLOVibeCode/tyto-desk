/**
 * Owner-merge (docs/IMPLEMENTATION.md §23.1, D50): a pull request that touches an owner-merge path
 * (`scripts/delivery/owner-paths.json`), and the release PR, get the `owner-merge` label, lose their auto-merge, and get
 * one comment saying so; the owner merges them by hand after reading the diff. When no such path remains, the label
 * goes. `owner-merge.yml` runs the base branch's copy on `pull_request_target`, reading the pull request through the
 * API as data. Dependency-free: Node and gh only.
 */
import { ghJson, ghOk, pullRequestFiles } from "./gh.mjs";

/** @typedef {import("./run.mjs").Runner} Runner */
/** @typedef {{ paths: string[]; branches: string[] }} OwnerPaths */

export const LABEL = "owner-merge";
/** The comment's marker. Only a comment by the workflow's own bot counts. */
export const MARKER = "<!-- desk:owner-merge -->";
export const BOT = "github-actions[bot]";

/**
 * The owner-merge pattern `path` falls under, compared without case (macOS reads `claude.md` as `CLAUDE.md`).
 * @param {string} path
 * @param {readonly string[]} patterns
 * @returns {string | null}
 */
export function ownerPathOf(path, patterns) {
  const lower = path.toLowerCase();
  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    if (p.endsWith("/**") ? lower.startsWith(p.slice(0, -2)) : lower === p) return pattern;
  }
  return null;
}

/**
 * @param {{ files: readonly string[]; headRef: string; config: OwnerPaths }} pr
 * @returns {{ ownerMerge: boolean; reasons: string[] }} `reasons` are owner-path patterns, or "the release PR"
 */
export function ownerMergeDecision({ files, headRef, config }) {
  /** @type {Set<string>} */
  const reasons = new Set();
  if (config.branches.includes(headRef)) reasons.add("the release PR");
  for (const file of files) {
    const pattern = ownerPathOf(file, config.paths);
    if (pattern !== null) reasons.add(pattern);
  }
  return { ownerMerge: reasons.size > 0, reasons: [...reasons] };
}

/** @param {string[]} reasons */
function commentBody(reasons) {
  const what = reasons.map((reason) => (reason === "the release PR" ? reason : `\`${reason}\``)).join(", ");
  return [
    `This pull request is owner-merge (${what}): it changes the delivery pipeline or the agent rules, or it releases Desk,`,
    "so the owner reads its diff and merges it by hand (CONTRIBUTING; IMPLEMENTATION §23.1). Auto-merge is off and is",
    "turned off again whenever someone turns it on. Agents never merge it, turn its auto-merge on, or remove the label.",
    "",
    MARKER,
  ].join("\n");
}

/**
 * Reads the pull request through the API, decides, and labels, turns auto-merge off and comments once, or removes the
 * label.
 * @param {Runner} gh
 * @param {{ repository: string; number: number; headRef: string; config: OwnerPaths }} pr
 * @returns {Promise<{ ownerMerge: boolean; reasons: string[]; actions: string[] }>}
 */
export async function ownerMerge(gh, { repository, number, headRef, config }) {
  const { files } = await pullRequestFiles(gh, repository, number);
  const decision = ownerMergeDecision({ files, headRef, config });
  const pull = /** @type {{ auto_merge?: unknown; labels?: { name?: unknown }[] }} */ (
    (await ghJson(gh, ["api", "--method", "GET", `repos/${repository}/pulls/${number}`])) ?? {}
  );
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
  await ghJson(gh, ["api", "--method", "POST", `repos/${repository}/issues/${number}/labels`, "--input", "-"], {
    input: JSON.stringify({ labels: [LABEL] }),
  });
  actions.push("labeled it owner-merge");
  if (pull.auto_merge !== null && pull.auto_merge !== undefined) {
    await ghOk(gh, ["pr", "merge", String(number), "--repo", repository, "--disable-auto"]);
    actions.push("turned auto-merge off");
  }
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
      input: JSON.stringify({ body: commentBody(decision.reasons) }),
    });
    actions.push("commented");
  }
  return { ...decision, actions };
}
