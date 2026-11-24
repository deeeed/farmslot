import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Run a capture tool without blocking the node's event loop. These calls used
 * `execSync`: an iOS screenshot of a simulator that is not booted hangs until
 * its 10 s timeout, and every 15 s thumbnail poll froze the whole node for that
 * long. Every other request it was serving (a support-bundle cleanup `rm -f`,
 * the simulator inventory) then hit its own 10 s timeout.
 */
function run(
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
): Promise<Buffer> {
  return new Promise((resolveRun, reject) => {
    execFile(
      file,
      args,
      { ...options, encoding: 'buffer', maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.toString().trim();
          reject(
            new Error(
              `${file} ${args[0] ?? ''} failed: ${error.message}${detail ? `: ${detail}` : ''}`,
            ),
          );
          return;
        }
        resolveRun(stdout);
      },
    );
  });
}

/** Whether `xcrun simctl` lists this simulator, by name or UDID, as booted. */
async function simulatorBooted(simulator: string): Promise<boolean> {
  const listed = JSON.parse(
    (
      await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { timeout: 10_000 })
    ).toString(),
  ) as { devices?: Record<string, Array<{ name?: string; udid?: string; state?: string }>> };
  return Object.values(listed.devices ?? {}).some((devices) =>
    devices.some(
      (device) =>
        device.state === 'Booted' && (device.name === simulator || device.udid === simulator),
    ),
  );
}

export async function screenshotForSlot(params: Record<string, unknown>): Promise<{
  data: string;
  width: number;
  height: number;
  timestamp: number;
}> {
  const platform = (params.platform as string) ?? 'ios';
  const maxWidth = (params.maxWidth as number) ?? 180;

  let pngBuf: Buffer;

  if (platform === 'android') {
    const serial = params.androidSerial as string;
    if (!serial) throw new Error('No androidSerial for thumbnail');
    pngBuf = await run('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 10_000 });
  } else if (platform === 'chrome-extension' || platform === 'web') {
    let pid = params.browserPid as number | undefined;
    // Resolve PID locally if not provided by gateway (remote slots)
    if (!pid) {
      const repo = params.repo as string | undefined;
      const rtDir = params.runtimeDir as string | undefined;
      if (repo && rtDir) {
        const pidDir = resolve(repo, rtDir);
        try {
          // Try chromium.pid first (direct browser PID), then browser.pid + child walk
          const chromPidFile = resolve(pidDir, 'chromium.pid');
          const browserPidFile = resolve(pidDir, 'browser.pid');
          try {
            const raw = readFileSync(chromPidFile, 'utf-8').trim();
            const parsed = parseInt(raw, 10);
            if (!isNaN(parsed)) pid = parsed; // chromium.pid IS the browser — no child-walk
          } catch {
            // No chromium.pid — try browser.pid (launcher) + child-walk
            try {
              const raw = readFileSync(browserPidFile, 'utf-8').trim();
              const parsed = parseInt(raw, 10);
              if (!isNaN(parsed)) {
                try {
                  const children = (await run('pgrep', ['-P', String(parsed)], { timeout: 2000 }))
                    .toString()
                    .trim()
                    .split('\n');
                  for (const c of children) {
                    const cp = parseInt(c, 10);
                    if (isNaN(cp)) continue;
                    const comm = (
                      await run('ps', ['-p', String(cp), '-o', 'comm='], { timeout: 2000 })
                    )
                      .toString()
                      .trim();
                    if (/[Cc]hrom/.test(comm)) {
                      pid = cp;
                      break;
                    }
                  }
                } catch {
                  /* pgrep failed */
                }
                if (!pid) pid = parsed;
              }
            } catch {
              /* no pid file */
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
    // Use CDP to screenshot the browser — no TCC needed, no capture-helper
    const cdpPort = params.cdpPort as number | undefined;
    if (!cdpPort) throw new Error('No cdpPort for browser thumbnail');
    // Get the visible page's WS URL via CDP HTTP API (skip service workers, offscreen, iframes)
    const tabsJson = (
      await run('curl', ['-sf', `http://localhost:${cdpPort}/json`], { timeout: 3_000 })
    )
      .toString()
      .trim();
    const tabs = JSON.parse(tabsJson) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
    const pageTab = tabs.find((t) => t.type === 'page') ?? tabs[0];
    const wsUrl = pageTab?.webSocketDebuggerUrl;
    if (!wsUrl || !wsUrl.startsWith('ws://')) throw new Error('No valid CDP target found');
    // Use Node to call Page.captureScreenshot via CDP WebSocket
    const nodeModules = resolve(process.cwd(), 'node_modules');
    const nodeBin = process.execPath;
    // The target URL is an argument, never part of the script text.
    const screenshotB64 = (
      await run(
        nodeBin,
        [
          '-e',
          "const W=require('ws');const c=new W(process.argv[1]);const t=setTimeout(()=>process.exit(1),5000);c.on('open',()=>c.send(JSON.stringify({id:1,method:'Page.captureScreenshot',params:{format:'png',quality:80}})));c.on('message',d=>{const r=JSON.parse(d);if(r.id===1){clearTimeout(t);process.stdout.write(r.result?.data||'',()=>{c.close();process.exit(0)})}})",
          wsUrl,
        ],
        { timeout: 8_000, env: { ...process.env, NODE_PATH: nodeModules } },
      )
    ).toString();
    if (!screenshotB64) throw new Error('CDP screenshot returned empty');
    pngBuf = Buffer.from(screenshotB64, 'base64');
  } else if (platform === 'ios') {
    // iOS simulator — use temp file (piping to /dev/stdout fails on some machines)
    const simName = (params.iosSimulator as string) ?? (params.slotId as string);
    // `simctl io` on a simulator that is not booted hangs instead of failing.
    if (!(await simulatorBooted(simName)))
      throw new Error(`iOS simulator ${simName} is not booted`);
    const tmp = resolve(tmpdir(), `farmslot-thumb-sim-${Date.now()}-${randomUUID()}.png`);
    try {
      await run('xcrun', ['simctl', 'io', simName, 'screenshot', '--type=png', tmp], {
        timeout: 10_000,
      });
      pngBuf = await readFile(tmp);
    } finally {
      await rm(tmp, { force: true });
    }
  } else {
    throw new Error(`Unsupported thumbnail platform: ${platform}`);
  }

  // Resize with sips (macOS) if needed
  if (process.platform === 'darwin' && maxWidth > 0) {
    const tmp = resolve(tmpdir(), `farmslot-thumb-resize-${Date.now()}-${randomUUID()}.png`);
    try {
      await writeFile(tmp, pngBuf);
      await run('sips', ['-Z', String(maxWidth), tmp, '--out', tmp], { timeout: 5_000 });
      pngBuf = await readFile(tmp);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  return {
    data: pngBuf.toString('base64'),
    width: maxWidth,
    height: 0, // actual dimensions in the PNG
    timestamp: Date.now(),
  };
}
