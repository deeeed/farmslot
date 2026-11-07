import * as pty from 'node-pty';

import {
  type ExecResult,
  NodeLinkFailure,
  type NodeLinkProcessInput,
  type NodeLinkProcessUpdate,
  type NodeLinkTerminalSize,
} from '@farmslot/protocol';
import { ensureNodePtySpawnHelpersExecutable } from '@farmslot/protocol/node/node-pty-helper';

import { resolveLoginEnvironment } from '../commands/exec.js';

export interface NodeLinkTerminal {
  result: Promise<ExecResult>;
  resize(size: NodeLinkTerminalSize): void;
}

/** Owns only the attached client process. Detaching tmux leaves the worker running. */
export async function openNodeLinkTerminal(
  input: NodeLinkProcessInput,
  signal: AbortSignal,
  output: (update: NodeLinkProcessUpdate, signal: AbortSignal) => Promise<void>,
): Promise<NodeLinkTerminal> {
  if (!input.terminal)
    throw new NodeLinkFailure('INVALID_PARAMS', 'Terminal dimensions are required.');
  signal.throwIfAborted();
  const login = await resolveLoginEnvironment();
  signal.throwIfAborted();
  const environment =
    input.environment === 'login'
      ? { ...process.env, ...login }
      : { ...process.env, PATH: login.PATH };
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment))
    if (value !== undefined && !['FORCE_COLOR', 'SHLVL', 'PWD', 'OLDPWD', '_'].includes(name))
      env[name] = value;
  ensureNodePtySpawnHelpersExecutable(import.meta.url);
  const client = pty.spawn(input.argv[0], input.argv.slice(1), {
    name: 'xterm-256color',
    cwd: input.cwd,
    env,
    cols: input.terminal.cols,
    rows: input.terminal.rows,
  });
  const deliveryAbort = new AbortController();
  let bytes = 0;
  let tail = '';
  let reason: string | undefined;
  let stopped = false;
  let exited = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (message: string) => {
    if (stopped) return;
    stopped = true;
    reason = message;
    deliveryAbort.abort(new NodeLinkFailure('TERMINAL_CLOSED', message));
    client.resume();
    if (!exited) {
      client.kill('SIGHUP');
      killTimer = setTimeout(() => {
        if (!exited) client.kill('SIGKILL');
      }, 1000);
      killTimer.unref();
    }
  };
  const abort = () => stop('Terminal attachment cancelled.');
  signal.addEventListener('abort', abort, { once: true });
  // Start paused so the structured started event precedes terminal data.
  client.pause();
  let delivery = output({ kind: 'started', stream: 'stdout', text: '' }, deliveryAbort.signal);
  const result = new Promise<ExecResult>((resolve) => {
    const timeout = setTimeout(() => stop('Terminal attachment timed out.'), input.timeoutMs);
    timeout.unref();
    const data = client.onData((text) => {
      if (stopped) return;
      bytes += Buffer.byteLength(text);
      if (bytes > input.maxOutputBytes) {
        stop('Terminal output limit reached.');
        return;
      }
      // Terminal output is streamed, not returned as an ever-growing transcript.
      tail = (tail + text).slice(-8000);
      client.pause();
      delivery = delivery.then(() =>
        output({ kind: 'output', stream: 'stdout', text }, deliveryAbort.signal),
      );
      void delivery.then(
        () => {
          if (!stopped) client.resume();
        },
        (error: unknown) => {
          if (!stopped)
            stop(
              `Terminal output delivery failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        },
      );
    });
    const exit = client.onExit(({ exitCode }) => {
      exited = true;
      data.dispose();
      exit.dispose();
      const finish = () => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener('abort', abort);
        resolve({
          exitCode: signal.aborted ? 130 : reason ? 1 : exitCode,
          stdout: tail,
          stderr: reason ?? '',
        });
      };
      // Process exit does not prove the final output reached its consumer.
      void delivery.then(finish, (error: unknown) => {
        stop(
          `Terminal output delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        finish();
      });
    });
    void delivery.then(
      () => {
        if (!stopped) client.resume();
      },
      (error: unknown) => {
        stop(
          `Terminal start delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  });
  if (signal.aborted) abort();
  return {
    result,
    resize: (size) => {
      if (stopped || exited)
        throw new NodeLinkFailure('TERMINAL_CLOSED', 'Terminal attachment is closed.');
      client.resize(size.cols, size.rows);
    },
  };
}
