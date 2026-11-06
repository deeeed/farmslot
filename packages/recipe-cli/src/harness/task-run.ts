import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { isRecord } from '@farmslot/protocol';

import { harnessHost } from './host.js';

export interface TaskRunBinding {
  id: string;
  project: string;
  slotId?: string;
}

/** The control plane supplies terminality; task viewers do not interpret branch or worker text. */
export interface TaskRunLifecycle extends TaskRunBinding {
  status: string;
  terminal: boolean;
}

export interface TaskRunObserver {
  current(): TaskRunLifecycle | undefined;
  onChange?(listener: () => void): () => void;
  close(): Promise<void>;
}

/** One public CLI stream reuses its authenticated client; no task-view credential handling. */
export async function observeTaskRun(
  binding: TaskRunBinding,
  signal?: AbortSignal,
): Promise<TaskRunObserver> {
  let snapshot: TaskRunLifecycle | undefined;
  const listeners = new Set<() => void>();
  const update = (value: TaskRunLifecycle | undefined) => {
    if (JSON.stringify(snapshot) === JSON.stringify(value)) return;
    snapshot = value;
    for (const listener of listeners) listener();
  };
  let closing = false;
  let ready: () => void = () => {};
  const initialized = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const child = spawn(
    process.env.FARMSLOT_CLI || 'farmslot',
    [...(harnessHost().taskRunCliArgs ?? []), '--json', 'run', 'get', '--watch', '--', binding.id],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
      env: { ...process.env, FARMSLOT_TASK_WATCH_PIPE: '1' },
    },
  );
  const lines = createInterface({ input: child.stdout });
  let force: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    force ??= setTimeout(() => child.kill('SIGKILL'), 250);
    force.unref();
  };
  const fail = () => {
    update(undefined);
    ready();
  };
  // Errors are represented as unavailable lifecycle; local task facts remain readable.
  child.on('error', fail);
  child.stderr.resume();
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => {
      if (!closing && !snapshot?.terminal) fail();
      if (force) clearTimeout(force);
      ready();
      resolve();
    }),
  );
  lines.on('line', (line) => {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      fail();
      terminate();
      return;
    }
    const run =
      isRecord(frame) && frame.status === 'ok' && isRecord(frame.data) ? frame.data.run : undefined;
    if (
      !isRecord(run) ||
      run.id !== binding.id ||
      run.project !== binding.project ||
      typeof run.status !== 'string' ||
      typeof run.terminal !== 'boolean'
    ) {
      fail();
      terminate();
      return;
    }
    update({
      id: binding.id,
      project: binding.project,
      ...(typeof run.slotId === 'string' ? { slotId: run.slotId } : {}),
      status: run.status,
      terminal: run.terminal,
    });
    ready();
  });
  const startup = setTimeout(() => {
    fail();
    terminate();
  }, 5000);
  await initialized;
  clearTimeout(startup);
  return {
    current: () => snapshot,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      closing = true;
      lines.close();
      terminate();
      await closed;
    },
  };
}
