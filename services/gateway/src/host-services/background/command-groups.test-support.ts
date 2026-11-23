// A background child for command-groups.test.ts: the real request loop (serve.ts) with handlers
// that start commands through core/exec, as probes do. FIXTURE_MODE picks what the first
// `fleet.probeMachine` runs; later ones never answer and start nothing. `decisions.scan` calls
// process.exit(3).
//   hang       a command and a descendant that sleep, with FIXTURE_TIMEOUT_MS
//   untimed    the same command with no timeout
//   resistant  a command that survives TERM (it writes 'term' for each one), with FIXTURE_TIMEOUT_MS
// Those commands open the FIFO FIXTURE_PIPE, write their pids to it and hold it, so the test
// sees the pipe end only once all of them have exited.
//   results    each FIXTURE_COMMANDS entry with its timeout, the results written to FIXTURE_OUT
// FIXTURE_CLOSEOUT_MS sets the TERM-to-KILL closeout; FIXTURE_NO_WATCHDOG=1 starts no command
// watchdog (serve.ts's commandWatchdog).
import { writeFile } from 'node:fs/promises';

import { execLocal } from '../../core/exec.js';

import type { BackgroundHandlerContext } from './handlers.js';
import type { BackgroundCommandParams } from './protocol.js';
import { serveBackgroundRequests } from './serve.js';

// Keep this fixture independent of production handlers and their fleet-monitor imports.
function command(
  { command, ...options }: BackgroundCommandParams,
  context?: BackgroundHandlerContext,
) {
  return execLocal(command, { ...options, signal: context?.signal });
}

export interface FixtureCommand {
  command: string;
  timeout: number;
}

const env = process.env;
const pipe = env.FIXTURE_PIPE;
// Longer than any test's timeout: only a kill ends them in time.
const hang = `exec 3>'${pipe}'; echo $$ >&3; sleep 600 & echo $! >&3; wait`;
const resistant = `exec 3>'${pipe}'; echo $$ >&3; trap 'echo term >&3' TERM; while :; do sleep 0.1; done`;
const closeoutTimeoutMs = Number(env.FIXTURE_CLOSEOUT_MS ?? 200);
const timeout = Number(env.FIXTURE_TIMEOUT_MS ?? 120_000);

async function probe(): Promise<void> {
  if (env.FIXTURE_MODE !== 'results' && !pipe) throw new Error('FIXTURE_PIPE is required');
  if (env.FIXTURE_MODE === 'untimed') await execLocal(hang);
  else if (env.FIXTURE_MODE === 'resistant')
    await execLocal(resistant, { timeout, closeoutTimeoutMs });
  else if (env.FIXTURE_MODE === 'results') {
    const commands: FixtureCommand[] = JSON.parse(env.FIXTURE_COMMANDS ?? '[]');
    const results = [];
    for (const command of commands)
      results.push(
        await execLocal(command.command, { timeout: command.timeout, closeoutTimeoutMs }),
      );
    if (!env.FIXTURE_OUT) throw new Error('FIXTURE_OUT is required');
    await writeFile(env.FIXTURE_OUT, JSON.stringify(results));
  } else await execLocal(hang, { timeout, closeoutTimeoutMs });
}

let probes = 0;
serveBackgroundRequests(
  {
    'fleet.probeMachine': async () => {
      if (probes++) return new Promise(() => {});
      await probe();
      return [];
    },
    'decisions.scan': async () => process.exit(3),
    'commands.read': command,
    'taskFiles.transfer': command,
    'taskPins.retain': command,
  },
  new Set(['fleet.probeMachine']),
  env.FIXTURE_NO_WATCHDOG === '1' ? { commandWatchdog: false } : {},
);
