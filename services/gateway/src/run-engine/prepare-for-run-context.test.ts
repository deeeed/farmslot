// A prepare that names a run (runId or bindRunId) uses that run's flow type and domain, here as
// fixture sync sees them; explicit params win, and a run of another project is refused before any
// phase runs.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The shared fixture calls mock.module(...) and needs the module-mock test lane.
import '../core/hermetic-git.test-support.js';
import '../core/private-pool.test-support.js';

// A private copy of the tracked farmslot-farm pack, whatever the caller's environment points at.
const projects = mkdtempSync(path.join(os.tmpdir(), 'prepare-for-run-projects-'));
after(() => rmSync(projects, { recursive: true, force: true }));
cpSync(
  fileURLToPath(new URL('../../../../projects/farmslot-farm', import.meta.url)),
  path.join(projects, 'farmslot-farm'),
  { recursive: true },
);
process.env.FARMSLOT_PROJECTS_DIR = projects;
// A private run store too: a machine shell may export the farm's own FARMSLOT_RUNS_DIR.
const runsDir = mkdtempSync(path.join(os.tmpdir(), 'prepare-for-run-runs-'));
after(() => rmSync(runsDir, { recursive: true, force: true }));
process.env.FARMSLOT_RUNS_DIR = runsDir;

const { mockFixtureSync, mockPrepareCommand, needsTmuxSandbox, slotPrepare, stackFixture } =
  await import('./stack-base-prepare.test-support.js');
const { createRun, deleteRun, persistRunNow, updateRun } = await import('../runs/store.js');

interface PrepareEvent {
  event: string;
  data: unknown;
}

interface PrepareRun {
  project: string;
  flowType: 'dev' | 'qa';
  domain?: string;
}

async function prepareFor(
  t: import('node:test').TestContext,
  label: string,
  run: PrepareRun,
  ids: (runId: string) => Record<string, string>,
  other?: PrepareRun,
) {
  const { slotId } = await stackFixture(t, `for-run-${label}`, 48828);
  const synced: Array<{ flowType?: string; domain?: string }> = [];
  mockPrepareCommand(t, async () => ({ stdout: 'ok\n', stderr: '', exitCode: 0 }));
  mockFixtureSync(t, async (_vars, opts) => {
    synced.push({ flowType: opts.flowType, domain: opts.domain });
  });
  const created = createRun({ ...run, ticketOrPr: 'TAT-0000', slotId, mode: 'autonomous' });
  const second = other && createRun({ ...other, ticketOrPr: 'TAT-0001', mode: 'autonomous' });
  t.after(async () => {
    for (const r of second ? [created, second] : [created]) {
      await persistRunNow(updateRun(r.id, { status: 'done' }));
      await deleteRun(r.id);
    }
  });
  const events: PrepareEvent[] = [];
  const prepare = () =>
    slotPrepare(
      {
        slotId,
        branch: 'main',
        prepareProfile: 'typecheck',
        requestId: `for-run-${label}`,
        ...ids(created.id),
        ...(second ? { bindRunId: second.id } : {}),
      },
      (event, data) => events.push({ event, data }),
    );
  return { prepare, synced, events };
}

function completed(events: PrepareEvent[]) {
  return events
    .filter(({ event }) => event === 'script.complete')
    .map(({ data }) => (data as { exitCode?: number }).exitCode);
}

test(
  'a prepare naming only the runId uses the run flow type and domain',
  needsTmuxSandbox,
  async (t) => {
    const { prepare, synced } = await prepareFor(
      t,
      'run-id',
      { project: 'farmslot-farm', flowType: 'dev', domain: 'perps' },
      (runId) => ({ runId }),
    );
    assert.equal((await prepare()).prepared, true);
    assert.deepEqual(synced, [{ flowType: 'dev', domain: 'perps' }]);
  },
);

test(
  'a prepare naming only the bindRunId uses the run flow type and domain',
  needsTmuxSandbox,
  async (t) => {
    const { prepare, synced } = await prepareFor(
      t,
      'bind-id',
      { project: 'farmslot-farm', flowType: 'dev', domain: 'perps' },
      (runId) => ({ bindRunId: runId }),
    );
    assert.equal((await prepare()).prepared, true);
    assert.deepEqual(synced, [{ flowType: 'dev', domain: 'perps' }]);
  },
);

test('explicit prepare params win over the named run', needsTmuxSandbox, async (t) => {
  const { prepare, synced } = await prepareFor(
    t,
    'explicit',
    { project: 'farmslot-farm', flowType: 'dev', domain: 'perps' },
    (runId) => ({ runId, flowType: 'qa', domain: 'money-movement' }),
  );
  assert.equal((await prepare()).prepared, true);
  assert.deepEqual(synced, [{ flowType: 'qa', domain: 'money-movement' }]);
});

test(
  'a prepare for another project run is refused before any phase',
  needsTmuxSandbox,
  async (t) => {
    const { prepare, synced, events } = await prepareFor(
      t,
      'other-project',
      { project: 'another-project', flowType: 'dev', domain: 'perps' },
      (runId) => ({ runId }),
    );
    await assert.rejects(prepare(), /belongs to project another-project, not .*farmslot-farm/);
    assert.deepEqual(synced, []);
    assert.deepEqual(completed(events), [1]);
  },
);

test(
  'a prepare whose bindRunId names another project run is refused too',
  needsTmuxSandbox,
  async (t) => {
    const { prepare, synced, events } = await prepareFor(
      t,
      'other-bind',
      { project: 'farmslot-farm', flowType: 'dev', domain: 'perps' },
      (runId) => ({ runId }),
      { project: 'another-project', flowType: 'dev' },
    );
    await assert.rejects(prepare(), /belongs to project another-project, not .*farmslot-farm/);
    assert.deepEqual(synced, []);
    assert.deepEqual(completed(events), [1]);
  },
);
