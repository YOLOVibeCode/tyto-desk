/** Keys that make agent-browser save or load state: `restore`, and `sessionName`, its legacy spelling (§11). */
const RESTORE_KEYS = ["restore", "sessionName"];

/**
 * `desk cdp`'s warning on stderr (§11): a CDP client started outside a Desk pane uses your own agent-browser config, and
 * one with a restore key would save the Desk Chrome's cookies into your saved state, or load yours into it. Keys are
 * read, never values; `null` when the caller already uses Desk's config, or there is nothing to warn about.
 */
export function restoreKeyWarning(input: {
  callerAgentConfig: string | undefined;
  deskAgentConfig: string;
  userConfigKeys: readonly string[] | null;
}): string | null {
  if (input.callerAgentConfig === input.deskAgentConfig || input.userConfigKeys === null) return null;
  const found = RESTORE_KEYS.filter((key) => input.userConfigKeys?.includes(key));
  if (found.length === 0) return null;
  return (
    `warning: ~/.agent-browser/config.json has ${found.map((key) => `"${key}"`).join(" and ")}, so agent-browser outside a Desk pane ` +
    "saves and loads browser state: pointed at Desk, it would carry the Desk Chrome's logins into your saved state. Run it " +
    "from a Desk pane, or with AGENT_BROWSER_CONFIG set to ~/.desk/agent-browser.json"
  );
}
