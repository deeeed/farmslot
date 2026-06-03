import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ScreenCaptureConfig } from './screen-types.js';

function isPidAlive(pid: number): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolvePidFromFiles(repo: string, runtimeDir: string): number | null {
  const pidDir = resolve(repo, runtimeDir);
  try {
    const raw = readFileSync(resolve(pidDir, 'chromium.pid'), 'utf-8').trim();
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && isPidAlive(parsed)) return parsed;
  } catch {
    /* no chromium.pid */
  }
  try {
    const raw = readFileSync(resolve(pidDir, 'browser.pid'), 'utf-8').trim();
    const parent = parseInt(raw, 10);
    if (isNaN(parent)) return null;
    try {
      const children = execSync(`pgrep -P ${parent}`, { timeout: 2000 })
        .toString()
        .trim()
        .split('\n');
      for (const c of children) {
        const cp = parseInt(c, 10);
        if (isNaN(cp)) continue;
        const comm = execSync(`ps -p ${cp} -o comm=`, { timeout: 2000 }).toString().trim();
        if (/[Cc]hrom/.test(comm) && isPidAlive(cp)) return cp;
      }
    } catch {
      /* pgrep failed */
    }
    if (isPidAlive(parent)) return parent;
  } catch {
    /* no browser.pid */
  }
  return null;
}

function resolvePidFromLsof(cdpPort: number): number | null {
  try {
    const out = execSync(`/usr/sbin/lsof -ti tcp:${cdpPort} -sTCP:LISTEN | head -1`, {
      timeout: 2000,
    })
      .toString()
      .trim();
    if (!out) return null;
    const pid = parseInt(out, 10);
    if (!isNaN(pid) && isPidAlive(pid)) return pid;
  } catch {
    /* lsof failed */
  }
  return null;
}

/** Validate incoming browserPid; fall back to local pid files + lsof on cdpPort.
 * Throws a descriptive error when no live browser PID can be resolved. */
export function ensureLiveBrowserPid(config: ScreenCaptureConfig): number {
  const { slotId, browserPid, cdpPort, repo, runtimeDir } = config;
  if (browserPid && isPidAlive(browserPid)) return browserPid;

  const stale = browserPid ?? null;

  if (repo && runtimeDir) {
    const fromFile = resolvePidFromFiles(repo, runtimeDir);
    if (fromFile) {
      console.warn(
        `[screen] pid-stale slot=${slotId} requested=${stale} resolved=${fromFile} source=pid-file`,
      );
      return fromFile;
    }
  }

  if (cdpPort) {
    const fromLsof = resolvePidFromLsof(cdpPort);
    if (fromLsof) {
      console.warn(
        `[screen] pid-stale slot=${slotId} requested=${stale} resolved=${fromLsof} source=lsof cdpPort=${cdpPort}`,
      );
      if (repo && runtimeDir) {
        // Rewrite the canonical pid-file watched by project.json (browser.pid) plus the
        // chromium.pid duplicate written by launch-browser.sh. Without browser.pid the
        // pid-file watcher, health probe, and teardown hook keep seeing the stale pid.
        const pidStr = String(fromLsof);
        try {
          writeFileSync(resolve(repo, runtimeDir, 'browser.pid'), pidStr);
        } catch {
          /* non-fatal */
        }
        try {
          writeFileSync(resolve(repo, runtimeDir, 'chromium.pid'), pidStr);
        } catch {
          /* non-fatal */
        }
      }
      return fromLsof;
    }
  }

  throw new Error(
    `no live browser for slot=${slotId} requested=${stale} cdpPort=${cdpPort ?? 'none'} repo=${repo ?? 'none'} — launch-browser.sh must run before capture`,
  );
}
