import { describe, expect, it } from "vitest";
import { importNativeHost, parseInstalled, sha256Hex } from "../src/index.ts";
import {
  FakeCodeSigning,
  FakeNativeHostCatalog,
  MemoryLogSink,
  MemoryNativeHostDir,
  MemoryOperatorOutput,
  MemoryTextFiles,
  ScriptedPrompter,
} from "../src/testing/index.ts";

const deskHome = "/Users/alex/.desk";
const ONEPASSWORD = "com.1password.1password";
const manifest = (name: string, path: string, origins: string[]) => JSON.stringify({ name, description: "x", path, type: "stdio", allowed_origins: origins });
const OP_MANIFEST = manifest(ONEPASSWORD, "/Applications/1Password.app/Contents/Library/LoginItems/1Password Browser Helper.app/Contents/MacOS/1Password-BrowserSupport", [
  "chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/",
]);

function setup(options: { answers?: (boolean | "no-tty")[] } = {}) {
  const catalog = new FakeNativeHostCatalog([ONEPASSWORD, "com.noctusoft.desk", "com.example.helper"]);
  const mainHosts = new MemoryNativeHostDir();
  mainHosts.manifests.set(ONEPASSWORD, OP_MANIFEST);
  mainHosts.manifests.set("com.noctusoft.desk", manifest("com.noctusoft.desk", "/Users/alex/.desk/bin/desk-nmhost", ["chrome-extension://abc/"]));
  mainHosts.manifests.set("com.example.helper", manifest("com.example.helper", "/usr/local/bin/helper", ["chrome-extension://def/"]));
  const deskHosts = new MemoryNativeHostDir();
  const signing = new FakeCodeSigning();
  signing.teams.set("/Applications/1Password.app/Contents/Library/LoginItems/1Password Browser Helper.app/Contents/MacOS/1Password-BrowserSupport", "2BUA8C4S2C");
  const files = new MemoryTextFiles({ [`${deskHome}/installed.json`]: JSON.stringify({ version: 1, current: "0.4.0", previous: null, versions: {}, files: [] }) });
  const prompter = new ScriptedPrompter(options.answers ?? [true]);
  const out = new MemoryOperatorOutput();
  const audit = new MemoryLogSink();
  const run = (host: string) => importNativeHost({ catalog, mainHosts, deskHosts, signing, files, prompter, out, audit }, { deskHome, host });
  return { catalog, mainHosts, deskHosts, signing, files, prompter, out, audit, run };
}

describe("desk import native-hosts (docs/IMPLEMENTATION.md §14)", () => {
  it("native host import shows each host's program, signer and allowed origins", async () => {
    const desk = setup();

    await desk.run(ONEPASSWORD);

    const shown = desk.out.lines.join("\n");
    expect(shown).toContain(`${ONEPASSWORD}: /Applications/1Password.app/`);
    expect(shown).toContain("signed by team 2BUA8C4S2C");
    expect(shown).toContain("chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/");
    expect(shown).toContain("com.example.helper: /usr/local/bin/helper (not signed by a team)");
  });

  it("native host import copies only the named host and never com.noctusoft.desk", async () => {
    const desk = setup();

    const result = await desk.run(ONEPASSWORD);
    const refused = await setup().run("com.noctusoft.desk");

    expect(result.code).toBe(0);
    expect(desk.deskHosts.writes).toEqual([ONEPASSWORD]);
    expect(desk.deskHosts.manifests.get(ONEPASSWORD)).toBe(OP_MANIFEST);
    expect(refused.code).toBe(65);
    expect(desk.out.lines.join("\n")).not.toContain("com.noctusoft.desk:");
  });

  it("the copy is recorded in installed.json with its sha256, keeping the keys install wrote", async () => {
    const desk = setup();

    await desk.run(ONEPASSWORD);

    expect(parseInstalled((await desk.files.read(`${deskHome}/installed.json`)) ?? "")?.files).toEqual([{ kind: "native-host", name: ONEPASSWORD, sha256: sha256Hex(OP_MANIFEST) }]);
  });

  it("a host the main Chrome does not have is refused, and nothing is copied", async () => {
    const desk = setup();

    const result = await desk.run("com.nowhere.host");

    expect(result.code).toBe(65);
    expect(desk.deskHosts.writes).toEqual([]);
  });

  it("declining copies nothing and exits 77; without a TTY nothing is copied and it exits 64", async () => {
    const declined = setup({ answers: [false] });
    const noTty = setup({ answers: ["no-tty"] });

    expect((await declined.run(ONEPASSWORD)).code).toBe(77);
    expect(declined.deskHosts.writes).toEqual([]);
    expect((await noTty.run(ONEPASSWORD)).code).toBe(64);
    expect(noTty.deskHosts.writes).toEqual([]);
  });

  it("every consent operation writes one audit line with counts and exit code only", async () => {
    const desk = setup();

    await desk.run(ONEPASSWORD);

    expect(desk.audit.events).toEqual([{ event: "consent", op: "import-native-host", listed: 2, copied: 1, code: 0 }]);
  });
});
