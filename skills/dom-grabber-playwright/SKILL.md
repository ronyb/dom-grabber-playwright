---
name: dom-grabber-playwright
description: Capture DOM + ARIA snapshots from a live Chrome session via CDP and build Playwright artifacts — tests, page objects, or locator updates — from what the browser actually renders. Use when the user wants to write a Playwright test/script, create a Page Object, add locators to an existing Page Object, or verify a locator still matches the current DOM, for a page that is open (or can be opened) in Chrome.
---

# dom-grabber → Playwright workflow

Turn a live page into reliable Playwright code by capturing what the browser actually renders, then reading the ARIA tree to pick user-facing locators.

## When to use

- **Write a new test** for a specific page.
- **Create a new Page Object** for a page currently in the browser.
- **Add a locator or method** to an existing Page Object.
- **Update an existing Page Object** after UI/localization drift — verify whether a locator still matches before editing.
- The page is dynamic, auth-gated, or behind SSO, so a one-shot `goto` + guess won't cut it.
- You need locators that survive class/ID churn (role + accessible name).

## Prerequisites

- **Node 22+** (for built-in `fetch` + `WebSocket` + `parseArgs`).
- **Chrome installed.**
- **`npx tsx`** available — installs on demand via `npx`, or globally with `npm i -g tsx`.

The plugin ships these helpers under `${CLAUDE_PLUGIN_ROOT}/tools/`:
- `dom-grabber.ts` — the capture CLI (DOM + ARIA snapshots).
- `cdp-do.ts` — action driver over CDP: fill (reads secrets from env, not argv), click, click-text, press, eval, wait, count. Use this any time you need to drive the page to a specific state before capturing — it avoids the nested-template-literal escape hell of inlining values into `node -e "..."`.
- `active-tab.ts` — prints the first real tab's WebSocket debugger URL (or full JSON with `--json`). Handy for `WS=$(... active-tab.ts)` shell chains.
- `start-chrome-debug.bat` — Windows launcher that starts Chrome with CDP enabled.

Linux/macOS equivalent of the launcher:
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
# or
chromium --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

## Workflow

### 1. Start Chrome with CDP

**Usually you don't need to do anything.** `dom-grabber.ts`, `cdp-do.ts`, and `active-tab.ts` all call `ensureChrome()` at startup: if CDP isn't reachable on `127.0.0.1:9222`, they launch Chrome (Windows: `start-chrome-debug.bat`; macOS/Linux: equivalent flags) and wait up to 15s for it to come up. Persistent profile dir (`%TEMP%\chrome-debug` / `/tmp/chrome-debug`) means auth state survives across sessions.

Opt out by setting `NO_AUTO_CHROME=1` — then the tools fail fast if CDP is down instead of auto-launching.

Manual launch (only if auto-start fails):

**Windows:**
```bash
"${CLAUDE_PLUGIN_ROOT}/tools/start-chrome-debug.bat"
```

**Linux/macOS:**
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

Verify: `curl -s http://127.0.0.1:9222/json/version` should return a JSON blob with `Browser: Chrome/...`.

### 2. Navigate to the target page

Either the user opens it manually, or drive it via CDP. The plugin ships `/dom-navigate <url>` as a one-shot for this. Under the hood it resolves the active tab's WebSocket URL (via `active-tab.ts`) and sends `Page.navigate`.

If you're scripting it yourself, DO NOT name the URL variable `URL` in Node — it shadows the built-in `URL` global and breaks `new WebSocket(...)`. Use `TARGET_URL` or similar.

### 2b. Drive the page to a specific state (optional)

If the capture needs the page in a particular state (logged in, a modal open, a tab switched), use `cdp-do.ts` instead of hand-rolling a `node -e` one-liner. Credentials stay in env variables, not argv:

```bash
BO_EMAIL='user@example.com' BO_PASS='hunter2'
npx tsx ${CLAUDE_PLUGIN_ROOT}/tools/cdp-do.ts fill '[data-testid="login.email"]'    BO_EMAIL
npx tsx ${CLAUDE_PLUGIN_ROOT}/tools/cdp-do.ts fill '[data-testid="login.password"]' BO_PASS
npx tsx ${CLAUDE_PLUGIN_ROOT}/tools/cdp-do.ts click-text button 'Log in'
```

This sidesteps the three-layer escaping trap you hit when embedding JS-in-shell-in-another-JS.

### 3. Capture DOM + ARIA

```bash
npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/dom-grabber.ts" <page-name>.html
```

Output files are written to the **current working directory** — run from wherever you want artifacts to land.

