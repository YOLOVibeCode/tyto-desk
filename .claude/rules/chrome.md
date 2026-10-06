# Chrome law

1. Desk starts the installed Chrome only through `ChromeProcess`, with arguments from `core/chrome/args.ts`
   (`chromeArgs`): the stored port and the Desk profile first, `--no-first-run`, `--no-default-browser-check`,
   `--restore-last-session`, `--hide-crash-restore-bubble`, then the user's `extraArgs`.
2. Never `--remote-debugging-pipe` or `--remote-debugging-io-pipes`, port 0, `--enable-automation`,
   `--enable-blink-features=…AutomationControlled`, `--headless` in any form, `--remote-allow-origins`,
   `--remote-debugging-address`, `--load-extension`, `--use-mock-keychain`, `--password-store=basic`, `--no-sandbox`,
   `--disable-gpu-sandbox`, `--disable-setuid-sandbox`, `--no-zygote`, `--disable-site-isolation-trials`,
   `--disable-web-security`, `--use-fake-ui-for-media-stream`, a user-data-dir under any Chrome channel's default
   directory, or a Playwright/Puppeteer `launch()`. `chromeArgs` refuses them, also from `extraArgs`; the build refuses
   a bundle that spells them.
3. Ports: two distinct ports from 9400–9899, stored in `config.json`; never 9222 or 9229. Every listener binds
   127.0.0.1 or a socket path (`lint:listen`) and applies `httpGuard`.
4. Never write protected prefs, `Secure Preferences`, or syncable prefs by default (IMPLEMENTATION §5).
5. Never quit Chrome with a signal: CDP `Browser.close`. SIGTERM loses recent cookies and localStorage.
6. Core plans depend on role ports, never on raw CDP. Desk never attaches to its own extension targets.
