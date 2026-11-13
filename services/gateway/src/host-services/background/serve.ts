// The gateway-background process's request loop (child.ts runs it with the real handlers). It
// answers operation requests over IPC and exits with its parent. It never registers as the gateway
// status process, so a shared fleet status write from here is refused by assertStatusFileWritable.
import type { ChildProcess } from 'node:child_process';

import { ownLocalCommands, signalProcessGroup } from '../../core/exec.js';
import { withExecutionTally } from '../../observability/performance.js';

import type { BackgroundHandlers } from './handlers.js';
import type {
  BackgroundChildMessage,
  BackgroundOperation,
  BackgroundParentMessage,
  BackgroundRequestMessage,
  ExecTally,
} from './protocol.js';

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

  const controllers = new Map<number, AbortController>();
  function run(request: BackgroundRequestMessage, signal: AbortSignal): Promise<unknown> {
    switch (request.operation) {
      case 'fleet.probeMachine':
        return handlers[request.operation](request.params, { signal });
      case 'decisions.scan':
        return handlers[request.operation](request.params, { signal });
      case 'commands.read':
        return handlers[request.operation](request.params, { signal });
      case 'taskFiles.transfer':
        return handlers[request.operation](request.params, { signal });
    }
  }

  async function handle(request: BackgroundRequestMessage): Promise<void> {
    const base = { type: 'result', id: request.id, operation: request.operation } as const;
    const controller = new AbortController();
    controllers.set(request.id, controller);
    const exec: ExecTally = {};
    try {
      const value = commandOperations.has(request.operation)
        ? await withExecutionTally(exec, () => run(request, controller.signal))
        : await run(request, controller.signal);
      post({
        ...base,
        ok: true,
        value,
        exec,
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
        exec,
        rssBytes: process.memoryUsage().rss,
      });
    } finally {
      controllers.delete(request.id);
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
    else if (message.type === 'cancel') controllers.get(message.id)?.abort();
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
