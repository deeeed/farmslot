import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';

import { isRecord } from '@farmslot/protocol';

import { RUNTIME_VERSION } from '../version.js';

import type { HostIdentity } from './ipc.js';
import { readJson, type RecordedProcess, recordedProcessAlive } from './storage.js';

export function nativeHostVersionSkew(host: HostIdentity) {
  return Object.assign(
    new Error(
      `Native host runtime version skew: node ${RUNTIME_VERSION}, host ${host.runtimeVersion ?? 'unknown (legacy)'}. ` +
        'Existing sessions remain available. Finish or close them, then redeploy the node to refresh its idle native host.',
    ),
    { code: 'NATIVE_HOST_VERSION_SKEW' },
  );
}

export function assertNativeHostRuntime(host: HostIdentity): void {
  if (host.runtimeVersion !== RUNTIME_VERSION) throw nativeHostVersionSkew(host);
}

/** Lifecycle only, before the node registers: no new admissions can race this census. */
export async function retireIdleNativeHost(root: string, host: HostIdentity): Promise<boolean> {
  // Legacy hosts have no version or idle RPC. Read their durable stop evidence once at startup;
  // never repair/truncate journals, infer a stop from a missing process, or scan on admission.
  const sessions = join(root, 'sessions');
  if (existsSync(sessions)) {
    for (const name of readdirSync(sessions).filter((name) => name.endsWith('.journal'))) {
      const text = readFileSync(join(sessions, name), 'utf8');
      if (!text) continue;
      if (!text.endsWith('\n')) return false;
      let info: Record<string, unknown> | undefined;
      for (const line of text.split('\n').filter(Boolean)) {
        const entry: unknown = JSON.parse(line);
        if (isRecord(entry) && isRecord(entry.info)) info = entry.info;
      }
      if (!info || info.processStopped !== true) return false;
    }
  }
  const supervisor = readJson<RecordedProcess>(join(root, 'lock', 'owner.json'));
  const worker = readJson<RecordedProcess>(join(root, 'worker.json'));
  if (
    supervisor.pid !== host.pid ||
    !supervisor.identity ||
    !worker.identity ||
    !recordedProcessAlive(supervisor) ||
    !recordedProcessAlive(worker)
  )
    throw new Error('Native host upgrade refused: process ownership is unconfirmed');
  const command = execFileSync('ps', ['-p', String(supervisor.pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!command.includes('/native/supervisor.') || !command.endsWith(` ${root}`))
    throw new Error('Native host upgrade refused: supervisor does not own this state directory');
  const current = readJson<HostIdentity>(join(root, 'host.json'));
  if (current.pid !== host.pid || current.token !== host.token)
    throw new Error('Native host changed during upgrade; retry the node deployment');

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
    const watcher = watch(root, { recursive: true }, check);
    const timeout = setTimeout(
      () => finish(new Error('Native host cleanup timed out; no replacement was started')),
      10_000,
    );
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