Produces:
- `<page-name>.html` — sanitized DOM (scripts/styles/SVGs stripped, only useful attrs kept: `data-testid*`, `aria-*`, `id`, `name`, `type`, `role`, `href`, `placeholder`, `value`, etc.)
- `<page-name>.aria.yaml` — Playwright `toMatchAriaSnapshot()`-format accessibility tree

Flags:
- `--dom` / `--aria` to restrict to one artifact.
- `-d N` / `--delay N` to wait N seconds before capturing (useful after triggering UI state, e.g. hover-to-open submenus).
- `-p PORT` for non-default debug port.

### 4. Find the anchor in the ARIA snapshot

The ARIA YAML is the semantic skeleton — start here to understand structure. Grep for the target label:

```bash
grep -n -B 2 -A 5 "Submit" <page-name>.aria.yaml
```

Each line has the shape:

```yaml
- <role> "<accessible-name>" [props]:
```

That **usually** maps to `page.getByRole('<role>', { name: '<accessible-name>' })`.

**Caveat — the mapping is not 100% reliable.** Some authors write elements like `<p role="alert">Settings saved</p>` where the visible text is a descendant `StaticText` node in the ARIA tree, not the element's computed accessible name. In those cases `getByRole('alert', { name: 'Settings saved' })` returns 0 matches even though the ARIA dump shows the text. When this happens, fall back to:

```ts
page.getByRole('alert').filter({ hasText: 'Settings saved' })
```

This anchors on the semantic role and uses the visible text as a content filter — the combination of the two is usually specific enough. Always run `/verify-locator` to confirm, especially for MUI Snackbar/Alert, ARIA live regions on `<p>`/`<div>`, and custom components that don't compute `aria-labelledby` / `aria-label`.

### 5. Cross-check the sanitized DOM

Grep the `.html` for `data-testid` (and cousins) in a context window around the target text:

```bash
grep -oE '.{150}Submit.{200}' <page-name>.html | head -3
```

If a stable `data-testid` (or `data-test`, `data-qa`, `data-cy`, `data-id`) exists, prefer it — explicit contracts from the app team survive UI refactors and localization.

### 6. Write the Playwright code

Use role-based locators by default. Same logic applies whether you're writing a test or a Page Object:

```ts
// In a test:
import { test, expect } from '@playwright/test';

test('<description>', async ({ page }) => {
  await page.goto('<url>');
  const input = page.getByRole('<role>', { name: '<name>' });
  await input.fill('<value>');
  const button = page.getByRole('button', { name: '<name>', exact: true });
  await button.click();
  await expect(page).toHaveURL(/<expected-url-fragment>/);
});

// In a Page Object:
export class SubmitPage {
  private readonly submitButton: Locator;
  constructor(page: Page) {
    this.submitButton = page.getByRole('button', { name: 'Submit', exact: true });
  }
  async clickSubmit(): Promise<void> {
    await this.submitButton.click();
  }
}
```

### 7. Re-capture to verify

After writing locators, re-capture and grep again to confirm the anchor still resolves — especially after any state-changing action (modal open, navigation, language toggle). Snapshots are cheap; guessing is expensive.

### 8. Install & run (for new projects)

If the target project has no `package.json` yet:

```bash
npm init -y
npm install -D @playwright/test
npx playwright install chromium   # one-time; downloads ~180 MB
npx playwright test <spec>.ts --reporter=list
```

## Gotchas (learned the hard way)

### Short accessible names — always use `exact: true`

Playwright's `getByRole(..., { name: 'X' })` does **substring, case-insensitive, whitespace-normalized** matching by default. A name like `"Go"`, `"OK"`, `"X"`, `"first"` can collide with unrelated elements whose names contain that substring.

Rule of thumb:
- Accessible name ≤ 3 chars, or a common word / possible substring of another label: `{ name: 'Go', exact: true }`.
- Long, unique phrases: default match is fine (`{ name: 'Search Amazon' }`).

If the first run fails with `strict mode violation: ... resolved to N elements`, add `exact: true` or pick a more specific ancestor (`page.locator('form.search').getByRole('button')`).

### `<input type="submit" value="Go">` shows up as `button`

In ARIA, form submit inputs have role `button` with their `value` as the accessible name — not `input`. Match the YAML, not your intuition.

### The ARIA snapshot reflects current state

If the page changes (modal opens, tab switches, results load, language toggles), re-run `dom-grabber.ts` after the state change. Use `--delay` to let animations settle.

### Stale-snapshot trap

