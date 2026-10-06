/**
 * Secret shapes that must never be committed to this public repo: code, docs and tests alike, with no path allowlist
 * (docs/IMPLEMENTATION.md §18). Complements gitleaks. Only rule names are ever reported, never matched text.
 */

/** @typedef {{ name: string; re: RegExp }} SecretPattern */

/** Google account session cookie names (the values Desk never moves and nobody commits). */
const GOOGLE_SESSION = String.raw`(?:__(?:Secure|Host)-[0-9A-Z]*PSID[A-Z]*|SAPISID|APISID|HSID|SSID|LSID|SID)`;

/** @type {SecretPattern[]} */
export const PATTERNS = [
  { name: "private-key-block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g },
  { name: "sk-prefix", re: /\bsk-(?:(?:ant-|proj-)[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})/g },
  {
    name: "api-key-assignment",
    re: /\b(?:DESK|TYTO|ANTHROPIC|OPENAI|GEMINI|GOOGLE)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\s*[=:]\s*['"]?(?!changeme|your-|xxx|fake|<)[A-Za-z0-9_-]{16,}/g,
  },
  { name: "cookie-value", re: /\b(?:Set-)?Cookie:\s*[^=\s;]+=[^;\s]{12,}/gi },
  {
    // HSID and SSID values are 17 characters long.
    name: "google-session-cookie",
    re: /(?:__(?:Secure|Host)-[0-9A-Z]*PSID[A-Z]*|\bSAPISID|\bAPISID|\bHSID|\bSSID|\bLSID|\bSID)=[A-Za-z0-9_./+%-]{16,}/g,
  },
  {
    // A JSON dump of cookies (CDP Storage.getCookies, a chrome.cookies export): name and value in one object, either
    // order, with other fields between them.
    name: "google-session-cookie-json",
    re: new RegExp(
      String.raw`"name"\s*:\s*"${GOOGLE_SESSION}"[^{}]{0,500}?"value"\s*:\s*"[^"]{16,}"` +
        String.raw`|"value"\s*:\s*"[^"]{16,}"[^{}]{0,500}?"name"\s*:\s*"${GOOGLE_SESSION}"`,
      "g",
    ),
  },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g },
  { name: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "onepassword-token", re: /\bops_eyJ[A-Za-z0-9_-]{20,}/g },
  { name: "bearer-token", re: /authorization:\s*bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi },
];

/**
 * Specific values that look like secrets but are fake or public, matched against the flagged text. Values, never
 * paths: a real secret in any file still fails the scan.
 * @type {RegExp[]}
 */
export const ALLOWED_VALUES = [];

/**
 * The names of the rules `text` breaks.
 * @param {string} text
 * @returns {string[]}
 */
export function secretRules(text) {
  /** @type {string[]} */
  const rules = [];
  for (const { name, re } of PATTERNS) {
    for (const match of text.matchAll(re)) {
      if (!ALLOWED_VALUES.some((allowed) => allowed.test(match[0]))) {
        rules.push(name);
        break;
      }
    }
  }
  return rules;
}
