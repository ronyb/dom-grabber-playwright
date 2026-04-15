# Locator strategies — decision tree

Playwright offers many locator APIs. For dom-grabber-derived tests, use this order of preference. Stop at the first one that uniquely identifies the element.

## 1. `getByRole(role, { name })` — default choice

Maps 1:1 to the `.aria.yaml` output (`- role "name"`). Most stable against markup refactors because it reflects user-facing semantics.

```ts
page.getByRole('searchbox', { name: 'Search Amazon' });
page.getByRole('button', { name: 'Sign in' });
page.getByRole('link', { name: 'Returns & Orders' });
```

**Add `exact: true`** when the name is short or generic (≤ 3 chars, or common words like "Go", "OK", "Next", "Submit"). See the main SKILL.md gotcha.

## 2. `getByLabel(text)` — form inputs with visible labels

When the ARIA snapshot shows `textbox "Email"` or the HTML has `<label for="email">Email</label>`, this is cleaner than role+name because it mirrors how a human identifies the field.

```ts
page.getByLabel('Email address');
page.getByLabel('Password');
```

## 3. `getByPlaceholder(text)` — inputs without labels

Rare but handy for search bars and simple forms that lack proper labels.

```ts
page.getByPlaceholder('Search products...');
```

## 4. `getByText(text)` — non-interactive text

For assertions and text-only elements (paragraphs, headings, status messages). Avoid for clickable elements — use role.

```ts
await expect(page.getByText('Order placed successfully')).toBeVisible();
```

## 5. `getByTestId(id)` — when the app opted in

`dump-grabber.ts` preserves `data-testid`, `data-test`, `data-qa`, `data-cy`, `data-id` attributes (see `dump-grabber.ts:95-97`). If the captured HTML has them, prefer over CSS selectors — they're explicit contracts from the app team.

```ts
page.getByTestId('checkout-submit');
```

## 6. `page.locator(css)` — last resort

Use only when roles/labels don't disambiguate and the app has no test IDs. Prefer attribute selectors over class/tag chains (classes change; `id`/`name`/`role` attributes rarely do).

```ts
// Good — explicit, semantic
page.locator('#twotabsearchtextbox');
page.locator('input[name="field-keywords"]');

// Brittle — avoid
page.locator('div.nav-left > form > div:nth-child(2) input');
```

## Disambiguation patterns

When a locator matches multiple elements, scope it to an ancestor instead of reaching for CSS:

```ts
// Two "Edit" buttons, one per row — scope by row
page.getByRole('row', { name: 'Alice' }).getByRole('button', { name: 'Edit' });

// Modal + page both have "Close" — scope by dialog
page.getByRole('dialog').getByRole('button', { name: 'Close' });

// Nav vs footer both have "About" — scope by landmark
page.getByRole('navigation').getByRole('link', { name: 'About' });
```

## Filter by content when nothing else works

`.filter({ hasText: ... })` and `.filter({ has: ... })` let you narrow a list by what's inside each item — useful for tables, cards, feed items.

```ts
page.getByRole('listitem')
    .filter({ hasText: 'Galaxy S26' })
    .getByRole('button', { name: 'Add to cart' });
```

## What NOT to do

- **Don't use XPath** unless absolutely cornered — it's verbose and brittle.
- **Don't chain 4+ CSS selectors** — that's a sign you should pick a different strategy.
- **Don't use `page.$` / `page.$$`** — these are deprecated query APIs. Always use `page.locator(...)` or `getBy*`.
- **Don't hardcode indices** (`locator.nth(3)`) when the list order might change — use `filter({ hasText })` instead.

## Quick reference: ARIA line → Playwright locator

| `.aria.yaml` line                          | Playwright locator                                      |
| ------------------------------------------ | ------------------------------------------------------- |
| `- button "Submit"`                        | `getByRole('button', { name: 'Submit' })`              |
| `- button "Go"` (short → collision-prone) | `getByRole('button', { name: 'Go', exact: true })`     |
| `- textbox "Email"`                        | `getByLabel('Email')` or `getByRole('textbox', {...})` |
| `- searchbox "Search"`                     | `getByRole('searchbox', { name: 'Search' })`           |
| `- link "Home"`                            | `getByRole('link', { name: 'Home' })`                  |
| `- heading "Welcome"` (level=1)            | `getByRole('heading', { name: 'Welcome', level: 1 })`  |
| `- checkbox "Remember me"` [checked]       | `getByRole('checkbox', { name: 'Remember me' })`       |
| `- combobox` with options                  | `getByRole('combobox')` + `.selectOption('value')`     |
| `- dialog "Confirm delete"`                | `getByRole('dialog', { name: 'Confirm delete' })`      |
| `- text "hello"` (non-interactive)         | `getByText('hello')`                                   |
