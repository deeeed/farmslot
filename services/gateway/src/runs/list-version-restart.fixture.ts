// Child process for list-versions.test.ts: one gateway lifetime of the real run store over
// FARMSLOT_RUNS_DIR. `create` writes runs; `load` and `change` start from the files on disk.
// The result goes to the file named by the second argument; the store logs to stdout.
import { writeFileSync } from 'node:fs';

const [mode, output] = process.argv.slice(2);
const { createRun, getAllRuns, getRun, loadAllRuns, persistRunNow, updateRun } =
  await import('./store.js');
const { runListVersions } = await import('./list-version.js');

if (mode === 'create') {
  for (const ticketOrPr of ['RESTART-VERSION-1', 'RESTART-VERSION-2']) {
    const run = createRun({ flowType: 'dev', project: 'restart-version', ticketOrPr });
    await persistRunNow(getRun(run.id)!, 'list version restart fixture');
  }
} else {
  await loadAllRuns();
}
const versions = runListVersions(getAllRuns());
let changed;
if (mode === 'change') {
  updateRun(getAllRuns()[0]!.id, { summary: 'changed after the restart' });
  changed = runListVersions(getAllRuns());
}
writeFileSync(output!, JSON.stringify({ versions, changed }));
process.exit(0);
