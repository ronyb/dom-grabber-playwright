---
description: Sanity-check a Playwright locator against the live Chrome tab without running a full test. Uses connectOverCDP to attach to the existing debug session.
argument-hint: "<locator-expression>"
---

You are running the `/verify-locator` command from the **dom-grabber-playwright** plugin.

## Goal

Given a Playwright locator expression, check how many elements it matches in the currently open Chrome tab — a fast sanity check before committing the locator to a Page Object or test.

## Arguments

- `$ARGUMENTS` — a full Playwright locator expression that starts with `page.` (paste it exactly as it appears in your Page Object). Examples:
  - `page.getByRole('button', { name: 'Submit', exact: true })`
  - `page.getByTestId('submit-button')`
  - `page.getByRole('heading', { level: 6, name: 'Settings' }).locator('xpath=following-sibling::span[1]').getByRole('checkbox')`

## Steps

1. **Chrome auto-start.** If a CDP-using tool has already been invoked in the session (e.g. `/dom-grab`), Chrome is already up. Otherwise kick off any of the plugin's tools first (they all auto-launch Chrome) or manually run `${CLAUDE_PLUGIN_ROOT}/tools/start-chrome-debug.bat`. Quick sanity: `curl -s http://127.0.0.1:9222/json/version`.

2. **Pick how to invoke `playwright`** — the `connectOverCDP` API lives in the `playwright` package (not `@playwright/test`).
   - If the **current working directory** has `node_modules/playwright` installed, invoke with plain `node -e "..."` — it's faster and avoids re-downloading the package.
   - Otherwise fall back to `npx -y -p playwright node -e "..."`.

   Quick check:
   ```bash
   test -d node_modules/playwright && echo LOCAL || echo NPX
   ```

3. **Run the check** — substitute the user's `$ARGUMENTS` in directly (it already starts with `page.`, do NOT add another `page.` prefix):

   Local-install form:
   ```bash
   node -e "
   const { chromium } = require('playwright');
   (async () => {
     const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
     const ctx = browser.contexts()[0];
     const page = ctx.pages()[0];
     const loc = $ARGUMENTS;
     const count = await loc.count();
     console.log('URL:     ', page.url());
     console.log('Matches: ', count);
     if (count >= 1) {
       const first = loc.first();
       console.log('First:   ', (await first.evaluate(el => el.outerHTML)).slice(0, 200));
       try { console.log('Visible:', await first.isVisible()); } catch {}
     }
     await browser.close();
   })().catch(e => { console.error(e.message); process.exit(1); });
   "
   ```

   Fallback form (no local playwright):
   ```bash
   npx -y -p playwright node -e "<same script as above>"
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
