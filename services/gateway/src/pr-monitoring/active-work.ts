import type { PRMonitor, Run } from '@farmslot/protocol';

import { runOwnsPR } from '../backlog/pr-admission.js';
import { getAllRuns } from '../runs/store.js';

export function activePRRuns(monitor: Pick<PRMonitor, 'config'>, runs: Run[] = getAllRuns()) {
  return runs
    .filter((run) => runOwnsPR(run, monitor.config.pr, monitor.config.project))
    .map(({ id, slotId, status }) => ({ id, slotId, status }));
}
