#!/usr/bin/env node
/**
 * dom-grabber — DOM snapshot + ARIA snapshot CLI
 *
 * Connects to a Chrome/Chromium browser via CDP and produces:
 *   1. <output>.html      — sanitized DOM (scripts/styles/SVGs stripped)
 *   2. <output>.aria.yaml — ARIA tree in Playwright toMatchAriaSnapshot() format
 *
 * Zero dependencies. Requires Node.js >= 22 (built-in fetch + WebSocket + parseArgs).
 */

import { parseArgs } from 'util';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help:  { type: 'boolean', short: 'h', default: false },
    delay: { type: 'string',  short: 'd', default: '0'   },
    dom:   { type: 'boolean',             default: false  },
    aria:  { type: 'boolean',             default: false  },
    host:  { type: 'string',              default: '127.0.0.1' },
    port:  { type: 'string',  short: 'p', default: '9222' },
  },
  allowPositionals: true,
});

const HELP = `
Usage: dom-grabber [options] [output-file]

Connects to a Chrome/Chromium browser with --remote-debugging-port enabled,
grabs the active tab and writes sanitized DOM and/or ARIA snapshots.

Options:
  -h, --help           Show this help message
  -d, --delay <secs>   Wait N seconds before capturing (default: 0)
      --dom            Capture DOM only  (dom-dump.html)
      --aria           Capture ARIA only (dom-dump.aria.yaml)
                       Default (no flag): capture both
  -p, --port <port>    Browser debug port (default: 9222)
      --host <host>    Browser debug host (default: 127.0.0.1)

Arguments:
  output-file          Base name for output files (default: dom-dump.html)
                         DOM:  <output-file>
                         ARIA: <output-file with .html replaced by .aria.yaml>

Examples:
  dom-grabber
  dom-grabber --delay 5
  dom-grabber --dom
  dom-grabber --aria
  dom-grabber --port 9223 --delay 2 my-page.html
  dom-grabber --host 192.168.1.100 --port 9222

Launch Chrome with debugging:
  chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
`.trim();

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const HOST       = values.host as string;
const PORT       = parseInt(values.port as string, 10);
const DELAY_SECS = parseInt(values.delay as string, 10);
const DOM_OUTPUT = positionals[0] ?? 'dom-dump.html';
const ARIA_OUTPUT = DOM_OUTPUT.replace(/(\.[^.]+)?$/, '.aria.yaml');

// No flag = both; explicit flags restrict to the requested artifact(s)
const CAPTURE_DOM  = !values.aria || (values.dom as boolean);
const CAPTURE_ARIA = !values.dom  || (values.aria as boolean);

// ---------------------------------------------------------------------------
// DOM sanitization — runs inside the browser via Runtime.evaluate
// ---------------------------------------------------------------------------
const SANITIZE_SCRIPT = /* js */ `
(() => {
  const REMOVE_TAGS = [
    'script','style','noscript','link','meta',
    'svg','canvas','template','iframe',
  ];
  const KEEP_ATTRS = new Set([
    'id','class','name','type','role',
    'href','src','alt','title','placeholder','value',
    'for','action','method',
    'disabled','required','checked','selected','multiple','readonly',
    'tabindex','target','rel',
  ]);
  const KEEP_DATA = new Set([
    'data-testid','data-test','data-test-id','data-qa','data-cy','data-id',
  ]);

  const clone = document.body.cloneNode(true);
  REMOVE_TAGS.forEach(tag => clone.querySelectorAll(tag).forEach(el => el.remove()));
  clone.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      const n = attr.name.toLowerCase();
      if (!KEEP_ATTRS.has(n) && !n.startsWith('aria-') && !KEEP_DATA.has(n))
        el.removeAttribute(attr.name);
    });
  });
  return clone.outerHTML;
})()
`;

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------
interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function getActiveTab(host: string, port: number): Promise<CdpTarget> {
  const res = await fetch(`http://${host}:${port}/json`);
  const targets = (await res.json()) as CdpTarget[];
  const real = targets.filter(
    (t) => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('devtools://')
  );
  if (real.length === 0) throw new Error('No real pages found. Open a web page in the browser.');

  console.log(`Found ${real.length} real tab(s):`);
  real.forEach((t, i) => console.log(`  [${i}] ${t.url}`));
  console.log(`\nUsing: ${real[0].url}`);
  return real[0];
}

function cdpSend<T>(wsUrl: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as {
        id: number;
        result?: T;
        error?: { message: string };
      };
      if (msg.id !== 1) return;
      ws.close();
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result as T);
    };

    ws.onerror = (err) => reject(err);
    ws.onclose = () => {};
  });
}

// ---------------------------------------------------------------------------
// ARIA snapshot — pure CDP + YAML formatter
// ---------------------------------------------------------------------------
interface AXValue { type: string; value: unknown }
interface AXNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  properties?: Array<{ name: string; value: AXValue }>;
}

const ROLE_MAP: Record<string, string> = {
  WebArea: 'document', RootWebArea: 'document',
  StaticText: 'text',
  InlineTextBox: '', LineBreak: '',
  GenericContainer: 'generic',
};

