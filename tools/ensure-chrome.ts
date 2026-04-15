/**
 * ensure-chrome — idempotent "CDP is live" guarantee.
 *
 * Checks whether Chrome is reachable at the debug port; if not, launches
 * Chrome with CDP enabled (using the same persistent profile dir as the
 * shipped launcher) and waits for it to come up.
 *
 * Intended to be imported by every tool that talks to CDP so the user
 * never has to start Chrome manually. Opt out by setting NO_AUTO_CHROME=1.
 *
 * Windows: uses ${CLAUDE_PLUGIN_ROOT}/tools/start-chrome-debug.bat — the
 *          same launcher the user would run manually, so the profile dir
 *          matches (%TEMP%\chrome-debug) and auth state is preserved.
 * macOS:   open -na "Google Chrome" --args --remote-debugging-port=<port>
 *          --user-data-dir=/tmp/chrome-debug
 * Linux:   google-chrome (fallback chromium) with the same flags.
 */
import { spawn } from 'child_process';
import { platform } from 'os';
import * as path from 'path';

export interface EnsureChromeOptions {
  host?: string;
  port?: string | number;
  timeoutMs?: number;
  /** Override the Windows launcher path. Defaults to sibling start-chrome-debug.bat. */
  launcherPath?: string;
  /** Suppress stderr logging when we auto-launch. Default: false. */
  quiet?: boolean;
}

async function isCdpReachable(host: string, port: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function launchChrome(port: string, launcherPath: string, quiet: boolean): void {
  const plat = platform();
  const log = (msg: string) => { if (!quiet) process.stderr.write(`[ensure-chrome] ${msg}\n`); };

  if (plat === 'win32') {
    log(`launching via ${launcherPath}`);
    // cmd /c start "" "path\to\start-chrome-debug.bat" — detached, no window.
    const child = spawn('cmd.exe', ['/c', 'start', '""', '/B', launcherPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return;
  }

  if (plat === 'darwin') {
    log(`launching Google Chrome on macOS with CDP port ${port}`);
    const child = spawn('open', [
      '-na', 'Google Chrome',
      '--args',
      `--remote-debugging-port=${port}`,
      '--user-data-dir=/tmp/chrome-debug',
      '--no-first-run',
      '--no-default-browser-check',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }

  // Linux — try google-chrome then chromium. Spawn through /bin/sh so the
  // || fallback happens in the child shell, not in our process.
  log(`launching Chrome/Chromium on Linux with CDP port ${port}`);
  const cmd = `(google-chrome --remote-debugging-port=${port} --user-data-dir=/tmp/chrome-debug --no-first-run --no-default-browser-check >/dev/null 2>&1 & ) ` +
              `|| (chromium --remote-debugging-port=${port} --user-data-dir=/tmp/chrome-debug --no-first-run --no-default-browser-check >/dev/null 2>&1 & ) ` +
              `|| (chromium-browser --remote-debugging-port=${port} --user-data-dir=/tmp/chrome-debug --no-first-run --no-default-browser-check >/dev/null 2>&1 & )`;
  const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'ignore' });
  child.unref();
}

export async function ensureChrome(opts: EnsureChromeOptions = {}): Promise<void> {
  if (process.env.NO_AUTO_CHROME === '1') {
    // Still do a reachability probe so callers can fail fast if CDP is down.
    const host = opts.host ?? '127.0.0.1';
    const port = String(opts.port ?? '9222');
    if (await isCdpReachable(host, port)) return;
    throw new Error(
      `CDP not reachable at http://${host}:${port} and NO_AUTO_CHROME=1 is set. Start Chrome manually.`
    );
  }

  const host = opts.host ?? '127.0.0.1';
  const port = String(opts.port ?? '9222');
  const timeoutMs = opts.timeoutMs ?? 15000;
  const quiet = opts.quiet ?? false;
  const launcherPath = opts.launcherPath ?? path.join(__dirname, 'start-chrome-debug.bat');

  if (await isCdpReachable(host, port)) return;

  launchChrome(port, launcherPath, quiet);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300));
    if (await isCdpReachable(host, port)) {
      if (!quiet) process.stderr.write(`[ensure-chrome] CDP up at http://${host}:${port}\n`);
      return;
    }
  }
  throw new Error(
    `Chrome failed to start within ${timeoutMs}ms on ${host}:${port}. ` +
    `Try launching manually: on Windows run ${launcherPath}; on Linux/macOS see the skill's Prerequisites.`
  );
}
