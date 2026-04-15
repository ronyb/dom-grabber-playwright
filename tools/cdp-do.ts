#!/usr/bin/env node
/**
 * cdp-do — drive a page over CDP: fill / click / press / eval / wait.
 *
 * Designed to avoid the nested-template-literal escape hell that
 * happens when you try to inline form values into a `node -e "..."`
 * one-liner. Sensitive values (creds, tokens) are read from environment
 * variables by name, so nothing user-provided ever lands in argv or a
 * shell-expanded string.
 *
 * Zero dependencies. Requires Node.js >= 22 (built-in fetch + WebSocket + parseArgs).
 *
 * Tab selection:
 *   - If env WS_URL is set, uses it directly.
 *   - Otherwise auto-discovers the first real (non-chrome://, non-devtools://)
 *     page via http://${DEBUG_HOST:-127.0.0.1}:${DEBUG_PORT:-9222}/json
 *
 * Verbs:
 *   fill <selector> <env-var-name>   Fill input with process.env[env-var-name].
 *                                    Uses the React-safe native setter + input/change events.
 *                                    Never passes the value through argv.
 *
 *   click <selector>                 Click the first element matching selector.
 *
 *   click-text <role> <text>         Click the first element with the given role and
 *                                    an exact trimmed textContent. Useful when the element
 *                                    has no data-testid (e.g. "Log in"). Role is one of:
 *                                    button, link, or any CSS selector for broader matches.
 *                                    Example: click-text button "Log in"
 *
 *   press <key>                      Dispatch a keydown for `key` on document.activeElement.
 *                                    Example: press Enter
 *
 *   eval <file.js>                   Evaluate the JS file in the page context with
 *                                    awaitPromise=true and print the result as JSON.
 *                                    File should end in an IIFE or expression that returns a value.
 *
 *   wait <ms>                        Sleep locally for N ms (useful between actions).
 *
 *   count <selector>                 Print match count. Handy smoke test.
 *
 * Examples:
 *   # Credentials stay in env — never in argv.
 *   BO_EMAIL='user@example.com' BO_PASS='hunter2' \
 *     node tools/cdp-do.ts fill '[data-testid="login.email"]' BO_EMAIL
 *   node tools/cdp-do.ts fill '[data-testid="login.password"]' BO_PASS
 *   node tools/cdp-do.ts click-text button 'Log in'
 *
 *   # Or chain via shell (each call auto-discovers the tab):
 *   node tools/cdp-do.ts click '#open-menu' \
 *     && node tools/cdp-do.ts wait 200 \
 *     && node tools/cdp-do.ts click-text link 'Settings'
 */
import * as fs from 'fs';
import * as path from 'path';
import { ensureChrome } from './ensure-chrome';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
  console.log(fs.readFileSync(__filename, 'utf-8').split('\n').slice(1, 60).join('\n').replace(/^ ?\*\/?/gm, '').trim());
  process.exit(argv.length === 0 ? 1 : 0);
}

const [verb, ...rest] = argv;

const DEBUG_HOST = process.env.DEBUG_HOST ?? '127.0.0.1';
const DEBUG_PORT = process.env.DEBUG_PORT ?? '9222';

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------
interface CdpTarget { type: string; url: string; webSocketDebuggerUrl: string }

async function getWsUrl(): Promise<string> {
  if (process.env.WS_URL) return process.env.WS_URL;
  await ensureChrome({ host: DEBUG_HOST, port: DEBUG_PORT });
  const res = await fetch(`http://${DEBUG_HOST}:${DEBUG_PORT}/json`);
  const targets = (await res.json()) as CdpTarget[];
  const real = targets.find(
    (t) => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('devtools://')
  );
  if (!real) throw new Error('No real pages found. Open a web page in the browser first.');
  return real.webSocketDebuggerUrl;
}

function openCdp(wsUrl: string): { send: (m: string, p?: object) => Promise<any>; close: () => void } {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const ready = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e: any) => reject(new Error(`WS error: ${e.message || 'unknown'}`));
  });
  const send = async (method: string, params: object = {}) => {
    await ready;
    return new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      const handler = (ev: MessageEvent) => {
        const msg = JSON.parse(ev.data as string);
        if (msg.id !== id) return;
        ws.removeEventListener('message', handler);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  return { send, close: () => ws.close() };
}

async function runScript(expression: string): Promise<any> {
  const wsUrl = await getWsUrl();
  const { send, close } = openCdp(wsUrl);
  try {
    await send('Runtime.enable');
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      const msg = d.exception?.description || d.exception?.value || d.text || JSON.stringify(d);
      throw new Error('Page script exception: ' + msg);
    }
    return result.result?.value;
  } finally {
    close();
  }
}

