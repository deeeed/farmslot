// @farmslot:serial
// The finish reconcile runs for a cancel a gateway restart interrupted: it settles the cancel's
// own outcome on a real status file and run store, and refuses whenever the run, the slot's
// teardown or the observed fence moved. The slot's tmux, screen, Git and recipe side effects
// are inert here; the blind-trial restore and the ancillary cleanup are the test's hooks.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import { cancelledRunHoldReason, Events, type Run } from '@farmslot/protocol';

import { makeRun } from '../methods/run/test-fixtures.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'interrupted-cancel-resume-'));
for (const dir of ['scripts', 'services/gateway', 'pool', 'projects', 'runs', 'home'])
  await mkdir(path.join(root, dir), { recursive: true });
await writeFile(path.join(root, 'CLAUDE.md'), '# Private cancel fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
after(() => rm(root, { recursive: true, force: true }));

const SLOT = 'resume-slot';
const events: string[] = [];
/** Runs inside the finish, after its fence recheck: a race or a failure lands here. */
let duringFinish: (() => Promise<void>) | undefined;
let blindRestore: string | null = null;

mock.module('../server.js', {
  namedExports: { broadcastEvent: (event: string) => events.push(event) },
});
const realAttachments = await import('../methods/terminal-attachment.js');
mock.module('../methods/terminal-attachment.js', {
  namedExports: {
    ...realAttachments,
    terminalAttachmentCleanupForRun: async (_run: Run, assertOwned?: () => Promise<void>) => {
      await duringFinish?.();
      await assertOwned?.();
    },
  },
});
const realScreen = await import('../runtime/screen-session.js');
mock.module('../runtime/screen-session.js', {
  namedExports: { ...realScreen, killSlotScreenSessions: () => {} },
});
const realCommits = await import('./validation-run-commits.js');
mock.module('./validation-run-commits.js', {
  namedExports: { ...realCommits, ownsRunBranch: () => false, parksBranchCommits: () => false },
});
const realRecipes = await import('./recipe-artifacts.js');
mock.module('./recipe-artifacts.js', {
  namedExports: { ...realRecipes, archiveRunRecipeArtifacts: async () => {} },
});
const realFleet = await import('../fleet/state.js');
mock.module('../fleet/state.js', {
  namedExports: { ...realFleet, loadFleetStatus: async () => ({ slots: [] }) },
});
const realBlind = await import('../evals/blind-trial.js');
mock.module('../evals/blind-trial.js', {
  namedExports: { ...realBlind, restoreFinishedBlindTrialGit: async () => blindRestore },
});

const state = await import('../core/state.js');
const store = await import('../runs/store.js');
const registry = await import('../run-engine/terminal-teardown-registry.js');
const { withRunTransition } = await import('./transition-coordinator.js');
const { resumeInterruptedCancelCleanup }: typeof import('./cancel-transition.js') = await import(
  new URL('./cancel-transition.js?interrupted-cancel-resume', import.meta.url).href
);
type Observed = Parameters<typeof resumeInterruptedCancelCleanup>[2];
type Intent = Observed['intent'];

const SINCE = '2026-11-25T10:26:33.000Z';

let seeded = 0;

/** The store keeps a run it already loaded, so every seed is a new cancelled run. */
async function seed(
  intent: Intent,
  run: Partial<Run> = {},
  row: (runId: string) => Record<string, unknown> = () => ({}),
) {
  const cancelled: Run = {
    ...makeRun({ id: `cancelled-run-${++seeded}`, status: 'cancelled', slotId: SLOT }),
    ...run,
  };
  await writeFile(path.join(root, 'runs', `${cancelled.id}.json`), JSON.stringify(cancelled));
  await store.loadAllRuns();
  const token = state.runCleanupToken(intent, 'fence');
  await writeFile(
    state.statusFile,
    JSON.stringify({
      slots: [
        {
          slot: SLOT,
          lifecycle: 'busy',
          phase: 'releasing',
          slot_epoch: 5,
          current_run_id: cancelled.id,
          releasing_since: SINCE,
          release_gateway_instance: 'previous-gateway',
          cleanup_release_token: token,
          ...row(cancelled.id),
        },
      ],
    }),
  );
  const observed: Observed = {
    intent,
    token,
    instance: 'previous-gateway',
    releasingSince: SINCE,
    slotEpoch: 5,
  };
  return { run: store.getRun(cancelled.id)!, observed };
}

const read = () => state.readSlotRow(SLOT);

beforeEach(() => {
  events.length = 0;
  duringFinish = undefined;
  blindRestore = null;
});

test('a replay intent settles the replay hold, inside the slot’s terminal teardown', async () => {
  const { run, observed } = await seed('replay');
  let teardownSeen = false;
  duringFinish = async () => {
    // An owner-bound release starting now finds the teardown and stands down.
    teardownSeen = registry.isTerminalTeardownInFlight(SLOT);
  };
  assert.equal(await resumeInterruptedCancelCleanup(run, SLOT, observed), null);
  assert.ok(teardownSeen);
  const row = await read();
  assert.equal(row?.lifecycle, 'held');
  assert.equal(row?.phase, 'occupied');
  assert.equal(row?.current_run_id, run.id);
  assert.equal(row?.held_reason, cancelledRunHoldReason(run.id));
  assert.equal(row?.cleanup_release_token ?? null, null);
  assert.equal(registry.isTerminalTeardownInFlight(SLOT), false);
  assert.ok(events.includes(Events.FLEET_UPDATED));
});

test('a release intent releases the slot', async () => {
  const { run, observed } = await seed('release');
  assert.equal(await resumeInterruptedCancelCleanup(run, SLOT, observed), null);
  const row = await read();
  assert.equal(row?.lifecycle, 'ready');
  assert.equal(row?.current_run_id ?? null, null);
  assert.equal(row?.cleanup_release_token ?? null, null);
});

test('a teardown already on the slot, such as an owner-bound release, wins', async () => {
  const { run, observed } = await seed('release');
  const before = await read();
  registry.beginTerminalTeardown(SLOT);
  try {
    assert.equal(
      await resumeInterruptedCancelCleanup(run, SLOT, observed),
      'busy: another teardown owns this slot',
    );
  } finally {
    registry.endTerminalTeardown(SLOT);
  }
  assert.deepEqual(await read(), before);
});

test('a transition holding the run, such as a replay, wins', async () => {
  const { run, observed } = await seed('replay');
  const before = await read();
  let release: () => void = () => {};
  let started: () => void = () => {};
  const holding = new Promise<void>((done) => (started = done));
  const held = withRunTransition(
    run.id,
    () =>
      new Promise<void>((done) => {
        release = done;
        started();
      }),
  );
  // The replay must hold the run key before the resume asks for it.
  await holding;
  try {
    assert.equal(
      await resumeInterruptedCancelCleanup(run, SLOT, observed),
      'busy: a transition holds the run',
    );
  } finally {
    release();
    await held;
  }
  assert.deepEqual(await read(), before);
});

test('a run revived or rebound after the gate is left alone', async () => {
  for (const change of [
    { status: 'monitoring' },
    { slotId: 'other-slot' },
  ] satisfies Partial<Run>[]) {
    const { run, observed } = await seed('release', change);
    const before = await read();
    assert.equal(
      await resumeInterruptedCancelCleanup(run, SLOT, observed),
      'refused: the cancelled run changed',
      JSON.stringify(change),
    );
    assert.deepEqual(await read(), before);
  }
});

test('a fence that moved after the gate is left alone', async () => {
  const cases: Array<[Intent, (runId: string) => Record<string, unknown>]> = [
    ['release', () => ({ cleanup_release_token: state.runCleanupToken('release', 'other') })],
    ['release', () => ({ release_gateway_instance: 'another-gateway' })],
    ['release', () => ({ releasing_since: '2026-11-25T10:40:00.000Z' })],
    ['release', () => ({ slot_epoch: 6 })],
    ['release', () => ({ handoff_run_id: 'successor-run' })],
    ['release', () => ({ cleanup_stop_unconfirmed: true })],
    ['release', () => ({ phase: 'occupied' })],
    ['release', () => ({ workspace_recovery: { runId: 'cancelled' } })],
    ['release', () => ({ current_run_id: 'successor-run' })],
    // The replay hold keeps the slot's owner, which a cleanup-only row has lost.
    ['replay', (runId) => ({ current_run_id: null, cleanup_run_id: runId })],
  ];
  for (const [intent, row] of cases) {
    const { run, observed } = await seed(intent, {}, row);
    const before = await read();
    const label = JSON.stringify(row(run.id));
    assert.equal(
      await resumeInterruptedCancelCleanup(run, SLOT, observed),
      'refused: the release fence changed',
      label,
    );
    assert.deepEqual(await read(), before, label);
  }
});

test('this gateway’s own fence is never resumed, even when it is what was observed', async () => {
  const instance = state.currentReleaseGatewayInstance();
  const { run, observed } = await seed('release', {}, () => ({
    release_gateway_instance: instance,
  }));
  const before = await read();
  assert.equal(
    await resumeInterruptedCancelCleanup(run, SLOT, { ...observed, instance }),
    'refused: the release fence changed',
  );
  assert.deepEqual(await read(), before);
});

test('a release that takes the fence during the finish keeps it', async () => {
  const { run, observed } = await seed('release');
  const takeover = state.runCleanupToken(undefined, 'operator-release');
  duringFinish = async () => {
    await state.updateSlotStatusIf(SLOT, () => true, { cleanup_release_token: takeover });
  };
  const result = await resumeInterruptedCancelCleanup(run, SLOT, observed);
  assert.match(result ?? '', /^not finished: Slot ownership changed/);
  const row = await read();
  assert.equal(row?.phase, 'releasing');
  assert.equal(row?.cleanup_release_token, takeover);
  assert.equal(row?.current_run_id, run.id);
});

test('a finish that fails settles the cleanup hold the live cancel would, named on the run', async () => {
  const { run, observed } = await seed('release');
  duringFinish = async () => {
    throw new Error('node command hung');
  };
  assert.equal(
    await resumeInterruptedCancelCleanup(run, SLOT, observed),
    'not finished: node command hung',
  );
  const row = await read();
  assert.equal(row?.lifecycle, 'held');
  assert.equal(row?.phase, 'occupied');
  assert.equal(row?.held_reason, 'node command hung');
  assert.equal(row?.cleanup_run_id, run.id);
  assert.equal(row?.cleanup_release_token ?? null, null);
  assert.equal(store.getRun(run.id)?.slotTeardownSkipped, 'node command hung');
});

test('a blind trial whose Git restore fails is held, and the fleet hears it', async () => {
  blindRestore = 'Blind trial Git restore failed';
  const { run, observed } = await seed('release', {
    engineState: {
      evalExperiment: {
        experimentId: 'experiment',
        experimentKey: 'key',
        experimentManifestPath: path.join(root, 'experiment.json'),
        packagePath: path.join(root, 'candidate.json'),
        candidateStrategyFingerprint: 'fingerprint',
        trialId: 'blind-trial',
        blind: {
          version: 1,
          baseSha: 'base',
          problemDigest: 'problem',
          referenceCommits: [],
          referencePatchId: 'reference',
          forbiddenInputs: [],
          isolation: {
            slotId: SLOT,
            slotEpoch: 5,
            capsulePath: path.join(root, 'capsule'),
            verifiedAt: '2026-11-25T00:00:00.000Z',
          },
        },
      },
    },
  });
  assert.equal(
    await resumeInterruptedCancelCleanup(run, SLOT, observed),
    'not finished: Blind trial Git restore failed',
  );
  const row = await read();
  assert.equal(row?.lifecycle, 'held');
  assert.equal(row?.held_reason, 'Blind trial Git restore failed');
  assert.equal(row?.cleanup_release_token ?? null, null);
  assert.ok(events.includes(Events.FLEET_UPDATED));
});
