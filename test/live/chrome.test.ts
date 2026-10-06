import { describe, expect, it } from "vitest";
import { MIN_CHROME_MAJOR } from "../../packages/core/src/index.ts";
import { browserVersion, chromeBinaryMachine, sandboxVerdict, startBaselineChrome, startDeskChrome } from "./lib/chrome.ts";
import { startFixtureServer } from "./lib/fixture-server.ts";
import { saveResult } from "./lib/results.ts";

/** A fixed port in Desk's range; the container has its own network namespace, so nothing else holds it. */
const PORT = 9417;

describe("branded Chrome in the live container", () => {
  it("branded Chrome 155 for linux-arm64 starts sandboxed and answers /json/version on a fixed port", async () => {
    const chrome = await startDeskChrome({ name: "chrome-start", port: PORT });
    try {
      const version = await browserVersion(PORT);
      const verdict = await sandboxVerdict(chrome.cdp);
      await saveResult("chrome-start", { version, verdict, readyMs: chrome.readyMs, binaryVersion: chrome.binaryVersion });

      expect(chrome.binaryVersion).toMatch(/^Google Chrome \d+\./);
      expect(Number(/^Chrome\/(\d+)\./.exec(version.browser)?.[1])).toBeGreaterThanOrEqual(MIN_CHROME_MAJOR);
      expect(await chromeBinaryMachine()).toBe("aarch64");
      expect(version.webSocketDebuggerUrl).toMatch(new RegExp(`^ws://127\\.0\\.0\\.1:${PORT}/devtools/browser/[0-9a-f-]{36}$`));
      expect(verdict).toBe("You are adequately sandboxed.");
    } finally {
      expect(await chrome.close()).toEqual({ code: 0, signal: null });
    }
  });

  it("navigator.webdriver is false and the window chrome is as tall as a launch without Desk flags", async () => {
    const fixture = await startFixtureServer();
    try {
      const desk = await startDeskChrome({ name: "chrome-desk-flags", port: PORT, urls: [`${fixture.origin}/measure?tag=desk`] });
      const deskReport = await fixture.waitForReport("desk").finally(() => desk.close());
      const baseline = await startBaselineChrome({ name: "chrome-no-desk-flags", urls: [`${fixture.origin}/measure?tag=baseline`] });
      const baselineReport = await fixture.waitForReport("baseline").finally(() => baseline.closeWindow());
      await saveResult("chrome-webdriver-and-height", { desk: deskReport, baseline: baselineReport });

      expect(deskReport.webdriver).toBe("false");
      expect(deskReport.chromeHeight).toBe(baselineReport.chromeHeight);
    } finally {
      await fixture.close();
    }
  });
});
