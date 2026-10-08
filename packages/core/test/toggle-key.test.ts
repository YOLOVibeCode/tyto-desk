import { describe, expect, it } from "vitest";
import { newDeskConfig, setToggleKey } from "../src/index.ts";
import { MemoryConfigStore } from "../src/testing/index.ts";

const config = newDeskConfig({ home: "/Users/alex", platform: "darwin", chromePort: 9417, gatewayPort: 9583 });

describe("desk config toggle-key (docs/IMPLEMENTATION.md §10)", () => {
  it.each([["Command+Shift+Comma"], ["Ctrl+Shift+K"], ["Alt+Shift+T"]])("desk config toggle-key saves %s, a key Chrome accepts", async (key) => {
    const store = new MemoryConfigStore(config);

    const result = await setToggleKey({ config: store }, key);

    expect(result.code).toBe(0);
    expect((await store.load())?.panel.toggleKey).toBe(key);
  });

  it.each([["Shift+K"], ["K"], ["Ctrl+Alt+K"], ["Command+Shift"], ["Command+Banana"]])("desk config toggle-key refuses %s, which Chrome would refuse, and saves nothing", async (key) => {
    const store = new MemoryConfigStore(config);

    const result = await setToggleKey({ config: store }, key);

    expect(result.code).toBe(65);
    expect((await store.load())?.panel.toggleKey).toBe(config.panel.toggleKey);
  });

  it("desk config toggle-key without a config says to run desk first", async () => {
    expect((await setToggleKey({ config: new MemoryConfigStore(null) }, "Command+Shift+Comma")).code).toBe(69);
  });
});
