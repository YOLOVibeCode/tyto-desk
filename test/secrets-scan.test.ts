import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
];

async function checkout(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "secrets-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

async function scan(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout } = await run(process.execPath, [script, "--root", root]);
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
      const result = await scan(await checkout({ [path]: `token ${shapes[5]?.[1]}` }));

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
  ])("the secret scan passes %s", (_label, text) => {
    expect(secretRules(text)).toEqual([]);
  });
});
