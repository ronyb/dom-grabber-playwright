---
description: Perform an action on the active Chrome tab (click/fill/submit) and capture DOM + ARIA in the same CDP session — before ephemeral UI (snackbar, toast, transient alert) auto-dismisses.
argument-hint: "<action-spec> [output-name]"
---

You are running the `/drive-and-grab` command from the **dom-grabber-playwright** plugin.

## Goal

Drive the page to a new state and snapshot it **immediately** — tightly enough that MUI Snackbars, Ant Design messages, auto-closing toasts, or brief validation popovers are still in the DOM when the ARIA tree is read.

This solves a real failure mode: if you trigger a save, then run `/dom-grab` or `/verify-locator` in separate steps, 3–5 seconds of conversation latency is enough for most transient UI to disappear. The tree you capture no longer contains the thing you wanted to capture.

## Arguments

- `$ARGUMENTS` — one of:
  - **Ad-hoc action spec** — a compact DSL: `click-text:button:Save; grab validit-saved` or `click:[data-testid="row.0.edit"]; wait:200; grab edit-form`.
  - **Script file** — `./flows/save-validit.sh grab-name.html`. The script is a plain shell script that invokes `cdp-do.ts` verbs, ending with a `dom-grabber.ts` capture.

## Steps

1. **Chrome auto-start.** The first tool call (`active-tab.ts` in step 2) auto-launches Chrome with CDP if it isn't running. No manual step required in the common case. If auto-start fails, point the user at `${CLAUDE_PLUGIN_ROOT}/tools/start-chrome-debug.bat` (Windows) or the equivalent Linux/macOS command.

2. **Resolve the active tab's WebSocket URL once** and pass it to every subsequent call via `WS_URL` — this keeps all actions on the same tab without re-discovery:
   ```bash
   export WS_URL=$(npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/active-tab.ts")
   ```

3. **Run the action(s)** using `cdp-do.ts`. Every verb is non-blocking on the CDP side — chain them with `&&` in a single shell command so the capture runs immediately after the last action, with no conversational gap:

   ```bash
   npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cdp-do.ts" click-text button 'Save' \
     && npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/cdp-do.ts" wait 200 \
     && npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/dom-grabber.ts" ${OUTPUT:-post-action.html}
   ```

   The `wait 200` gives React a beat to render the new state; tune higher (500–1500ms) for heavier UIs. Do NOT add more than ~1.5s — that's where auto-dismiss starts eating your capture.

4. **For secret values (creds, tokens)** — set them in the shell environment *before* the chain and pass them by name to `cdp-do.ts fill <selector> <ENV_VAR_NAME>`. `cdp-do.ts` reads from `process.env[envVarName]` so the value never appears in argv:
   ```bash
   BO_EMAIL='...' BO_PASS='...' WS_URL=$(... active-tab.ts)
   npx tsx .../cdp-do.ts fill '[data-testid="login.email"]'    BO_EMAIL \
     && npx tsx .../cdp-do.ts fill '[data-testid="login.password"]' BO_PASS \
     && npx tsx .../cdp-do.ts click-text button 'Log in' \
     && npx tsx .../cdp-do.ts wait 500 \
     && npx tsx .../dom-grabber.ts post-login.html
   ```

5. **Summarize the capture** — same treatment as `/dom-grab` step 4: top-level landmarks, interactive counts, and specifically call out anything that appeared in the post-action state (alerts, validation errors, confirmation dialogs) — that's the thing the user cares about.

6. **Suggest the locator** — once you see the new element in the ARIA tree, suggest a concrete locator (ideally role + `filter({ hasText })` if the role+name mapping is brittle; see main SKILL.md for guidance). Run `/verify-locator` to confirm — but do it **quickly**; transient UI is transient.

## When to prefer this over `/dom-grab`

Use `/drive-and-grab` when:
- The element of interest only exists *after* an action (save alert, form validation error, menu item).
- The element self-dismisses (snackbar, toast, auto-closing modal).
- The user describes the flow as "click X, then capture Y".

Use plain `/dom-grab` when the page is already in the target state and stable.

## What NOT to do

- Don't separate the action and capture into two user-visible turns — that's the exact bug this command exists to prevent.
- Don't put credentials in the action spec or argv — always via env vars.
- Don't chain more than ~3 actions in one call — debugging a failure in the middle becomes painful. Break longer flows into a tiny shell script file.
- Don't use `cdp-do.ts wait` as a substitute for proper readiness — it's an unconditional sleep. If the post-action state takes >1s to appear reliably, something else is wrong (API latency, animation duration).
