import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { secretRules } from "../scripts/lib/secrets.mjs";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/check-secrets.mjs", import.meta.url));

/** Secret-shaped values, assembled at run time so this file never holds one. */
const shapes: Array<[string, string, string]> = [
  ["a private key", `-----BEGIN ${"RSA "}PRIVATE KEY-----`, "private-key-block"],
  ["an Anthropic key", `sk-${"ant-"}api03-${"Q".repeat(24)}`, "sk-prefix"],
  ["an API key assignment", `ANTHROPIC_${"API_KEY"}=${"q1".repeat(12)}`, "api-key-assignment"],
  ["a Set-Cookie value", `Set-${"Cookie"}: session=${"v".repeat(16)}`, "cookie-value"],
  ["a Google session cookie", `__Secure-${"1PSID"}=${"g".repeat(40)}`, "google-session-cookie"],
  ["a GitHub token", `gh${"p"}_${"A1".repeat(18)}`, "github-token"],
  ["a Slack token", `xox${"b"}-${"1234567890"}-abcdefghij`, "slack-token"],
  ["an AWS access key id", `AKIA${"ABCDEFGHIJKLMNOP"}`, "aws-access-key-id"],
  ["a 1Password service account token", `ops_${"eyJ"}${"x".repeat(30)}`, "onepassword-token"],
  ["a bearer token", `Authorization: ${"Bearer"} ${"t".repeat(24)}`, "bearer-token"],
  [
    "Google session cookies with 16-character values in a curl command",
    `curl -b 'H${"SID"}=A${"b".repeat(15)}; S${"SID"}=A${"c".repeat(15)}'`,
    "google-session-cookie",
  ],
  [
    "a Google session cookie in CDP's JSON",
    `{"name":"__Secure-${"1PSID"}","value":"g.a000${"F".repeat(40)}","domain":".google.com"}`,
    "google-session-cookie-json",
  ],
  [
    "a Google session cookie in JSON, value first",
    `{"value":"${"F".repeat(40)}","name":"SAP${"ISID"}"}`,
    "google-session-cookie-json",
  ],
  [
    "a Google session cookie in a chrome.cookies export",
    `{"domain":".google.com","hostOnly":false,"name":"${"SID"}","path":"/","secure":true,"value":"${"g".repeat(30)}"}`,
    "google-session-cookie-json",
  ],
];

const githubToken = shapes[5]?.[1] ?? "";

/** Git with no user or system configuration, so a test never runs the operator's hooks or signing. */
const gitEnv = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function git(root: string, args: string[]): Promise<void> {
  const identity = ["-c", "user.name=Desk Test", "-c", "user.email=desk-test@example.test", "-c", "init.defaultBranch=main"];
  await run("git", [...identity, ...args], { cwd: root, env: gitEnv });
}

async function checkout(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "secrets-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

async function scan(root: string, extra: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout } = await run(process.execPath, [script, "--root", root, ...extra], { env: gitEnv });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("secrets:scan", () => {
  it.each(shapes)("the secret scan finds %s", (_label, value, rule) => {
    expect(secretRules(`const x = "${value}";`)).toContain(rule);
  });

  it.each(["docs/CHECKLIST-results.md", "packages/core/test/fixture.test.ts", "README.md"])(
    "the secret scan covers %s, because no path is allowlisted",
    async (path) => {
      const result = await scan(await checkout({ [path]: `token ${githubToken}` }));

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${path}  [github-token]`);
    },
  );

  it("the secret scan names the file and rule, never the value", async () => {
    const value = shapes[2]?.[1] ?? "";
    const result = await scan(await checkout({ "src/x.ts": value }));

    expect(result.stderr).toContain("src/x.ts  [api-key-assignment]");
    expect(result.stderr + result.stdout).not.toContain(value.slice(-12));
  });

  it.each([
    ["placeholders", `ANTHROPIC_API_KEY=<your key>; ANTHROPIC_API_KEY=${"changeme"}-later-please`],
    ["names without values", "Never export ANTHROPIC_API_KEY. Google drops SID, HSID, SSID, APISID and SAPISID."],
    ["fake test values", 'ANTHROPIC_API_KEY: "fake"'],
    ["a cookie name in JSON with an empty value", '{"name":"SID","value":""}'],
  ])("the secret scan passes %s", (_label, text) => {
    expect(secretRules(text)).toEqual([]);
  });

  it("the staged secret scan reads the index, not the working tree", async () => {
    const root = await checkout({ "x.ts": `const t = "${githubToken}";\n` });
    await git(root, ["init", "-q"]);
    await git(root, ["add", "x.ts"]);
    await writeFile(join(root, "x.ts"), 'const t = "clean";\n');

    const result = await scan(root, ["--staged"]);

    expect([result.code, result.stderr]).toEqual([1, expect.stringContaining("x.ts  [github-token]")]);
  });

  it("the staged secret scan passes a secret that is only in the working tree, which the commit leaves out", async () => {
    const root = await checkout({ "x.ts": 'const t = "clean";\n' });
    await git(root, ["init", "-q"]);
    await git(root, ["add", "x.ts"]);
    await writeFile(join(root, "x.ts"), `const t = "${githubToken}";\n`);

    expect((await scan(root, ["--staged"])).code).toBe(0);
  });

  it("the staged secret scan covers a symlink replaced by a file", async () => {
    const root = await checkout({ "target.txt": "plain\n" });
    await symlink("target.txt", join(root, "x.ts"));
    await git(root, ["init", "-q"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-q", "--no-verify", "-m", "a symlink"]);
    await rm(join(root, "x.ts"));
    await writeFile(join(root, "x.ts"), `const t = "${githubToken}";\n`);
    await git(root, ["add", "x.ts"]);

    const result = await scan(root, ["--staged"]);

    expect([result.code, result.stderr]).toEqual([1, expect.stringContaining("x.ts  [github-token]")]);
  });
});
