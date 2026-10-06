import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64Decode, extensionIdFromKey, sha256 } from "../src/index.ts";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Known Chrome extension ids. Keys from Chromium's source: chrome/browser/resources/pdf/manifest.json (id
 * kPdfExtensionId in extensions/common/constants.h), chrome/browser/resources/network_speech_synthesis/manifest.json
 * (the "Google Network Speech" component), and the vectors in components/crx_file/id_util_unittest.cc (its
 * kPublicKeyInfo and GenerateId("test"), ("_") and the longer string, base64-encoded here).
 */
const vectors = [
  {
    label: "Chrome's PDF viewer, RSA-1024",
    key: "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDN6hM0rsDYGbzQPQfOygqlRtQgKUXMfnSjhIBL7LnReAVBEd7ZmKtyN2qmSasMl4HZpMhVe2rPWVVwBDl6iyNE/Kok6E6v6V3vCLGsOpQAuuNVye/3QxzIldzG/jQAdWZiyXReRVapOhZtLjGfywCvlWq7Sl/e3sbc0vWybSDI2QIDAQAB",
    id: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
  },
  {
    label: "Chrome's Google Network Speech, RSA-2048",
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA8GSbNUMGygqQTNDMFGIjZNcwXsHLzkNkHjWbuY37PbNdSDZ4VqlVjzbWqODSe+MjELdv5Keb51IdytnoGYXBMyqKmWpUrg+RnKvQ5ibWr4MW9pyIceOIdp9GrzC1WZGgTmZismYR3AjaIpufZ7xDdQQv+XrghPWCkdVqLN+qZDA1HU+DURznkMICiDDSH2sU0egm9UbWfS218bZqzKeQDiC3OnTPlaxcbJtKUuupIm5knjze3Wo9Ae9poTDMzKgchg0VlFCv3uqox+wlD8sjXBoyBCCK9HpImdVAF1a7jpdgiUHpPeV/26oYzM9/grltwNR3bzECQgSpyXp0eyoegwIDAQAB",
    id: "neajdppkdcdipfabeoofebfddakdcjhd",
  },
  {
    label: "Chromium's id_util test key",
    key: "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC4fysg3HybDNxRYZkNNg/UZogIVYTVOr8rpGSFewwEEz+N9Lw4DUn+a8RasEBTOtdmCQ+eNnQw2ooxTx8UUNfHIJQX3k65V15+CuWyZXqJTrZH/xy9tzgTr0eFhDIz8xdJv+mW0NYUbxONxfwscrqs6n4YU1amg6LOk5PnHw/mDwIDAQAB",
    id: "melddjfinppjdikinhbgehiennejpfhp",
  },
  { label: "Chromium's id_util string test", key: "dGVzdA==", id: "jpignaibiiemhngfjkcpokkamffknabf" },
  { label: "Chromium's id_util string _", key: "Xw==", id: "ncocknphbhhlhkikpnnlmbcnbgdempcd" },
  {
    label: "Chromium's id_util string longer than a digest",
    key: "dGhpc19zdHJpbmdfaXNfbG9uZ2VyX3RoYW5fYV9zaW5nbGVfc2hhMjU2X2hhc2hfZGlnZXN0",
    id: "jimneklojkjdibfkgiiophfhjhbdgcfi",
  },
];

describe("extensionIdFromKey", () => {
  it.each(vectors)(
    "extensionIdFromKey maps the SHA-256 of the manifest key to 32 letters from a to p ($label)",
    ({ key, id }) => {
      expect(extensionIdFromKey(key)).toBe(id);
    },
  );

  it.each(["", "dGVzdA", "dGVzdA=", "dGVz dA==", "dGVzdA==\n", "dGVzdA==dGVzdA==", "d=VzdA==", "%%%%"])(
    "extensionIdFromKey refuses a key that is not canonical base64 (%j)",
    (key) => {
      expect(() => extensionIdFromKey(key)).toThrow(/manifest key/);
    },
  );
});

describe("sha256", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    ["a".repeat(1_000_000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"],
  ])("sha256 matches the FIPS 180-2 example of %# characters", (text, digest) => {
    expect(hex(sha256(new TextEncoder().encode(text)))).toBe(digest);
  });

  it("sha256 matches node:crypto at every padding boundary up to 300 bytes", () => {
    for (let length = 0; length <= 300; length += 1) {
      const input = Uint8Array.from({ length }, (_, i) => (i * 131 + length) & 0xff);
      expect(hex(sha256(input))).toBe(createHash("sha256").update(input).digest("hex"));
    }
  });
});

describe("base64Decode", () => {
  it.each([
    ["", ""],
    ["Zg==", "f"],
    ["Zm8=", "fo"],
    ["Zm9v", "foo"],
    ["Zm9vYg==", "foob"],
    ["Zm9vYmE=", "fooba"],
    ["Zm9vYmFy", "foobar"],
  ])("base64Decode decodes the RFC 4648 vector %j", (encoded, text) => {
    expect(base64Decode(encoded)).toEqual(new TextEncoder().encode(text));
  });

  it("base64Decode decodes every byte value", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64Decode(Buffer.from(all).toString("base64"))).toEqual(all);
  });

  it.each(["Zg", "Zg=", "Z===", "Zm9v\n", " Zm9v", "Zm9-", "Zm9_", "Zg==Zg=="])(
    "base64Decode refuses %j",
    (encoded) => {
      expect(base64Decode(encoded)).toBeNull();
    },
  );
});
