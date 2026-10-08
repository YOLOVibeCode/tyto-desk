import { describe, expect, it } from "vitest";
import { restoreKeyWarning } from "../src/index.ts";

const DESK = "/Users/alex/.desk/agent-browser.json";

describe("desk cdp's restore-key warning (docs/IMPLEMENTATION.md §11)", () => {
  it("desk cdp warns when the caller's agent-browser config has a restore key", () => {
    expect(restoreKeyWarning({ callerAgentConfig: undefined, deskAgentConfig: DESK, userConfigKeys: ["restore", "headed"] })).toMatch(
      /^warning: ~\/\.agent-browser\/config\.json has "restore"/,
    );
  });

  it("desk cdp warns about the legacy sessionName key too", () => {
    expect(restoreKeyWarning({ callerAgentConfig: "/Users/alex/my.json", deskAgentConfig: DESK, userConfigKeys: ["sessionName"] })).toMatch(/"sessionName"/);
  });

  it.each([
    ["the caller uses Desk's config", { callerAgentConfig: DESK, userConfigKeys: ["restore"] }],
    ["the user's config has no restore key", { callerAgentConfig: undefined, userConfigKeys: ["headed"] }],
    ["there is no user config", { callerAgentConfig: undefined, userConfigKeys: null }],
  ])("desk cdp says nothing when %s", (_, input) => {
    expect(restoreKeyWarning({ deskAgentConfig: DESK, ...input })).toBeNull();
  });
});
