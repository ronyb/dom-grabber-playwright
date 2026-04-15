# dom-grabber-playwright

A Claude Code plugin that captures DOM + ARIA snapshots from a live Chrome session via CDP, and guides Claude to build Playwright artifacts — tests, Page Objects, or locator updates — from what the browser actually renders.

Ships:

- **Skill** `dom-grabber-playwright` — teaches Claude the full workflow, with references for locator strategy, multi-step flows, debugging, and Page Object patterns.
- **CLI tool** `tools/dom-grabber.ts` — zero-dependency DOM + ARIA capturer (connects to Chrome via CDP on port 9222).
- **Launcher** `tools/start-chrome-debug.bat` — Windows batch file that starts Chrome with `--remote-debugging-port=9222`.
- **Slash commands**:
  - `/dom-grab [name]` — capture a fresh snapshot and summarize what was found.
  - `/dom-navigate <url>` — drive the active tab to a new URL via CDP (preserves auth state).
  - `/verify-locator <expr>` — count how many elements a Playwright locator matches in the live tab.

## Requirements

- **Node.js 22+** (for built-in `fetch` + `WebSocket` + `parseArgs`).
- **Chrome** (Chromium-based browsers also work).
- **`npx tsx`** on `PATH` — resolved automatically by `npx` or install globally with `npm i -g tsx`.

## Install

From a local clone of this repo:

```bash
/plugin install /path/to/dom-grabber-playwright
```

Or, with Claude Code's plugin marketplace/manifest once published, use the appropriate `install` command for your setup.

After install, the skill and commands become available in every Claude Code session.

## Quick start

1. **Launch debug Chrome** (one-time per session):
   - Windows: double-click `tools/start-chrome-debug.bat` or run it from a terminal.
   - Linux/macOS:
     ```bash
     google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
     ```
2. **Open your target page** in that Chrome window — log in, navigate, interact as needed.
3. **In Claude Code**, run:
   ```
   /dom-grab my-page
   ```
   Claude captures `my-page.html` + `my-page.aria.yaml` in the current working directory and tells you what it found.
4. **Ask Claude** for whatever Playwright artifact you need — e.g. _"Create a Page Object for this page"_ or _"Add a method to click the Save button"_. The skill instructs Claude to grep the capture for the right locator and write code that matches.

## Usage patterns

The skill covers four primary use cases, in generic terms applicable to any Playwright project:

| Goal | Claude uses |
|------|-------------|
| Write a new test for this page | `dom-grabber.ts` → ARIA grep → `getByRole`-based spec |
| Create a new Page Object | Same workflow, output goes into a PO file with `private readonly` locators |
| Add a method/locator to an existing PO | Re-capture current state, locate the element, extend the existing PO |
| Verify a locator after UI/localization drift | `/verify-locator` or re-capture + diff |

Project-specific conventions (PO file location, naming, fixture imports, size limits) are **not** prescribed by this plugin — Claude is instructed to ask the user about them before writing code.

## Plugin layout

```
dom-grabber-playwright/
├── .claude-plugin/
│   └── plugin.json                 # plugin manifest
├── skills/
│   └── dom-grabber-playwright/
│       ├── SKILL.md                # primary skill — workflow, gotchas, examples
│       └── references/
│           ├── page-object-patterns.md   # heading-anchored toggles, row locators, localization
│           ├── locator-strategies.md     # decision tree + ARIA-to-locator mapping table
│           ├── multi-step-flows.md       # capture-per-step, CDP navigation, stability
│           └── debugging-locators.md     # strict-mode, timeouts, flakiness
├── tools/
│   ├── dom-grabber.ts              # the capture CLI
│   └── start-chrome-debug.bat      # Windows Chrome launcher
├── commands/
│   ├── dom-grab.md                 # /dom-grab [name]
│   ├── dom-navigate.md             # /dom-navigate <url>
│   └── verify-locator.md           # /verify-locator <expr>
├── .gitignore
└── README.md
```

## How it works

`dom-grabber.ts` talks to Chrome over CDP (WebSocket on port 9222) and calls two endpoints:

- `Runtime.evaluate` — to sanitize + serialize the DOM (strip scripts, styles, SVG data; keep `data-testid*`, `aria-*`, `id`, `name`, `type`, `role`, `href`, etc.).
- `Accessibility.getFullAXTree` — to pull the full accessibility tree, which is then converted into Playwright's `toMatchAriaSnapshot()` YAML format.

The output is the same ARIA tree Playwright reasons about internally, which is why the generated locators (`getByRole('<role>', { name: '<accessible-name>' })`) map 1:1 to what dom-grabber shows you.

No Playwright runtime is needed for capture — `dom-grabber.ts` depends only on Node's built-ins.

## Updating the CLI

If you upgrade `dom-grabber.ts` in your canonical dev location, replace `tools/dom-grabber.ts` here and bump the `version` in `.claude-plugin/plugin.json`. Users reinstall or pull to pick up the change.

## License

Internal distribution. Use as you see fit within your team.