// ---------------------------------------------------------------------------
// Page-side helpers (stringified, embedded in Runtime.evaluate)
// ---------------------------------------------------------------------------
const HELPER_LIB = /* js */ `
  const __setReactValue = (el, val) => {
    const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const __q = (sel) => document.querySelector(sel);
  const __qErr = (sel) => { const el = __q(sel); if (!el) throw new Error('selector not found: ' + sel); return el; };
`;

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------
async function verbFill(selector: string, envVarName: string): Promise<void> {
  const value = process.env[envVarName];
  if (value === undefined) {
    throw new Error(
      `env var ${envVarName} is not set. Pass the value via the shell:  ${envVarName}='...' node cdp-do.ts fill ...`
    );
  }
  // Inject the value into the page as a window global via JSON.stringify — no shell quoting involved.
  const inject = `window.__CDP_DO_VAL = ${JSON.stringify(value)};`;
  const fill = `
    ${HELPER_LIB}
    (async () => {
      const el = __qErr(${JSON.stringify(selector)});
      el.focus();
      __setReactValue(el, window.__CDP_DO_VAL);
      delete window.__CDP_DO_VAL;
      return { ok: true, lenSeen: String(el.value ?? '').length };
    })()
  `;
  const wsUrl = await getWsUrl();
  const { send, close } = openCdp(wsUrl);
  try {
    await send('Runtime.enable');
    await send('Runtime.evaluate', { expression: inject });
    const r = await send('Runtime.evaluate', { expression: fill, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'page script threw');
    console.log(JSON.stringify(r.result.value));
  } finally {
    close();
  }
}

async function verbClick(selector: string): Promise<void> {
  const script = `
    ${HELPER_LIB}
    (async () => {
      const el = __qErr(${JSON.stringify(selector)});
      el.click();
      return { ok: true };
    })()
  `;
  const v = await runScript(script);
  console.log(JSON.stringify(v));
}

async function verbClickText(role: string, text: string): Promise<void> {
  // role: 'button' | 'link' | any CSS selector (e.g. 'a', '[role=menuitem]')
  const cssBase = role === 'button' ? 'button' : role === 'link' ? 'a' : role;
  const script = `
    (async () => {
      const target = ${JSON.stringify(text)}.trim();
      const css = ${JSON.stringify(cssBase)};
      const candidates = Array.from(document.querySelectorAll(css));
      const hit = candidates.find(el => (el.textContent || '').trim() === target);
      if (!hit) throw new Error('no ' + css + ' with exact text: ' + target);
      hit.click();
      return { ok: true, clicked: hit.textContent.trim() };
    })()
  `;
  const v = await runScript(script);
  console.log(JSON.stringify(v));
}

async function verbPress(key: string): Promise<void> {
  const script = `
    (async () => {
      const el = document.activeElement || document.body;
      const ev = new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true });
      el.dispatchEvent(ev);
      return { ok: true, target: el.tagName };
    })()
  `;
  const v = await runScript(script);
  console.log(JSON.stringify(v));
}

async function verbEval(file: string): Promise<void> {
  const src = fs.readFileSync(path.resolve(file), 'utf-8');
  const v = await runScript(src);
  console.log(JSON.stringify(v, null, 2));
}

async function verbWait(ms: string): Promise<void> {
  await new Promise((r) => setTimeout(r, parseInt(ms, 10)));
}

async function verbCount(selector: string): Promise<void> {
  const script = `document.querySelectorAll(${JSON.stringify(selector)}).length`;
  const v = await runScript(script);
  console.log(String(v));
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
(async () => {
  switch (verb) {
    case 'fill':       return verbFill(rest[0], rest[1]);
    case 'click':      return verbClick(rest[0]);
    case 'click-text': return verbClickText(rest[0], rest.slice(1).join(' '));
    case 'press':      return verbPress(rest[0]);
    case 'eval':       return verbEval(rest[0]);
    case 'wait':       return verbWait(rest[0]);
    case 'count':      return verbCount(rest[0]);
    default:
      console.error(`Unknown verb: ${verb}. Run with --help for usage.`);
      process.exit(2);
  }
})().catch((e: Error) => {
  console.error('cdp-do error:', e.message);
  process.exit(1);
});
