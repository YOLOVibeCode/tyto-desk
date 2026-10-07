import { describe, expect, it } from "vitest";
import { NodeCodeSigning } from "../src/index.ts";
import { fakeExecutable } from "../../../test/fixtures/fake-exec.ts";

describe("NodeCodeSigning", () => {
  it("ad hoc signing runs codesign --force --sign - with the bundle's own identifier", async () => {
    const codesign = await fakeExecutable("codesign", []);

    const signed = await new NodeCodeSigning(codesign.path).adHocSign("/tmp/desk/Desk Terminal.app", "com.noctusoft.desk.terminal");

    expect(signed).toBe(true);
    expect((await codesign.calls()).map((call) => call.argv)).toEqual([
      ["--force", "--sign", "-", "--identifier", "com.noctusoft.desk.terminal", "--timestamp=none", "/tmp/desk/Desk Terminal.app"],
    ]);
  });

  it("verify runs codesign --verify --strict and reports its exit", async () => {
    const codesign = await fakeExecutable("codesign", [{ match: ["--verify"], stderr: "code object is not signed at all\n", exit: 1 }]);

    expect(await new NodeCodeSigning(codesign.path).verify("/tmp/desk/Desk Terminal.app")).toBe(false);
    expect((await codesign.calls())[0]?.argv).toEqual(["--verify", "--strict", "/tmp/desk/Desk Terminal.app"]);
  });
});
