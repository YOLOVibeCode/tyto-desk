import type { Redactor } from "../ports/redactor.ts";

/**
 * The patterns Desk removes from anything it writes (§0 Security, §4.4): tokens and keys of the services an operator's
 * shell and pages hold, bearer and basic credentials, private keys, and `key=value` pairs whose name says secret.
 */
const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b([A-Za-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|session)[A-Za-z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
];

/** `Redactor` with Desk's patterns; each match becomes `[redacted]` (a named pair keeps its name). */
export class SecretRedactor implements Redactor {
  safe(text: string): string {
    let safe = text;
    for (const pattern of PATTERNS) {
      safe = safe.replace(pattern, (match: string, name?: string) => (typeof name === "string" && match.startsWith(name) ? `${name}=[redacted]` : "[redacted]"));
    }
    return safe;
  }
}
