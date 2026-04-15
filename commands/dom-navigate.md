---
description: Navigate the active debug-Chrome tab to a URL via CDP, then wait for the page to settle. Useful when you want to change pages mid-conversation without the user clicking.
argument-hint: "<url> [--wait-for=<ms>]"
---

You are running the `/dom-navigate` command from the **dom-grabber-playwright** plugin.

## Goal

Drive the Chrome tab at `http://127.0.0.1:9222` to a new URL via CDP's `Page.navigate` method, without launching a new browser or losing auth/cookies.

## Arguments

- `$1` — **required**. The destination URL (absolute, including scheme).
- Optional flag `--wait-for=<ms>` — additional settle time after `frameStoppedLoading` fires. Default: `500`.

## Steps

1. **Chrome auto-start.** The plugin's `active-tab.ts` / `cdp-do.ts` helpers call `ensureChrome()` which auto-launches Chrome with CDP if it isn't already running. If you want to avoid the `curl` probe, run `${CLAUDE_PLUGIN_ROOT}/tools/active-tab.ts` directly — it handles auto-start and prints the WS URL. Otherwise:
   ```bash
   curl -s http://127.0.0.1:9222/json/version
   ```
   If this fails and auto-start hasn't been triggered yet, run `${CLAUDE_PLUGIN_ROOT}/tools/start-chrome-debug.bat` (Windows) or the equivalent Linux/macOS command. Do not proceed until CDP is reachable.

2. **Find the active tab's WebSocket URL.** Prefer the helper:
   ```bash
   WS=$(npx tsx "${CLAUDE_PLUGIN_ROOT}/tools/active-tab.ts")
   ```
   Or the raw approach:
   ```bash
   curl -s http://127.0.0.1:9222/json
   ```
   Pick the first entry with `type: "page"` whose `url` does NOT start with `chrome://` or `devtools://`. Read its `webSocketDebuggerUrl`.

3. **Drive `Page.navigate` via a Node one-liner:**

   Note: do NOT name the URL variable `URL` — it shadows Node's built-in `URL` constructor and causes `new WebSocket(URL)` to throw `TypeError: URL is not a constructor`. Use `TARGET_URL` (or anything that isn't a Node global).

   ```bash
   node -e "
   const WS = process.argv[1], TARGET_URL = process.argv[2];
   const ws = new WebSocket(WS);
   let currentId = 0;
   const send = (method, params = {}) => new Promise((resolve, reject) => {
     const id = ++currentId;
     const handler = (ev) => {
       const msg = JSON.parse(ev.data);
       if (msg.id === id) { ws.removeEventListener('message', handler); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
     };
     ws.addEventListener('message', handler);
     ws.send(JSON.stringify({ id, method, params }));
   });
   ws.onopen = async () => {
     await send('Page.enable');
     await send('Page.navigate', { url: TARGET_URL });
     await new Promise(r => {
       const h = ev => { const m = JSON.parse(ev.data); if (m.method === 'Page.frameStoppedLoading') { ws.removeEventListener('message', h); r(); } };
       ws.addEventListener('message', h);
     });
     setTimeout(() => ws.close(), ${2:-500});
   };
   ws.onclose = () => { console.log('Navigated to', TARGET_URL); process.exit(0); };
   ws.onerror = (e) => { console.error('WS error:', e.message || e); process.exit(1); };
   " "<WS_URL_FROM_STEP_2>" "$1"
   ```

4. **Confirm by re-querying `/json`** and reporting the new URL and page title back to the user — short, one-line summary.

5. **Suggest next step** — if the user's broader request was to capture/inspect the new page, offer to run `/dom-grab` next (or do it automatically if that's the clear intent from the conversation context).

## What NOT to do

- Don't launch a new browser — reuse the existing tab so auth state is preserved.
- Don't close tabs the user had open.
- Don't navigate if the URL is clearly non-http(s) or points to a local `file://` path the user hasn't mentioned — confirm first.
- Don't automatically follow up with multiple actions unless the user's prior turn clearly set up a chain (e.g., "navigate there and capture" → both are fine in one shot).

## Common failure modes

- **`No real pages found`** — every open tab is `chrome://newtab` or DevTools. Ask the user to open a real page first.
- **Navigation stalls on SPA route change** — `Page.frameStoppedLoading` may fire immediately for in-app route changes; the `--wait-for` delay compensates.
- **CORS / auth redirect** — the tab may land on a login page instead of the requested URL. Report the actual final URL back to the user so they know.
