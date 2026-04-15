# Capturing multi-step flows

Pages change as the user interacts — a modal opens, a tab switches, search results load. A single `dump-grabber.ts` run only captures the state at that moment. For multi-step tests, capture each intermediate state and write the spec against the union of what you find.

## Pattern: capture-per-step

For each distinct UI state your test needs to interact with, take a separate snapshot.

```bash
# Step 1: landing page — capture before any interaction
npx tsx dump-grabber.ts step1-landing.html

# User/CDP drives the app into state 2 (e.g. opens login modal)
# Then:
npx tsx dump-grabber.ts step2-login-modal.html

# After login, results page loads:
npx tsx dump-grabber.ts --delay 2 step3-dashboard.html
```

Name files semantically so the test author (and future you) can grep the right YAML when picking locators for each interaction in the test.

## Driving state transitions via CDP

If the user isn't available to click through the flow, drive it from the terminal. Each action below runs in the already-open Chrome on port 9222.

### Navigate

```bash
node -e "
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/<TAB_ID>');
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'https://...' } }));
ws.onmessage = (e) => { console.log(e.data); ws.close(); };
"
```

### Click / type via Runtime.evaluate

CDP has no first-class "click this selector" — use `Runtime.evaluate` with JS:

```bash
node -e "
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/<TAB_ID>');
ws.onopen = () => ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: { expression: \"document.querySelector('#login-btn').click()\" }
}));
ws.onmessage = (e) => { console.log(e.data); ws.close(); };
"
```

For anything more than one or two actions, prefer the `playwright-cli` skill — it already wraps this pattern with snapshot refs (`e3`, `e7`) and error handling.

## Pattern: full capture in the test itself

Sometimes the easiest approach is to let Playwright's own `toMatchAriaSnapshot()` serve as both the capture *and* the assertion. Run once with `--update-snapshots`, then review the generated YAML:

```ts
test('snapshot dashboard', async ({ page }) => {
  await page.goto('https://app.example.com/login');
  await page.getByLabel('Email').fill('user@example.com');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.locator('main')).toMatchAriaSnapshot();
});
```

```bash
npx playwright test --update-snapshots
```

Playwright writes the ARIA tree next to the spec. Open it, pick the locators you need for the *next* test, and write that one normally.

This is slower than dom-grabber for one-off captures, but it keeps the snapshot under version control as an assertion, so drift is caught on every run.

## Handling delays and async UI

`dump-grabber.ts` captures whatever the DOM is at the moment `Runtime.evaluate` returns. If content loads after navigation (SPA hydration, API fetches, lazy images), the first capture will be incomplete.

Options:
- **`--delay N`** — blunt but effective; wait N seconds before capturing.
- **Manual trigger** — do the interaction, wait for the spinner to disappear visually, then run `dump-grabber.ts` from another terminal.
- **Loop until stable** — script a size-check loop: capture, wait, capture again; stop when two consecutive captures match.

For the Playwright test itself, don't sprinkle `page.waitForTimeout()` — use `expect(locator).toBeVisible()` or `page.waitForResponse(...)` with a real signal.

## Naming convention

When the flow has N steps, number them: `step1-*.html`, `step2-*.html`. When it's exploratory/debugging, describe the state: `after-login.html`, `modal-open.html`. This matters because the same page can legitimately need two locator lookups for different states (e.g. pre-login vs post-login header nav).

## Cleanup

The captured `.html` and `.aria.yaml` files are throwaway artifacts, not source code. Add them to `.gitignore`:

```
*.aria.yaml
/dom-dumps/
```

Or drop captures into a dedicated dir: `dump-grabber.ts dom-dumps/step1.html`.
