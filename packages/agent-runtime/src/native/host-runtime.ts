import { execFileSync } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';

import { RUNTIME_VERSION } from '../version.js';

import { NATIVE_HOST_VERSION_SKEW } from './host-unavailable.js';
import { type HostIdentity, requestHost } from './ipc.js';
import { currentRuntimeBuild } from './runtime-build.js';
import { readJson, type RecordedProcess, recordedProcessAlive } from './storage.js';

/**
 * New launches refused by a host on another runtime. `busy` names the live sessions that keep
 * it from refreshing on its own; an empty list means it refreshes once its sessions go idle.
 */
export function nativeHostVersionSkew(host: HostIdentity, busy: readonly string[] = []) {
  return Object.assign(
    new Error(
      `Native host runtime version skew: node ${RUNTIME_VERSION} (build ${currentRuntimeBuild().slice(0, 12)}), host ${host.runtimeVersion ?? 'unknown (legacy)'} (build ${host.runtimeBuild?.slice(0, 12) ?? 'unknown'}). ` +
        'Existing sessions remain available; new launches wait for the host to refresh, which it does on its own once no live session is busy. ' +
        (busy.length ? `Busy: ${busy.join('; ')}. ` : '') +
        'See docs/operations/native-host-refresh.md.',
    ),
    { code: NATIVE_HOST_VERSION_SKEW },
  );
}

/** The host runs this installed runtime: the same version and the same built code. */
export function nativeHostRunsCurrentRuntime(host: HostIdentity): boolean {
  return host.runtimeVersion === RUNTIME_VERSION && host.runtimeBuild === currentRuntimeBuild();
}

export function assertNativeHostRuntime(host: HostIdentity): void {
  if (!nativeHostRunsCurrentRuntime(host)) throw nativeHostVersionSkew(host);
}

/** Lifecycle only: stop only after the running host atomically fences its admissions. */
export async function retireIdleNativeHost(root: string, host: HostIdentity): Promise<boolean> {
  // Only the running host can fence admissions and account for launches before their
  // first reservation. A legacy journal census cannot establish quiescence.
  if (!host.supportsRuntimeUpgrade) return false;
  return stopNativeHost(root, host, true);
}

/**
 * Lifecycle only: stop a host whose live sessions the caller found idle, under the caller's
 * own admission lock (a skewed host gets no new admissions from it). The supervisor's cleanup
 * stops each idle runner and confirms it; the next host keeps their journals and reports them
 * for resume. Unlike retireIdleNativeHost there is no host-side fence: an older host only
 * fences once every runner process has already stopped.
 */
export function stopIdleSessionsNativeHost(root: string, host: HostIdentity): Promise<boolean> {
  return stopNativeHost(root, host, false);
}

async function stopNativeHost(
  root: string,
  host: HostIdentity,
  fenceAdmissions: boolean,
): Promise<boolean> {
  const supervisor = readJson<RecordedProcess>(join(root, 'lock', 'owner.json'));
  const worker = readJson<RecordedProcess>(join(root, 'worker.json'));
  if (
    supervisor.pid !== host.pid ||
    !supervisor.identity ||
    !worker.identity ||
    !recordedProcessAlive(supervisor) ||
    !recordedProcessAlive(worker)
  )
    return false;
  const command = execFileSync('ps', ['-p', String(supervisor.pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!command.includes('/native/supervisor.') || !command.endsWith(` ${root}`)) return false;
  const current = readJson<HostIdentity>(join(root, 'host.json'));
  if (current.pid !== host.pid || current.token !== host.token) return false;

  if (fenceAdmissions) {
    const prepared = await requestHost<{ idle: boolean }>(host, {
      method: 'prepareUpgrade',
      owner: 'node-runtime-upgrade',
    });
    if (prepared.idle !== true) return false;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      watcher.close();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const check = () => {
      try {
        if (existsSync(join(root, 'lock'))) return;
        const cleanup = readJson<{ state: string; hostPid: number }>(join(root, 'cleanup.json'));
        if (cleanup.state !== 'complete' || cleanup.hostPid !== worker.pid)
          throw new Error('Native host cleanup is unconfirmed; no replacement was started');
        finish();
      } catch (error) {
        finish(error);
      }
    };
    // Lock removal and cleanup.json publication both change direct children of root.
    const watcher = watch(root, check);
    const timeout = setTimeout(() => {
      check();
      if (!settled) finish(new Error('Native host cleanup timed out; no replacement was started'));
    }, 10_000);
    watcher.once('error', finish);
    try {
      process.kill(supervisor.pid, 'SIGTERM');
      check();
    } catch (error) {
      finish(error);
    }
  });
  if (recordedProcessAlive(worker))
    throw new Error('Native host cleanup is unconfirmed; previous host is still alive');
  return true;
}
