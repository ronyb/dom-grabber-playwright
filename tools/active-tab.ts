#!/usr/bin/env node
/**
 * active-tab — print the first real Chrome tab's WebSocket debugger URL.
 *
 * Filters out chrome:// and devtools:// targets. Exit code 0 on success, 1 otherwise.
 *
 * Usage:
 *   node tools/active-tab.ts                # print ws URL only
 *   node tools/active-tab.ts --json         # full JSON record {id, url, title, ws}
 *   node tools/active-tab.ts -p 9223        # non-default port
 *
 * Handy in scripts:
 *   WS=$(node tools/active-tab.ts)
 *   BO_EMAIL="..." BO_PASS="..." WS_URL="$WS" node tools/cdp-do.ts fill '[data-testid=x]' BO_EMAIL
 */
import { parseArgs } from 'util';
import { ensureChrome } from './ensure-chrome';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: 'boolean', short: 'h', default: false },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', short: 'p', default: '9222' },
    json: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`Usage: active-tab [--host <h>] [--port <p>] [--json]

Prints the WebSocket debugger URL of the first real Chrome tab
(skips chrome://, devtools://, and non-'page' targets).

Options:
  --host <host>    Debug host (default: 127.0.0.1)
  -p, --port <p>   Debug port (default: 9222)
  --json           Print {id, url, title, ws} as JSON instead of just the ws URL`);
  process.exit(0);
}

interface CdpTarget {
  type: string;
  id: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

async function main() {
  await ensureChrome({ host: values.host, port: values.port });
  const res = await fetch(`http://${values.host}:${values.port}/json`);
  const targets = (await res.json()) as CdpTarget[];
  const real = targets.filter(
    (t) => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('devtools://')
  );
  if (real.length === 0) {
    console.error('No real pages found. Open a web page in the browser first.');
    process.exit(1);
  }
  const t = real[0];
  if (values.json) {
    console.log(JSON.stringify({ id: t.id, url: t.url, title: t.title, ws: t.webSocketDebuggerUrl }));
  } else {
    console.log(t.webSocketDebuggerUrl);
  }
}

main().catch((err: Error) => {
  console.error('Error:', err.message);
  process.exit(1);
});
