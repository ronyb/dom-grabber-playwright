# Debugging locator failures

A Playwright locator can fail in three ways. Each has a distinct fix.

## 1. `strict mode violation: resolved to N elements`

The locator matched more than one element. Playwright refuses to guess which one you meant.

### Fix order

1. **Add `exact: true`** if the name is short or generic.
   ```ts
   page.getByRole('button', { name: 'Go', exact: true });
   ```

2. **Scope by ancestor** — wrap the locator in a `getByRole('dialog')`, `getByRole('navigation')`, `locator('form')`, etc.
   ```ts
   page.getByRole('dialog').getByRole('button', { name: 'Close' });
   ```

3. **Filter by sibling content** for lists/tables.
   ```ts
   page.getByRole('row').filter({ hasText: 'Alice' }).getByRole('button', { name: 'Delete' });
   ```

4. **Last resort:** `.first()`, `.last()`, `.nth(2)` — brittle against reordering.

### Debugging

Re-read the ARIA snapshot and grep for the ambiguous name:

```bash
grep -n '"Go"' page.aria.yaml
```

If you see multiple matches, read 5 lines of context around each to understand which ancestor roles differ.

## 2. `locator.click: Timeout waiting for element`

The locator matched zero elements, or matched something not yet visible/actionable.

### Diagnose

- **Is the element in the snapshot at all?** Re-capture with `dump-grabber.ts` *after* any state transitions. If not present, you're capturing the wrong state.
- **Is the name exactly right?** ARIA accessible names include punctuation and whitespace that might not appear in the visible text. Check the raw `.aria.yaml`.
- **Is it `aria-hidden` or offscreen?** `dump-grabber.ts` already filters out ignored nodes — if you can see it in DevTools but not in the YAML, it's probably hidden from the accessibility tree.
- **Is the parent a shadow root?** Playwright pierces open shadow roots automatically, but closed ones are invisible. Check `mode: 'open'` vs `'closed'` in DevTools.

### Common pitfalls

- **The element exists but the *page* isn't ready.** Add an explicit wait on a prerequisite, not the target:
  ```ts
  await expect(page.getByText('Loading')).toBeHidden();
  await page.getByRole('button', { name: 'Submit' }).click();
  ```
- **Typos** — `textbox` vs `searchbox`, `link` vs `button`, `header` vs `heading`. Copy-paste from the YAML.
- **Dynamic names** — accessible name changes based on state (e.g. `"Play"` → `"Pause"`). Use a regex: `{ name: /Play|Pause/ }`.

## 3. Flakiness — passes sometimes, fails sometimes

The locator is correct, but something about timing or state is inconsistent.

### Common causes

- **Stale capture.** You ran `dump-grabber.ts` before the page finished loading. Re-capture with `--delay 3` or after triggering the real interaction.
- **Animation in flight.** A fading modal may be targetable but not clickable. Playwright's auto-waiting usually handles this, but CSS transitions on `pointer-events` can trip it.
- **Network variability.** If the element depends on an API response, make the test wait for that response explicitly:
  ```ts
  const responsePromise = page.waitForResponse(r => r.url().includes('/api/products') && r.ok());
  await page.getByRole('button', { name: 'Search' }).click();
  await responsePromise;
  ```
- **Race with another test** sharing state (cookies, storage, server data). Use `test.describe.serial` or isolate per-worker.

### Debug tools

- `npx playwright test --headed --debug` — step through with Playwright Inspector.
- `npx playwright test --trace on` then `npx playwright show-trace trace.zip` — full timeline with DOM snapshots per action.
- `page.pause()` inside the test — drops you into the Inspector at that line.

## Verifying a locator without running the full test

Quick sanity check in a Node REPL:

```bash
node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('amazon'));
  const loc = page.getByRole('button', { name: 'Go', exact: true });
  console.log('count:', await loc.count());
  console.log('first:', await loc.first().getAttribute('id'));
  await browser.close();
})();
"
```

`connectOverCDP` attaches to the already-open debug Chrome (same one `dump-grabber.ts` talks to) — no fresh browser launch, no loss of auth state.

## When to re-capture

Re-run `dump-grabber.ts` whenever:

- The page URL changed.
- A modal/dialog opened or closed.
- You submitted a form or clicked a button that triggers fetch/render.
- Expected text isn't showing up in your grep of the `.aria.yaml`.

Snapshots are cheap. Re-capturing is faster than guessing.
