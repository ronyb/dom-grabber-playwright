---
description: Capture a fresh DOM + ARIA snapshot of the current Chrome tab via CDP and summarize what was found.
argument-hint: "[output-name]"
---

You are running the `/dom-grab` command from the **dom-grabber-playwright** plugin.

## Goal

Capture a snapshot of the page currently open in the user's debug Chrome session, then give them a useful summary of what was captured — not a raw DOM dump.

## Arguments

- `$ARGUMENTS` — optional base name for the output files. Defaults to `dom-dump.html`. The `.aria.yaml` variant is derived automatically.

## Steps

1. **Verify Chrome CDP is reachable:**
   ```bash
   curl -s http://127.0.0.1:9222/json/version
   ```
   If it fails, tell the user to launch Chrome with debugging first — on Windows, point them at `${CLAUDE_PLUGIN_ROOT}/tools/start-chrome-debug.bat`; on Linux/macOS, show them the flag-based command.

2. **Run the capture** — both DOM and ARIA by default:
   ```bash
   npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/dom-grabber.ts" ${1:-dom-dump.html}
   ```
   If the user's request mentions hover/submenu/modal state, add `--delay 3` so the post-interaction state is captured.

3. **Report what landed on disk** — print the two output paths and their sizes (the CLI already prints this).

4. **Summarize the page structure** from the ARIA YAML:
   - The top-level `document` heading (page title).
   - Top-level landmarks: `banner`, `navigation`, `main`, `contentinfo`.
   - Count of interactive roles: `button`, `link`, `textbox`, `checkbox`, `combobox`, `spinbutton`.
   - Any obvious anchor headings (h1/h2 in `main`).
   - Call out the first 3–5 elements that look most test-relevant (forms, primary CTAs, data rows).

5. **Flag anything unusual**:
   - Repeated `button "undefined-..."` or generic testids.
   - Interactive elements with no accessible name (will need extra care).
   - Presence of `iframe` / `frame` roles — locators may need `frameLocator()`.

## What NOT to do

- Don't paste the full `.aria.yaml` back to the user — it's large and their scrollback is precious. Summarize.
- Don't start writing tests or page objects unless the user asked — this command is for **capture + orient**, not implementation.
- Don't reuse a stale snapshot if the user's prior state may have changed — always capture fresh for this command.
