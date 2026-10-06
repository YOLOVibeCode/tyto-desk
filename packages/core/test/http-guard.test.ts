import { describe, expect, it } from "vitest";
import { httpGuard } from "../src/index.ts";

const port = 9583;

describe("httpGuard", () => {
  it.each(["https://example.test", "null", "http://127.0.0.1:9583", ""])(
    "httpGuard refuses any Origin header (%j)",
    (origin) => {
      expect(httpGuard({ port, host: "127.0.0.1:9583", origin })).toEqual({ ok: false, status: 403 });
    },
  );

  it.each([
    "evil.test:9583",
    "127.0.0.1:9417",
    "localhost:9584",
    "127.0.0.1",
    "localhost",
    "[::1]:9583",
    "0.0.0.0:9583",
    "127.0.0.2:9583",
    "localhost.:9583",
    "127.0.0.1:9583.evil.test",
    "",
    undefined,
  ])("httpGuard refuses a Host other than 127.0.0.1 or localhost on its own port (%j)", (host) => {
    expect(httpGuard({ port, host, origin: undefined })).toEqual({ ok: false, status: 500 });
  });

  it.each(["127.0.0.1:9583", "localhost:9583", "LOCALHOST:9583"])("httpGuard passes %j without an Origin", (host) => {
    expect(httpGuard({ port, host, origin: undefined })).toEqual({ ok: true });
  });
});
