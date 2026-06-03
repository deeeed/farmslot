import { execSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/** Take a single screenshot for thumbnail use. Returns base64 PNG. */
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
    pngBuf = execSync(`adb -s ${serial} exec-out screencap -p`, { maxBuffer: 10 * 1024 * 1024 });
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
                  const children = execSync(`pgrep -P ${parsed}`, { timeout: 2000 })
                    .toString()
                    .trim()
                    .split('\n');
                  for (const c of children) {
                    const cp = parseInt(c, 10);
                    if (isNaN(cp)) continue;
                    const comm = execSync(`ps -p ${cp} -o comm=`, { timeout: 2000 })
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
    const tabsJson = execSync(`curl -sf http://localhost:${cdpPort}/json`, { timeout: 3_000 })
      .toString()
      .trim();
    const tabs = JSON.parse(tabsJson) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
    const pageTab = tabs.find((t) => t.type === 'page') ?? tabs[0];
    const wsUrl = pageTab?.webSocketDebuggerUrl;
    if (!wsUrl || !wsUrl.startsWith('ws://')) throw new Error('No valid CDP target found');
    // Use Node to call Page.captureScreenshot via CDP WebSocket
    const nodeModules = resolve(process.cwd(), 'node_modules');
    const nodeBin = process.execPath;
    const screenshotB64 = execSync(
      `"${nodeBin}" -e "const W=require('ws');const c=new W('${wsUrl}');const t=setTimeout(()=>process.exit(1),5000);c.on('open',()=>c.send(JSON.stringify({id:1,method:'Page.captureScreenshot',params:{format:'png',quality:80}})));c.on('message',d=>{const r=JSON.parse(d);if(r.id===1){clearTimeout(t);process.stdout.write(r.result?.data||'',()=>{c.close();process.exit(0)})}})"`,
      {
        timeout: 8_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, NODE_PATH: nodeModules },
      },
    ).toString();
    if (!screenshotB64) throw new Error('CDP screenshot returned empty');
    pngBuf = Buffer.from(screenshotB64, 'base64');
  } else {
    // iOS simulator — use temp file (piping to /dev/stdout fails on some machines)
    const simName = (params.iosSimulator as string) ?? (params.slotId as string);
    const tmp = resolve(tmpdir(), `farmslot-thumb-sim-${Date.now()}.png`);
    try {
      execSync(`xcrun simctl io "${simName}" screenshot --type=png "${tmp}"`, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 10_000,
      });
      pngBuf = readFileSync(tmp);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  // Resize with sips (macOS) if needed
  if (process.platform === 'darwin' && maxWidth > 0) {
    const tmp = resolve(tmpdir(), `farmslot-thumb-resize-${Date.now()}.png`);
    try {
      writeFileSync(tmp, pngBuf);
      execSync(`sips -Z ${maxWidth} "${tmp}" --out "${tmp}" 2>/dev/null`, { timeout: 5_000 });
      pngBuf = readFileSync(tmp);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    data: pngBuf.toString('base64'),
    width: maxWidth,
    height: 0, // actual dimensions in the PNG
    timestamp: Date.now(),
  };
}
