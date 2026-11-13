// A background child for command-groups.test.ts: the real request loop (serve.ts) with handlers
// that start commands through core/exec, as probes do. FIXTURE_MODE picks what the first
// `fleet.probeMachine` runs; later ones never answer and start nothing. `decisions.scan` calls
// process.exit(3).
//   hang       a command and a descendant that sleep, with FIXTURE_TIMEOUT_MS; both pids are
//              appended to FIXTURE_PID_FILE
//   untimed    the same command with no timeout
//   resistant  a command that survives TERM (it records each one), with FIXTURE_TIMEOUT_MS
//   results    each FIXTURE_COMMANDS entry with its timeout, the results written to FIXTURE_OUT
// FIXTURE_CLOSEOUT_MS sets the TERM-to-KILL closeout; FIXTURE_GUARD_OWNER points the guards at
// another process (serve.ts's guardOwnerPid).
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
const pidFile = env.FIXTURE_PID_FILE;
if (!pidFile) throw new Error('FIXTURE_PID_FILE is required');
const hang = `echo $$ >> '${pidFile}'; sleep 60 & echo $! >> '${pidFile}'; wait`;
const resistant = `echo $$ >> '${pidFile}'; trap 'echo term >> "${pidFile}.term"' TERM; while :; do sleep 0.1; done`;
const closeoutTimeoutMs = Number(env.FIXTURE_CLOSEOUT_MS ?? 200);
const timeout = Number(env.FIXTURE_TIMEOUT_MS ?? 120_000);

async function probe(): Promise<void> {
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
  },
  new Set(['fleet.probeMachine']),
  env.FIXTURE_GUARD_OWNER ? { guardOwnerPid: Number(env.FIXTURE_GUARD_OWNER) } : {},
);
