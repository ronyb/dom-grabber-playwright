# Page Object patterns from dom-grabber snapshots

Locator patterns that come up repeatedly when building Page Objects from dom-grabber output. All generic — adapt to the target project's conventions for file location, naming, and fixtures.

## Creating vs. updating

**New Page Object** — start from the highest-value semantic anchors first (page heading, top-level landmarks, obvious test IDs). Don't try to capture every element upfront; add locators as the tests that need them are written.

**Adding to an existing Page Object** — before writing a new locator, grep the PO for the element's area or label. It's common to find a shared parent locator already declared that you can chain from.

**Updating after drift** — re-capture, then diff the grep output for each existing locator in the PO against the new `.aria.yaml`. If the accessible name changed (localization, rebrand) or the role changed (markup refactor), update. If the name vanished entirely, the element moved or was removed — confirm with the user.

## Anchoring on headings

Pages built with design systems (MUI, Chakra, Radix) often label sections with headings that have no `data-testid`. The heading is still a stable anchor because its text is user-facing and level-specific.

```ts
// Anchor on a heading, then scope operations to siblings/descendants
page.getByRole('heading', { level: 6, name: 'Settings', exact: true });
```

Use `level` to disambiguate (h2 "Settings" in a nav vs. h6 "Settings" in a card header). Use `exact: true` whenever the name could be a substring of another label.

## Sibling navigation for toggles and switches

Many form components render the label and the control as sibling elements rather than as `<label for="...">`. MUI `<Switch>`, Chakra `<Switch>`, Tailwind `<input type="checkbox">` wrapped in a styled span — all follow the same structural pattern:

```
<h6>Feature Flag X</h6>
<span class="...-switchRoot">
  <input type="checkbox" />
</span>
```

In ARIA, they appear as siblings:

```yaml
- heading "Feature Flag X" [level=6]
- checkbox [checked=false]
```

Locator pattern — anchor on the heading, hop to the next sibling span, drill down to the checkbox:

```ts
page.getByRole('heading', { level: 6, name: 'Feature Flag X' })
  .locator('xpath=following-sibling::span[1]')
  .getByRole('checkbox');
```

Use `setChecked(enabled)` on the checkbox — it's idempotent (no-op if already in the target state) and more reliable than `.click()` on MUI's layered span wrappers.

## Row-anchored locators for table-like UIs

Lists of similar items (channel rows, user rows, feature toggles) often share structure but have no row-level `data-testid`. Anchor on the unique per-row label and navigate up to the row container:

```ts
private row(itemName: string): Locator {
  return this.page
    .getByRole('heading', { level: 6, name: itemName, exact: true })
    .locator('xpath=ancestor::div[2]');   // walk up to the row wrapper
}

getItemToggle(name: string): Locator {
  return this.row(name).getByRole('checkbox');
}

getItemInput(name: string): Locator {
  return this.row(name).getByRole('spinbutton');  // or 'textbox', etc.
}
```

Count the `ancestor::div[N]` levels from the captured DOM — `N=1` is the immediate parent, `N=2` is the grandparent. Inspect the row container in the `.html` file:

```bash
grep -oE '<h6[^>]*>ItemName</h6>.{0,800}' <capture>.html | head -1
```

…and count the closing `</div>` tags until you hit the row wrapper.

**Always pass `exact: true`** on the heading match — item names like `"first"` will otherwise match `"firstStage"`, `"firstAttempt"`, etc.

## Scoping by dialog / landmark / form

When two areas of the page have similar labels (modal and page both have "Close"; nav and footer both have "About"), scope by the containing role instead of reaching for CSS:

```ts
page.getByRole('dialog').getByRole('button', { name: 'Close' });
page.getByRole('navigation').getByRole('link', { name: 'About' });
page.locator('form[name="search"]').getByRole('button', { name: 'Go' });
```

## Filtering lists by sibling content

For cards, list items, and table rows with non-unique controls inside, filter by the distinguishing text:

```ts
page.getByRole('listitem')
    .filter({ hasText: 'Galaxy S26' })
    .getByRole('button', { name: 'Add to cart' });

page.getByRole('row').filter({ hasText: 'alice@example.com' })
    .getByRole('button', { name: 'Delete' });
```

## Localization updates

When a project supports multiple UI languages, the `.aria.yaml` captures whichever language was active during the snapshot. Workflow when updating locators after a language change:

1. **Ask which language the tests target.** Some projects run tests in the UI's default language; others force an override. If the current browser state doesn't match the test target, have the user switch before you capture.
2. **Re-capture after the switch** — the old YAML is now stale.
3. **Diff the labels** — most labels change, but brand names (`"Validit AI"`, `"Salesforce"`) and stable identifiers (`data-testid="submit"`) typically do not.
4. **Prefer stable identifiers when available** — `data-testid`, `id`, `name` attributes are immune to localization.
5. **Hebrew/Arabic and RTL**: the MUI `muirtl-*` class prefix appears alongside or instead of `muiltr-*`. Neither is stable for selectors — keep relying on role + accessible name.

Example of what typically **does** localize:

| English label | Hebrew label |
|--------------|-------------|
| Support Tools | כלים לתמיכה |
| Global Kill Switch | מתג כיבוי גלובלי |
| Save | שמור |

Example of what typically **does not** localize:
- Product/brand names (`Validit AI`, `Google Pay`)
- `data-testid` values
- Channel/entity names from the database (`first`, `partnerC`, `twist`)

## Test-ID discovery in sanitized DOM

`dom-grabber` preserves `data-testid`, `data-test`, `data-test-id`, `data-qa`, `data-cy`, `data-id` on every element. Scan them with:

```bash
grep -oE 'data-testid="[^"]+"' <capture>.html | sort -u
```

…then pick the most semantic one for your target. A testid like `"undefined-fabButton"` (appears in some codebases as a placeholder) is unreliable — scope with `.nth(0)` or a parent role instead.

## Validating a locator before committing

Before shipping the PO change, verify the locator against the live Chrome via `connectOverCDP`:

```bash
node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  const loc = page.getByRole('heading', { level: 6, name: 'Feature Flag X' })
    .locator('xpath=following-sibling::span[1]')
    .getByRole('checkbox');
  console.log('count:', await loc.count());
  await browser.close();
})();
"
```

Expected: `count: 1`. If `0`, the locator is wrong. If `>1`, add `exact: true` or a parent scope.

## Project conventions to ask about

Every automation project has its own conventions — before writing code, confirm:

- **Where do Page Objects live?** (`src/pages/`, `src/pom/`, `tests/page-objects/`, etc.)
- **Is there a base class?** Projects with iframe-heavy UIs often have a `BasePage` that wraps `page.frameLocator(...)`. Check before inheriting.
- **Fixture import path.** Some projects forbid `import { test } from '@playwright/test'` and require a project-specific fixture file. Grep existing tests for their import pattern.
- **Locator declaration style.** Some projects prefer `private readonly` locators declared in the constructor; others use getter methods; others inline in action methods. Match the house style.
- **Method naming.** Common patterns: `clickX()`, `fillX()`, `getX()`, `isXVisible()`, `waitForX()`. Copy from existing POs.
- **Size limits.** Projects often enforce max lines per function/file (e.g., 30 lines per method, 200 per file). Split when you cross the threshold.
