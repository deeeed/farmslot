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
 * it running; `refreshes` says when the refusing service refreshes it on its own.
 */
export function nativeHostVersionSkew(
  host: HostIdentity,
  busy: readonly string[] = [],
  refreshes = 'It is refreshed when its service next starts, once every runner has stopped.',
) {
  return Object.assign(
    new Error(
      `Native host runtime version skew: node ${RUNTIME_VERSION} (build ${currentRuntimeBuild().slice(0, 12)}), host ${host.runtimeVersion ?? 'unknown (legacy)'} (build ${host.runtimeBuild?.slice(0, 12) ?? 'unknown'}). ` +
        `Existing sessions remain available; new launches fail until the host is refreshed. ${refreshes} ` +
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
  return (await stopNativeHost(root, host, 'admissions')).stopped;
}

/**
 * Lifecycle only: stop a host whose live sessions the caller found idle. The supervisor's
 * cleanup stops each idle runner and confirms it; the next host keeps their journals and
 * reports them for resume. A host that supports it fences admissions and new input first and
 * names any session still busy (sending, compacting, finishing a turn, asked). An older host
 * fences only once every runner has stopped, so the caller's own checks and admission lock
 * are all that stand between its snapshot and the stop.
 */
export function stopIdleSessionsNativeHost(
  root: string,
  host: HostIdentity,
): Promise<{ stopped: boolean; busy: string[] }> {
  return stopNativeHost(root, host, host.supportsIdleRunnerUpgrade ? 'idle-runners' : 'none');
}

async function stopNativeHost(
  root: string,
  host: HostIdentity,
  fence: 'admissions' | 'idle-runners' | 'none',
): Promise<{ stopped: boolean; busy: string[] }> {
  const unverified = { stopped: false, busy: [] };
  const supervisor = readJson<RecordedProcess>(join(root, 'lock', 'owner.json'));
  const worker = readJson<RecordedProcess>(join(root, 'worker.json'));
  if (
    supervisor.pid !== host.pid ||
    !supervisor.identity ||
    !worker.identity ||
    !recordedProcessAlive(supervisor) ||
    !recordedProcessAlive(worker)
  )
    return unverified;
  const command = execFileSync('ps', ['-p', String(supervisor.pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!command.includes('/native/supervisor.') || !command.endsWith(` ${root}`)) return unverified;
  const current = readJson<HostIdentity>(join(root, 'host.json'));
  if (current.pid !== host.pid || current.token !== host.token) return unverified;

  if (fence !== 'none') {
    const prepared = await requestHost<{ idle: boolean; busy?: string[] }>(host, {
      method: 'prepareUpgrade',
      owner: 'node-runtime-upgrade',
      ...(fence === 'idle-runners' ? { idleRunners: true } : {}),
    });
    if (prepared.idle !== true) return { stopped: false, busy: prepared.busy ?? [] };
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
  return { stopped: true, busy: [] };
}
