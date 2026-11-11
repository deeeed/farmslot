// A background child for command-groups.test.ts: the real request loop (serve.ts) with handlers
// that start a long command. The first `fleet.probeMachine` starts `sleep` in its own process
// group, as a probe with a timeout does, and appends its pid to FIXTURE_PID_FILE; later ones never
// answer and start nothing. `decisions.scan` crashes the child.
import { execLocal } from '../../core/exec.js';

import { serveBackgroundRequests } from './serve.js';

const pidFile = process.env.FIXTURE_PID_FILE;
if (!pidFile) throw new Error('FIXTURE_PID_FILE is required');

let probes = 0;
serveBackgroundRequests(
  {
    'fleet.probeMachine': async () => {
      if (probes++) return new Promise(() => {});
      await execLocal(`echo $$ >> '${pidFile}'; exec sleep 60`, { timeout: 120_000 });
      return [];
    },
    'decisions.scan': async () => process.exit(3),
  },
  new Set(['fleet.probeMachine']),
);
