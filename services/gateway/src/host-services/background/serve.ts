// The gateway-background process's request loop (child.ts runs it with the real handlers). It
// answers operation requests over IPC and exits with its parent. It never registers as the gateway
// status process, so a shared fleet status write from here is refused by assertStatusFileWritable.
import type { ChildProcess } from 'node:child_process';

import type { ExecutionKind } from '@farmslot/protocol/performance';

import { ownLocalCommands, signalProcessGroup } from '../../core/exec.js';
import { gatewayPerformance } from '../../observability/performance.js';

import type { BackgroundHandlers } from './handlers.js';
import type {
  BackgroundChildMessage,
  BackgroundOperation,
  BackgroundParentMessage,
  BackgroundRequestMessage,
  ExecTally,
} from './protocol.js';

type ExecCounters = Map<ExecutionKind, { calls: number; seconds: number }>;

/** This process's exec counters by kind (commands here run outside any gateway request). */
function execCounters(): ExecCounters {
  const counters: ExecCounters = new Map();
  for (const counter of gatewayPerformance.snapshot().counters) {
    const kind = counter.labels.kind;
    if (!kind) continue;
    const field =
      counter.name === 'farmslot_exec_calls_total'
        ? 'calls'
        : counter.name === 'farmslot_exec_seconds_total'
          ? 'seconds'
          : undefined;
    if (!field) continue;
    const entry = counters.get(kind) ?? { calls: 0, seconds: 0 };
    entry[field] += counter.value;
    counters.set(kind, entry);
  }
  return counters;
}

export interface ServeOptions {
  /**
   * The pid each command's guard watches; this process by default. Tests point it at a process
   * that outlives this one, to prove this process's own cleanup without the guards.
   */
  guardOwnerPid?: number;
}

/**
 * Serve requests with `handlers`. `commandOperations` are the operations that run commands: the
 * child attributes its exec counters to the completing request of one of these.
 */
export function serveBackgroundRequests(
  handlers: BackgroundHandlers,
  commandOperations: ReadonlySet<BackgroundOperation>,
  options: ServeOptions = {},
): void {
  const send = process.send?.bind(process);
  if (!send) throw new Error('The gateway background process must be forked with an IPC channel');
  const post = (message: BackgroundChildMessage) => send(message);

  let reported = execCounters();
  function execDelta(operation: BackgroundOperation): ExecTally {
    if (!commandOperations.has(operation)) return {};
    const current = execCounters();
    const tally: ExecTally = {};
    for (const [kind, value] of current) {
      const before = reported.get(kind) ?? { calls: 0, seconds: 0 };
      if (value.calls === before.calls && value.seconds === before.seconds) continue;
      tally[kind] = { calls: value.calls - before.calls, seconds: value.seconds - before.seconds };
    }
    reported = current;
    return tally;
  }

  function run(request: BackgroundRequestMessage): Promise<unknown> {
    switch (request.operation) {
      case 'fleet.probeMachine':
        return handlers[request.operation](request.params);
      case 'decisions.scan':
        return handlers[request.operation](request.params);
    }
  }

  async function handle(request: BackgroundRequestMessage): Promise<void> {
    const base = { type: 'result', id: request.id, operation: request.operation } as const;
    try {
      const value = await run(request);
      post({
        ...base,
        ok: true,
        value,
        exec: execDelta(request.operation),
        rssBytes: process.memoryUsage().rss,
      });
    } catch (error) {
      // The failure is the operation's result: the parent rejects the caller's request with it.
      post({
        ...base,
        ok: false,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
        exec: execDelta(request.operation),
        rssBytes: process.memoryUsage().rss,
      });
    }
  }

  // Every command this process starts runs in its own process group. However this process exits
  // (shutdown, a closed IPC channel, process.exit, an uncaught exception), the groups of commands
  // that have not exited are killed, through their handles: a command that has not emitted `exit`
  // has not been reaped, so its pid still names its group. Each command also carries a guard that
  // kills its group within about a second if this process dies outright (SIGKILL, a native crash).
  const running = new Set<ChildProcess>();
  ownLocalCommands({
    started(command) {
      running.add(command);
      command.once('exit', () => running.delete(command));
    },
    pid: options.guardOwnerPid ?? process.pid,
  });
  process.on('exit', () => {
    for (const command of running) if (command.pid) signalProcessGroup(command.pid, 'SIGKILL');
  });

  process.on('message', (message: BackgroundParentMessage) => {
    if (message.type === 'shutdown') process.exit(0);
    else void handle(message);
  });
  // The IPC channel closes when the gateway exits or restarts: this process never outlives it.
  process.on('disconnect', () => process.exit(0));

  post({
    type: 'ready',
    pid: process.pid,
    rssBytes: process.memoryUsage().rss,
    activeResources: process.getActiveResourcesInfo(),
  });
}
