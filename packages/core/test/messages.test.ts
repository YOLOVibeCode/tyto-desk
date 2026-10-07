import { describe, expect, it } from "vitest";
import { isPaneId, parseClientMessage, parseDaemonMessage } from "../src/index.ts";

const json = (value: unknown) => JSON.stringify(value);

describe("protocol v1 messages a client sends", () => {
  it.each([
    [{ type: "hello", vMin: 1, vMax: 1, client: "panel", build: "0.3.0", window: 1052 }],
    [{ type: "hello", vMin: 1, vMax: 2, client: "sw", build: "0.3.0" }],
    [{ type: "hello", vMin: 1, vMax: 1, client: "cli", build: "0.3.1-dev.x+a1b2c3d" }],
    [{ type: "open", id: "r1", pane: "p_k2m9q3x7ab", cols: 100, rows: 30 }],
    [{ type: "in", pane: "p_k2m9q3x7ab", data: "echo desk-ok\r" }],
    [{ type: "resize", pane: "p_k2m9q3x7ab", cols: 132, rows: 43 }],
    [{ type: "list", id: "r2" }],
    [{ type: "ext.call", id: "r3", op: "windows" }],
    [{ type: "ext.call", id: "r4", op: "focusWindow", args: { window: 1052 } }],
    [{ type: "ext.result", id: "x1", ok: true, value: [] }],
    [{ type: "ext.result", id: "x2", ok: false, error: "no-window" }],
    [{ type: "shutdown", mode: "stop" }],
  ])("the protocol reads %j", (message) => {
    expect(parseClientMessage(json(message))).toEqual(message);
  });

  it.each([
    ["text that is not JSON", "{"],
    ["an array", "[]"],
    ["an unknown type", json({ type: "launch" })],
    ["an unknown client kind", json({ type: "hello", vMin: 1, vMax: 1, client: "page", build: "x" })],
    ["a version range that is not whole numbers", json({ type: "hello", vMin: 1.5, vMax: 2, client: "cli", build: "x" })],
    ["a pane id Desk does not make", json({ type: "in", pane: "p_UPPERCASE1", data: "x" })],
    ["a size of zero columns", json({ type: "open", id: "r1", pane: "p_k2m9q3x7ab", cols: 0, rows: 30 })],
    ["a size beyond any screen", json({ type: "resize", pane: "p_k2m9q3x7ab", cols: 100_000, rows: 30 })],
    ["input that is not text", json({ type: "in", pane: "p_k2m9q3x7ab", data: 42 })],
    ["an unknown extension call", json({ type: "ext.call", id: "r1", op: "cookies" })],
    ["an unknown key", json({ type: "list", id: "r1", extra: true })],
    ["an id that is not a short token", json({ type: "list", id: "a b" })],
    ["a shutdown mode Desk has none of", json({ type: "shutdown", mode: "now" })],
  ])("the protocol drops %s", (_label, line) => {
    expect(parseClientMessage(line)).toBeNull();
  });

  it("the protocol reads input up to 64 KiB encoded and drops more", () => {
    const under = "x".repeat(64 * 1024);
    const over = "\u001b".repeat(11_000);

    expect(parseClientMessage(json({ type: "in", pane: "p_k2m9q3x7ab", data: under }))).not.toBeNull();
    expect(parseClientMessage(json({ type: "in", pane: "p_k2m9q3x7ab", data: over }))).toBeNull();
  });
});

describe("protocol v1 messages the daemon sends", () => {
  it.each([
    [{ type: "hello", v: 1, build: "0.3.0", panes: [{ id: "p_k2m9q3x7ab", alive: true }], notices: [] }],
    [{ type: "snapshot", pane: "p_k2m9q3x7ab", part: 0, last: true, cols: 100, rows: 30, data: "" }],
    [{ type: "out", pane: "p_k2m9q3x7ab", data: "\u001b[1mdesk-ok\u001b[0m\r\n" }],
    [{ type: "exit", pane: "p_k2m9q3x7ab", code: 0, signal: null }],
    [{ type: "detached", pane: "p_k2m9q3x7ab", reason: "taken" }],
    [{ type: "notice", kind: "tmux-line-missing" }],
    [{ type: "error", id: "r1", code: "E_NOEXT", message: "the Desk extension is not connected" }],
    [{ type: "ext.call", id: "x1", op: "windows" }],
    [{ type: "ext.result", id: "r3", ok: true, value: [{ id: 1, focused: true, lastFocused: true, panelOpen: false }] }],
    [
      {
        type: "panes",
        id: "r2",
        panes: [{ id: "p_k2m9q3x7ab", alive: true, owned: true }],
        panels: [{ window: 1052 }],
        sw: { connected: true, connects: 1 },
        gatewayClients: 0,
        paused: false,
      },
    ],
  ])("the panel and the CLI read %j", (message) => {
    expect(parseDaemonMessage(message)).toEqual(message);
  });

  it.each([
    ["an unknown type", { type: "eval", code: "1" }],
    ["output for a pane id Desk does not make", { type: "out", pane: "../../x", data: "" }],
    ["an error code Desk has none of", { type: "error", code: "E_NOPE", message: "x" }],
    ["a string", "hello"],
    ["null", null],
  ])("the panel and the CLI drop %s", (_label, value) => {
    expect(parseDaemonMessage(value)).toBeNull();
  });
});

describe("pane ids", () => {
  it.each(["p_k2m9q3x7ab", "p_0000000001"])("%s is a pane id", (id) => {
    expect(isPaneId(id)).toBe(true);
  });

  it.each(["p_k2m9q3x7a", "p_K2M9Q3X7AB", "p_k2m9q3x7ai", "t_k2m9q3x7ab", "p_k2m9q3x7ab\n"])("%j is not a pane id", (id) => {
    expect(isPaneId(id)).toBe(false);
  });
});
