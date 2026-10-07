/**
 * The owner-merge rule (docs/IMPLEMENTATION.md §23.1, D81) as the owner decided it on 2026-10-07: asked "who merges
 * owner-merge PRs?", the owner chose "Merge after a security review (Recommended)": "I merge them with your gh login,
 * but only after all checks pass AND a separate security-review agent reads the sensitive files' diff and signs off. A
 * refusal stops the merge and I tell you why." Every place that states the rule (D81, §23.1, §20, CONTRIBUTING rule 6,
 * CLAUDE.md, AGENTS.md and owner-merge's comment) must say each of these, so no copy an agent obeys is weaker.
 */

/** The owner's own words, which every copy of the rule but §20's list of anti-patterns quotes. */
export const OWNER_WORDS =
  "I merge them with your gh login, but only after all checks pass AND a separate security-review agent reads the sensitive files' diff and signs off. A refusal stops the merge and I tell you why.";

/** Each condition of the rule, as [what it says, how the text must say it]. */
export const OWNER_MERGE_CONDITIONS: readonly (readonly [string, RegExp])[] = [
  ["(1) every check is green on the exact head SHA", /every check (?:is )?green on (?:the PR's |its |the )?exact head SHA/i],
  ["(2) at least two independent security-review agents", /at least two independent security-review agents/i],
  ["(2) none of them the PR's author", /(?:neither|none) of them (?:is )?(?:the PR's|its) author|not (?:the PR's|its) author/i],
  ["(2) each reads the full diff of every owner-merge path the PR changes", /full diff of every owner-merge path/i],
  ["(2) the verdict names the full 40-character head SHA", /full 40-character head SHA/i],
  ["(2) the verdict lists the owner-merge files the reviewer read", /list(?:s|ing) the owner-merge files (?:it|they) read/i],
  ["(3) only verdict comments by the owner's GitHub login count", /only verdict comments (?:posted )?(?:by|from|under) the owner's GitHub login count/i],
  ["(3) the session checks each comment's user.login", /user\.login/],
  ["(3) because the repository is public and anyone can post text", /anyone can post/i],
  ["(4) a REFUSE stops the merge", /REFUSE stops the merge/],
  ["(4) the session tells the owner which review refused and why", /tell(?:s|ing)? the owner which review refused and why/i],
  ["(4) before doing anything else", /before (?:doing )?anything else/i],
  ["(5) a REFUSE keeps blocking later heads", /REFUSE keeps blocking[^.;]*later head/i],
  ["(5) until a later approving review names each blocking reason as resolved", /later approving review names each of its blocking reasons as resolved/i],
  ["(6) the merge uses --match-head-commit", /--match-head-commit/],
  ["(6) never --admin", /never[^.;]*--admin/],
  ["(6) github-setup --apply stays operator-only", /only the operator runs github-setup(?:\.mjs)? --apply/i],
  ["(6) the release PR is never auto-merged", /release PR is never auto-merged/i],
];

/** Without Markdown's backticks, and line breaks and indentation as single spaces, so wrapped Markdown reads as one line. */
export function flatten(text: string): string {
  return text.replace(/`/g, "").replace(/\s+/g, " ");
}

/**
 * What `text` leaves out of the rule: the label of each condition it does not state, and the owner's words when
 * `quotes` is set.
 */
export function ruleGaps(text: string, { quotes = true }: { quotes?: boolean } = {}): string[] {
  const flat = flatten(text);
  const gaps = OWNER_MERGE_CONDITIONS.filter(([, pattern]) => !pattern.test(flat)).map(([label]) => label);
  return quotes && !flat.includes(OWNER_WORDS) ? ["the owner's words", ...gaps] : gaps;
}
