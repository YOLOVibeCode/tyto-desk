import { describe, expect, it } from "vitest";
import { TMUX_DESK_LINE, newDeskConfig, planPaneShell, type DeskConfig } from "../src/index.ts";
import { FakeLoginShell, FakeTmux, MemoryTextFiles } from "../src/testing/index.ts";

const home = "/Users/alex";
const config = newDeskConfig({ home, platform: "darwin", chromePort: 9417, gatewayPort: 9583 });
const parent = { HOME: home, USER: "alex", LOGNAME: "alex", SHELL: "/bin/bash", ANTHROPIC_API_KEY: "x" };

function plan(options: { config?: DeskConfig; shell?: string | null; files?: Record<string, string>; cwd?: string } = {}) {
  return planPaneShell({
    pane: "p_k2m9q3x7ab",
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    config: options.config ?? config,
    deskHome: `${home}/.desk`,
    home,
    parent,
    version: "0.3.0",
    tmux: new FakeTmux({ running: false }),
    files: new MemoryTextFiles(options.files ?? { [`${home}/.tmux.conf`]: `${TMUX_DESK_LINE}\n` }),
    loginShell: new FakeLoginShell(options.shell === undefined ? "/bin/zsh" : options.shell),
  });
}

describe("a pane's shell", () => {
  it("a pane starts the account's login shell with -l in the home directory, with the pane environment", async () => {
    const shell = await plan();

    expect(shell).toMatchObject({ file: "/bin/zsh", args: ["-l"], cwd: home, notice: null });
    expect(shell.env).toMatchObject({ HOME: home, TERM_PROGRAM: "Desk", TERM_PROGRAM_VERSION: "0.3.0", DESK_PANE: "p_k2m9q3x7ab" });
    expect(shell.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("a pane opened from another starts in the directory it was given", async () => {
    expect((await plan({ cwd: `${home}/Dev/tyto-desk` })).cwd).toBe(`${home}/Dev/tyto-desk`);
  });

  it("a pane starts the configured shell over the account's", async () => {
    const shell = await plan({ config: { ...config, terminal: { ...config.terminal, shell: "/opt/homebrew/bin/fish" } } });

    expect(shell.file).toBe("/opt/homebrew/bin/fish");
  });

  it("a pane starts /bin/sh when neither the config nor the account names a shell", async () => {
    expect((await plan({ shell: null })).file).toBe("/bin/sh");
  });

  it("a pane without the tmux line starts without the agent variables and tells its panel why", async () => {
    const shell = await plan({ files: {} });

    expect(shell.notice).toBe("tmux-line-missing");
    expect(shell.env.DESK_PANE).toBeUndefined();
  });
});
