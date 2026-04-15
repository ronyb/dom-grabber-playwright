---
description: Sanity-check a Playwright locator against the live Chrome tab without running a full test. Uses connectOverCDP to attach to the existing debug session.
argument-hint: "<locator-expression>"
---

You are running the `/verify-locator` command from the **dom-grabber-playwright** plugin.

## Goal

Given a Playwright locator expression, check how many elements it matches in the currently open Chrome tab — a fast sanity check before committing the locator to a Page Object or test.

## Arguments

- `$ARGUMENTS` — the locator expression, written as a chain starting from `page`. Examples:
  - `getByRole('button', { name: 'Submit', exact: true })`
  - `getByTestId('submit-button')`
  - `getByRole('heading', { level: 6, name: 'Settings' }).locator('xpath=following-sibling::span[1]').getByRole('checkbox')`

## Steps

1. **Verify Chrome CDP is reachable** at `http://127.0.0.1:9222`. If not, instruct the user to launch Chrome with debugging (see the skill's Prerequisites section).

2. **Require that `playwright` is installed somewhere reachable** — `connectOverCDP` lives in the `playwright` package, not `@playwright/test`. If the current directory has no `node_modules/playwright`, try `npx -y -p playwright node -e '...'`.

3. **Run the check** — substitute `$ARGUMENTS` into the locator chain:
   ```bash
   npx -y -p playwright node -e "
   const { chromium } = require('playwright');
   (async () => {
     const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
     const ctx = browser.contexts()[0];
     const page = ctx.pages()[0];
     const loc = page.$ARGUMENTS;
     const count = await loc.count();
     console.log('URL:     ', page.url());
     console.log('Matches: ', count);
     if (count >= 1) {
       const first = loc.first();
       console.log('First:   ', await first.evaluate(el => el.outerHTML.slice(0, 200)));
       try { console.log('Visible:', await first.isVisible()); } catch {}
     }
     await browser.close();
   })().catch(e => { console.error(e.message); process.exit(1); });
   "
   ```

4. **Interpret the result for the user**:
   - `Matches: 1` → locator is good to commit.
   - `Matches: 0` → element not in DOM, or name/role mismatch. Suggest: re-capture with `/dom-grab`, check for typos, or verify the page is in the expected state.
   - `Matches: 2+` → strict-mode violation incoming. Suggest: add `exact: true`, scope by an ancestor role (e.g. `getByRole('dialog').getByRole('button', ...)`), or use `.filter({ hasText: ... })`.
   - `Visible: false` → element exists but won't be clickable. Tell the user which interaction likely reveals it (hover, scroll, modal open).

5. **Keep the output short** — at most ~10 lines of summary. Don't dump the full `outerHTML`; the 200-char slice is enough orientation.

## What NOT to do

- Don't launch a new browser — always `connectOverCDP` so the user keeps their auth state and current page.
- Don't run a full Playwright test spec — this is a one-shot count check.
- Don't close the user's tabs or navigate the page.
