import { describe, expect, it } from "vitest";
import { GOOGLE_DOMAINS_SHA256, GOOGLE_SUPPORTED_DOMAINS, cookieDomains, cookiesFor, importableCookies, sha256Hex, type Cookie } from "../src/index.ts";

const NOW = 1_800_000_000;
const cookie = (domain: string, name = "session", extra: Partial<Cookie> = {}): Cookie => ({
  name,
  value: "v",
  domain,
  path: "/",
  expires: NOW + 3600,
  secure: true,
  httpOnly: false,
  sameSite: "Lax",
  ...extra,
});

describe("which cookies an import may move (docs/IMPLEMENTATION.md §14)", () => {
  it("the vendored Google domain list is the one pinned by sha256", () => {
    expect(sha256Hex(`${GOOGLE_SUPPORTED_DOMAINS.join("\n")}\n`)).toBe(GOOGLE_DOMAINS_SHA256);
  });

  it.each([".youtube.com", "www.youtube.com", ".google.co.uk", "accounts.google.co.uk", ".google.com", "mail.google.com"])(
    "cookie import never moves Google account cookies from youtube.com or google.co.uk: %s",
    (domain) => {
      expect(importableCookies([cookie(domain)], NOW)).toEqual([]);
    },
  );

  it.each(["SID", "HSID", "SSID", "APISID", "SAPISID", "LSID", "__Secure-1PSID", "__Secure-3PSIDTS", "__Host-GAPS-PSID"])(
    "cookie import drops Google account cookies by name on any domain: %s",
    (name) => {
      expect(importableCookies([cookie(".example.test", name)], NOW)).toEqual([]);
    },
  );

  it("a cookie on a domain that only ends like a Google one is kept", () => {
    const kept = [cookie(".notgoogle.com"), cookie(".myyoutube.com"), cookie("google.co.uk.example.test")];

    expect(importableCookies(kept, NOW)).toEqual(kept);
  });

  it("expired cookies are dropped and session cookies are kept", () => {
    const session = cookie(".example.test", "s", { expires: -1 });

    expect(importableCookies([cookie(".example.test", "old", { expires: NOW - 1 }), session], NOW)).toEqual([session]);
  });

  it("the picker shows each domain with its count, never a name or a value", () => {
    const domains = cookieDomains([cookie(".example.test", "a"), cookie("www.example.test", "b"), cookie(".other.test", "c")]);

    expect(domains).toEqual([
      { domain: "example.test", count: 2 },
      { domain: "other.test", count: 1 },
    ]);
  });

  it("the picker counts a subdomain under a parent domain that has cookies too, and alone otherwise", () => {
    expect(cookieDomains([cookie(".example.test", "a"), cookie("app.example.test", "b"), cookie("api.other.test", "c")])).toEqual([
      { domain: "api.other.test", count: 1 },
      { domain: "example.test", count: 2 },
    ]);
  });

  it("naming a domain chooses its cookies and its subdomains', and nothing else", () => {
    const cookies = [cookie(".example.test", "a"), cookie("app.example.test", "b"), cookie(".notexample.test", "c")];

    expect(cookiesFor(cookies, ["example.test"]).map((c) => c.name)).toEqual(["a", "b"]);
  });
});