Reusing a snapshot from earlier in the session is a common failure mode. If the user navigated, toggled language, hovered something, or otherwise changed state since your last capture, the old `.aria.yaml` is a lie. **When in doubt, re-capture.**

### role+name lookup fails for some "text-only" alerts/labels

See the caveat in step 4 above. Symptom: ARIA YAML clearly shows `- alert "My message"` but `getByRole('alert', { name: 'My message' })` matches zero elements. Cause: the element's computed accessible name is empty (e.g., `<p role="alert">text</p>` where text is a child node, not an `aria-label`). Fix: use `.filter({ hasText: '...' })` on the role locator. Run `/verify-locator` to confirm match count before committing.

### Ephemeral UI (snackbars, toasts) auto-dismisses between action and capture

MUI Snackbar, Mantine Notification, Ant Design message, etc. often disappear after 3–6 seconds. A common failure pattern: perform the action, then run `/dom-grab` or `/verify-locator` — by the time the CDP connection opens, the alert is gone and you get zero matches. Two options:
1. Use `/drive-and-grab` (combined action + capture in one CDP session — no gap for auto-dismiss).
2. Keep the action and capture physically close in the same script/flow, and re-trigger the action if you need to re-verify later.

### Hidden/ignored nodes are skipped

`dom-grabber.ts` filters out `ignored: true` AX nodes and reparents visible children to the nearest visible ancestor. If you expect an element in the YAML but don't see it, it may be `aria-hidden` or offscreen — verify in the DevTools Accessibility panel.

### CDP navigation requires a real page target

`getActiveTab()` filters out `chrome://` and `devtools://`. Make sure the tab has navigated to a real URL first, or you'll get `No real pages found`.

### Avoid auto-generated framework class names as selectors

Never use class names like `muiltr-*`, `muirtl-*` (MUI RTL/LTR hash classes), `data-emotion` (emotion CSS-in-JS), or `css-*` (styled-components). They change on build. Prefer `role` + accessible name, `data-testid`, or semantic attribute (`name=`, `type=`, `id=`).

## Minimal example (end-to-end)

Amazon search workflow:

1. `start-chrome-debug.bat` → Chrome on port 9222.
2. CDP `Page.navigate` to `https://www.amazon.com/`.
3. `npx tsx ${CLAUDE_PLUGIN_ROOT}/tools/dom-grabber.ts amazon.html` → `amazon.html` + `amazon.aria.yaml`.
4. `grep search amazon.aria.yaml` → found `searchbox "Search Amazon"` and `button "Go"`.
5. Cross-checked `amazon.html` → `#twotabsearchtextbox`, `#nav-search-submit-button`.
6. Wrote `amazon-search.spec.ts` with `getByRole('searchbox', { name: 'Search Amazon' })` and `getByRole('button', { name: 'Go', exact: true })`.

Key debug moment: first run failed because `{ name: 'Go' }` matched both the submit button and the hamburger menu via substring. Adding `exact: true` fixed it.

## What to ask the user when info is missing

- **"Where should the code live — a new test, a new Page Object, or added to an existing one?"** Never guess file locations; ask the user for the target path or existing PO to extend.
- **"What language is the browser in right now?"** UI language affects every text/label-based locator. If the test suite targets a different language than the current snapshot, the user needs to switch before you capture.
- **"Is the element visible right now, or does it require a hover/click to appear?"** Determines whether `--delay` alone is enough, or whether you need to automate an interaction first.
- **"Is there a Page Object convention in this project (location, naming, base class)?"** Projects vary — look for an existing similar PO before writing a fresh one.

## Slash commands shipped with this plugin

- **`/dom-grab [name]`** — capture a fresh DOM + ARIA snapshot and summarize what was found (useful interactive entry point during a session).
- **`/dom-navigate <url>`** — drive the active debug-Chrome tab to a new URL via CDP without losing auth state.
- **`/verify-locator <expr>`** — sanity-check a Playwright locator against the live Chrome tab without running a full test.
- **`/drive-and-grab <action-script>`** — perform an action (click, hover, submit) and capture DOM + ARIA in the same CDP session, before any ephemeral UI has a chance to auto-dismiss.

## Specific tasks

* **Page Object patterns (row-anchored locators, MUI Switch, localization updates)** — [references/page-object-patterns.md](references/page-object-patterns.md)
* **Multi-step flows (login → action → verify)** — [references/multi-step-flows.md](references/multi-step-flows.md)
* **Locator strategy decision tree** — [references/locator-strategies.md](references/locator-strategies.md)
* **Debugging locator failures (strict-mode, timeouts, flakes)** — [references/debugging-locators.md](references/debugging-locators.md)
