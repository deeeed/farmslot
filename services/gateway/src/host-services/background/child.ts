// Entry point of the gateway-background process (forked by client.ts). It answers operation
// requests over IPC and exits with its parent. It never registers as the gateway status process,
// so a shared fleet status write from here is refused by assertStatusFileWritable.
import type { ExecutionKind } from '@farmslot/protocol/performance';

import { gatewayPerformance } from '../../observability/performance.js';

import { backgroundHandlers, COMMAND_OPERATIONS } from './handlers.js';
import type {
  BackgroundChildMessage,
  BackgroundOperation,
  BackgroundParentMessage,
  BackgroundRequestMessage,
  ExecTally,
} from './protocol.js';

const send = process.send?.bind(process);
if (!send) throw new Error('The gateway background process must be forked with an IPC channel');
const post = (message: BackgroundChildMessage) => send(message);

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

let reported = execCounters();
function execDelta(operation: BackgroundOperation): ExecTally {
  if (!COMMAND_OPERATIONS.has(operation)) return {};
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
      return backgroundHandlers[request.operation](request.params);
    case 'decisions.scan':
      return backgroundHandlers[request.operation](request.params);
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
