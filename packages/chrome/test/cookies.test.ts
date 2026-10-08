import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Cookie } from "@desk/core";
import { CdpCookieBrowser, NodeDevToolsPortFile } from "../src/index.ts";
import { FakeCdp } from "./fake-cdp.ts";

const WS = "ws://127.0.0.1:9417/devtools/browser/abc-123";
const cookie = (name: string, extra: Partial<Cookie> = {}): Cookie => ({ name, value: "v", domain: ".example.test", path: "/", expires: 2_000_000_000, secure: true, httpOnly: true, sameSite: "Lax", ...extra });

describe("cookies over CDP (docs/IMPLEMENTATION.md §14)", () => {
  it("CdpCookieBrowser reads every cookie with what an import keeps, a session cookie without an expiry", async () => {
    const cdp = new FakeCdp().on("Storage.getCookies", () => ({
      cookies: [
        { name: "a", value: "1", domain: ".example.test", path: "/", expires: 2_000_000_000, size: 2, httpOnly: true, secure: true, session: false, sameSite: "Strict", priority: "Medium", partitionKey: { topLevelSite: "https://example.test", hasCrossSiteAncestor: false } },
        { name: "s", value: "2", domain: "example.test", path: "/x", expires: -1, size: 2, httpOnly: false, secure: false, session: true, priority: "Medium" },
      ],
    }));
    const jar = await new CdpCookieBrowser(async () => cdp).connect(WS, 60_000);

    expect(await jar?.read()).toEqual([
      { name: "a", value: "1", domain: ".example.test", path: "/", expires: 2_000_000_000, secure: true, httpOnly: true, sameSite: "Strict", partitionKey: { topLevelSite: "https://example.test", hasCrossSiteAncestor: false } },
      { name: "s", value: "2", domain: "example.test", path: "/x", expires: -1, secure: false, httpOnly: false },
    ]);
  });

  it("CdpCookieBrowser writes 500 cookies at a time, and a refused batch one cookie at a time, so the counts are exact", async () => {
    const cdp = new FakeCdp().on("Storage.setCookies", (params) => {
      const cookies = params.cookies as { name: string }[];
      if (cookies.some((c) => c.name === "bad")) throw new Error("invalid cookie");
      return {};
    });
    const jar = await new CdpCookieBrowser(async () => cdp).connect(WS, 10_000);
    const cookies = [...Array.from({ length: 600 }, (_, i) => cookie(`c${i}`)), cookie("bad")];

    const written = await jar?.write(cookies);

    expect(written).toEqual({ set: 600, failed: 1 });
    expect(cdp.sent.filter((s) => s.method === "Storage.setCookies").map((s) => (s.params.cookies as unknown[]).length).slice(0, 2)).toEqual([500, 101]);
  });

  it("a session cookie is written without an expiry", async () => {
    const cdp = new FakeCdp().on("Storage.setCookies", () => ({}));
    const jar = await new CdpCookieBrowser(async () => cdp).connect(WS, 10_000);

    await jar?.write([cookie("s", { expires: -1 })]);

    expect((cdp.sent[0]?.params.cookies as Record<string, unknown>[])[0]).not.toHaveProperty("expires");
  });

  it.each(["ws://example.test:9417/devtools/browser/abc", "ws://127.0.0.1:9417/devtools/page/abc", "wss://127.0.0.1:9417/devtools/browser/abc"])(
    "CdpCookieBrowser dials only a browser WebSocket on 127.0.0.1, never %s",
    async (url) => {
      let dialed = false;
      const jar = await new CdpCookieBrowser(async () => {
        dialed = true;
        return new FakeCdp();
      }).connect(url, 1_000);

      expect(jar).toBeNull();
      expect(dialed).toBe(false);
    },
  );

  it("NodeDevToolsPortFile reads the port and browser path Chrome wrote, and nothing malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "devtools-port-"));
    const file = new NodeDevToolsPortFile(dir);
    const missing = await file.read();
    await writeFile(join(dir, "DevToolsActivePort"), "50123\n/devtools/browser/0a1b2c3d-4e5f\n");
    const read = await file.read();
    await writeFile(join(dir, "DevToolsActivePort"), "99999\n/devtools/browser/x\n");

    expect(missing).toBeNull();
    expect(read).toEqual({ port: 50123, path: "/devtools/browser/0a1b2c3d-4e5f" });
    expect(await file.read()).toBeNull();
  });
});
