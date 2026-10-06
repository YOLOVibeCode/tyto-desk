# TDD and ISP (mandatory)

Tests define behavior. Ports define ownership. Do not ship a change that violates this file.

1. Failing test first, run and seen failing. `it("…")` is a spec sentence, from `docs/IMPLEMENTATION.md` §19 where it
   gives one. One behavior per `it`; tables use `it.each`.
2. `npm test` is offline: no browser, no Chrome binary, no network, no PTY, no keys. Live tests go in
   `packages/*/test/live/` and run only inside the Desk test container (`npm run test:live`).
3. One port per file in `packages/core/src/ports/`, exported in PascalCase from its file name. No god port.
4. `@desk/core` is pure and browser-safe: no `node:*`, `child_process`, `fs`, `net`, `http`, `WebSocket`,
   `node-pty`, `@xterm/*`, `chrome.*`, Electron, Playwright, Puppeteer, or vendor LLM SDKs, and no `Buffer`,
   `process`, `require`, `globalThis`, browser globals (`chrome`, `window`, `document`, …), `eval`, `Function`, or
   triple-slash references. `npm run lint:imports` and the neutral bundle test enforce it.
5. Adapters implement ports. Tests use separate fakes from `@desk/core/testing` (`Fake<Port>`, `Memory<Port>`,
   `FakeClock`, `SeqRandom`, `ScriptedPrompter`), never one god fake.
6. A port that is hard to fake is the wrong port.
7. `Redactor` before anything is written to disk. Desk sends nothing to a model.
8. Finish with `npm run check`.