const USEFUL_PROPS = new Set([
  'level', 'checked', 'selected', 'expanded',
  'disabled', 'required', 'pressed', 'multiselectable', 'orientation',
]);

function buildAriaYaml(nodes: AXNode[]): string {
  const nodeMap = new Map(nodes.map((n) => [n.nodeId, n]));
  const visible = nodes.filter((n) => !n.ignored);

  // Walk up parentId chain, skipping ignored nodes, to find nearest visible ancestor
  function nearestVisibleParent(node: AXNode): AXNode | null {
    let cur = node.parentId ? nodeMap.get(node.parentId) : undefined;
    while (cur) {
      if (!cur.ignored) return cur;
      cur = cur.parentId ? nodeMap.get(cur.parentId) : undefined;
    }
    return null;
  }

  // Build parent → visible-children map
  const childrenOf = new Map<string, AXNode[]>();
  const roots: AXNode[] = [];

  visible.forEach((node) => {
    const parent = nearestVisibleParent(node);
    if (parent) {
      if (!childrenOf.has(parent.nodeId)) childrenOf.set(parent.nodeId, []);
      childrenOf.get(parent.nodeId)!.push(node);
    } else {
      roots.push(node);
    }
  });

  function formatNode(node: AXNode, indent: number): string {
    const rawRole = (node.role?.value as string) ?? 'generic';
    const role = rawRole in ROLE_MAP ? ROLE_MAP[rawRole] : rawRole.toLowerCase();
    if (!role) return '';

    const name = (node.name?.value as string | undefined)?.trim();
    const nameStr = name ? ` "${name}"` : '';

    const props: string[] = [];
    node.properties?.forEach((p) => {
      if (!USEFUL_PROPS.has(p.name)) return;
      const val = p.value.value;
      if (val === false || val === null || val === undefined) return;
      props.push(val === true ? p.name : `${p.name}=${val}`);
    });
    const propsStr = props.length > 0 ? ` [${props.join(', ')}]` : '';

    const children = childrenOf.get(node.nodeId) ?? [];
    const childLines = children
      .map((c) => formatNode(c, indent + 1))
      .filter((s) => s.length > 0)
      .join('\n');

    const prefix = '  '.repeat(indent) + '- ';
    if (!childLines && (role === 'text' || role === 'generic') && !name) return '';

    return childLines
      ? `${prefix}${role}${nameStr}${propsStr}:\n${childLines}`
      : `${prefix}${role}${nameStr}${propsStr}`;
  }

  return roots
    .map((r) => formatNode(r, 0))
    .filter((s) => s.length > 0)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
async function countdown(seconds: number): Promise<void> {
  if (seconds <= 0) return;
  process.stdout.write(`Waiting ${seconds}s before capture`);
  for (let i = seconds; i > 0; i--) {
    process.stdout.write(` ${i}...`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stdout.write('\n');
}

function kbSize(str: string): string {
  return (str.length / 1024).toFixed(1) + ' KB';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Connecting to Chrome at http://${HOST}:${PORT} ...\n`);

  if (DELAY_SECS > 0) await countdown(DELAY_SECS);

  const tab = await getActiveTab(HOST, PORT);
  let step = 1;
  const total = [CAPTURE_DOM, CAPTURE_ARIA].filter(Boolean).length;

  if (CAPTURE_DOM) {
    console.log(`\n[${step++}/${total}] Capturing DOM...`);

    const { result: rawSizeResult } = await cdpSend<{ result: { value: number } }>(
      tab.webSocketDebuggerUrl, 'Runtime.evaluate',
      { expression: 'document.documentElement.outerHTML.length', returnByValue: true }
    );
    const { result: cleanResult } = await cdpSend<{ result: { value: string } }>(
      tab.webSocketDebuggerUrl, 'Runtime.evaluate',
      { expression: SANITIZE_SCRIPT, returnByValue: true }
    );

    const rawKb = (rawSizeResult.value / 1024).toFixed(1);
    const cleanHtml = cleanResult.value;
    const pct = (((rawSizeResult.value - cleanHtml.length) / rawSizeResult.value) * 100).toFixed(0);

    fs.writeFileSync(path.resolve(DOM_OUTPUT), cleanHtml, 'utf-8');
    console.log(`  ✓ ${path.resolve(DOM_OUTPUT)} (${kbSize(cleanHtml)}, reduced from ${rawKb} KB — ${pct}% removed)`);
  }

  if (CAPTURE_ARIA) {
    console.log(`\n[${step}/${total}] Capturing ARIA snapshot...`);

    const result = await cdpSend<{ nodes: AXNode[] }>(
      tab.webSocketDebuggerUrl, 'Accessibility.getFullAXTree'
    );
    const ariaYaml = buildAriaYaml(result.nodes);

    fs.writeFileSync(path.resolve(ARIA_OUTPUT), ariaYaml, 'utf-8');
    console.log(`  ✓ ${path.resolve(ARIA_OUTPUT)} (${kbSize(ariaYaml)})`);
  }

  console.log('\nDone.');
}

main().catch((err: Error) => {
  console.error('Error:', err.message);
  process.exit(1);
});
