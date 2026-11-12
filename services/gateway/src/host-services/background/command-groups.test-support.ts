// A background child for command-groups.test.ts: the real request loop (serve.ts) with handlers
// that start commands through core/exec, as probes do. FIXTURE_MODE picks what the first
// `fleet.probeMachine` runs; later ones never answer and start nothing. `decisions.scan` calls
// process.exit(3).
//   hang     a command and a descendant that sleep, with FIXTURE_TIMEOUT_MS; both pids are
//            appended to FIXTURE_PID_FILE
//   untimed  the same command with no timeout
//   results  each FIXTURE_COMMANDS entry with its timeout, the results written to FIXTURE_OUT
import { writeFile } from 'node:fs/promises';

import { execLocal } from '../../core/exec.js';

import { serveBackgroundRequests } from './serve.js';

export interface FixtureCommand {
  command: string;
  timeout: number;
}

const { FIXTURE_MODE: mode, FIXTURE_PID_FILE: pidFile } = process.env;
if (!pidFile) throw new Error('FIXTURE_PID_FILE is required');
const hang = `echo $$ >> '${pidFile}'; sleep 60 & echo $! >> '${pidFile}'; wait`;
/** Short enough for the tests, longer than the closeout so the command's own path stays first. */
const closeoutTimeoutMs = 200;

async function probe(): Promise<void> {
  if (mode === 'untimed') await execLocal(hang);
  else if (mode === 'results') {
    const commands: FixtureCommand[] = JSON.parse(process.env.FIXTURE_COMMANDS ?? '[]');
    const results = [];
    for (const { command, timeout } of commands)
      results.push(await execLocal(command, { timeout, closeoutTimeoutMs }));
    await writeFile(process.env.FIXTURE_OUT ?? '', JSON.stringify(results));
  } else
    await execLocal(hang, {
      timeout: Number(process.env.FIXTURE_TIMEOUT_MS ?? 120_000),
      closeoutTimeoutMs,
    });
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
  },
  new Set(['fleet.probeMachine']),
  { watchdogGraceMs: 200 },
);
