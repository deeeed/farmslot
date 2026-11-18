import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import type { SlotRecovery, SlotReleaseResult } from '@farmslot/protocol';

import type { SlotPrepareResult } from './shared.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'release-recovery-owner-'));
for (const name of [
  'pool',
  'projects/proof',
  'repo',
  'services/gateway',
  'scripts',
  'home',
  'runs',
])
  await mkdir(path.join(root, name), { recursive: true });
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
after(() => rm(root, { recursive: true, force: true }));
await writeFile(path.join(root, 'CLAUDE.md'), '# Owned release fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({ name: 'proof', default_branch: 'main' }),
);
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: os.hostname(),
    host: 'localhost',
    ssh_user: os.userInfo().username,
    platform: 'cli',
    project: 'proof',
    slots: [{ id: 'owned-recovery', repo: path.join(root, 'repo'), session: 'owned-recovery' }],
  }),
);
await import('../../runtime/mock-pty.test-support.js');
const core = await import('../../core/index.js');
const releaseState = await import('../../core/state.js');
let afterMarker = async (): Promise<void> => {};
let beforeSettlement = async (): Promise<void> => {};
let probeCalls = 0;
let retryProbe: () => Promise<string | null> = async () => null;
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    execOnSlot: async (...args: Parameters<typeof core.execOnSlot>) => {
      const command = args[1];
      if (command.includes('list-panes -a')) {
        probeCalls++;
        const blocker = await retryProbe();
        return { stdout: '', stderr: blocker ?? '', exitCode: blocker ? 2 : 0 };
      }
      if (command.startsWith('ps -axo') || command.startsWith('lsof -a -d cwd'))
        return { stdout: '', stderr: '', exitCode: 0 };
      return core.execOnSlot(...args);
    },
    updateSlotStatusIf: async (...args: Parameters<typeof core.updateSlotStatusIf>) => {
      if (args[2].lifecycle === 'held') await beforeSettlement();
      return core.updateSlotStatusIf(...args);
    },
    markSlotStatusIf: async (...args: Parameters<typeof core.markSlotStatusIf>) => {
      const result = await core.markSlotStatusIf(...args);
      if (result.applied) await afterMarker();
      return result;
    },
  },
});
let reprepare = async (): Promise<SlotPrepareResult> => {
  throw new Error('unexpected re-prepare');
};
mock.module('./prepare.js', { namedExports: { slotPrepare: () => reprepare() } });
const { isTerminalTeardownInFlight, withTerminalTeardown } =
  await import('../../run-engine/terminal-teardown-registry.js');

let reachedCleanup = false;
const store = await import('../../runs/store.js');
const owner = store.createRun({
  project: 'proof',
  flowType: 'dev',
  ticketOrPr: 'PROOF-1',
  mode: 'validation',
  slotId: 'owned-recovery',
});
store.updateRun(owner.id, { status: 'done', completedAt: new Date().toISOString() });
const recovery: SlotRecovery = {
  id: 'recovery-1',
  identity: {
    epoch: 4,
    currentRunId: owner.id,
    cleanupRunId: null,
    handoffRunId: null,
    branch: 'previous',
    headSha: 'a'.repeat(40),
    dirtyFingerprint: 'b'.repeat(64),
    recoveryId: 'recovery-1',
  },
  completed: ['inspect'],
  phase: 'cleanup',
};
const row = {
  slot: 'owned-recovery',
  lifecycle: 'busy',
  phase: 'releasing',
  slot_epoch: 4,
  current_run_id: owner.id,
  workspace_recovery: recovery,
};
await writeFile(path.join(root, 'status.json'), JSON.stringify({ slots: [row] }));
const { slotRelease, slotReleasePreflight } = await import('./release.js');

test('a recovery continuation keeps the terminal owner of its borrowed release fence', async () => {
  await assert.rejects(
    slotRelease({ slotId: 'owned-recovery', preserveAgents: true }, () => {}, {
      workspaceRecovery: {
        id: recovery.id,
        epoch: 4,
        verifyWork: async () => {
          reachedCleanup = true;
          throw new Error('OWNED_CLEANUP_REACHED');
        },
        discardLocalWork: false,
      },
    }),
    /OWNED_CLEANUP_REACHED/,
  );
  assert.equal(reachedCleanup, true);
});

const { replaySlotReclaimCheck } = await import('../run/replay-step.js');
const { trackCleanupCommand } = await import('../../core/cleanup-scope.js');
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const readRow = async () => {
  const current = await core.readSlotRow('owned-recovery');
  assert.ok(current);
  return current;
};
async function seedDeadline() {
  store.updateRun(owner.id, { status: 'failed', completedAt: new Date().toISOString() });
  afterMarker = async () => {};
  beforeSettlement = async () => {};
  reprepare = async () => {
    throw new Error('unexpected re-prepare');
  };
  await writeFile(
    path.join(root, 'status.json'),
    JSON.stringify({
      slots: [
        {
          slot: 'owned-recovery',
          lifecycle: 'held',
          phase: 'occupied',
          slot_epoch: 7,
          current_run_id: owner.id,
          cleanup_run_id: null,
          handoff_run_id: null,
          held_reason: 'pending cleanup',
        },
      ],
    }),
  );
}

for (const keepWarm of [false, true]) {
  test(`a failed release settles its fence and permits an owner retry, warm=${keepWarm}`, async () => {
    await seedDeadline();
    const failure = new Error('Cannot fetch the default branch (exit 128)');
    afterMarker = async () => {
      throw failure;
    };
    const params = {
      slotId: 'owned-recovery',
      expectedRunId: owner.id,
      keepWork: true,
      preserveAgents: true,
      keepWarm,
    };
    await assert.rejects(
      slotRelease(params, () => {}),
      (error) => error === failure,
    );
    const held = await readRow();
    assert.equal(held.lifecycle, 'held');
    assert.equal(held.phase, 'occupied');
    assert.equal(held.current_run_id, owner.id);
    assert.equal(held.slot_epoch, 7);
    assert.equal(held.releasing_since, null);
    assert.match(String(held.held_reason), /Cannot fetch the default branch.*retry release/i);
    assert.equal(isTerminalTeardownInFlight('owned-recovery'), false);
    afterMarker = async () => {};
    const retried = await slotRelease({ ...params, keepWarm: false }, () => {});
    assert.equal(retried.released, true);
    assert.equal((await readRow()).lifecycle, 'ready');
  });
}

test('a failed warm release owns the registry until durable settlement finishes', async (t) => {
  await seedDeadline();
  const entered = deferred(),
    resume = deferred();
  const failure = new Error('Cannot fetch the default branch (exit 128)');
  afterMarker = async () => {
    throw failure;
  };
  beforeSettlement = async () => {
    entered.resolve();
    await resume.promise;
  };
  const rejected = assert.rejects(
    slotRelease(
      {
        slotId: 'owned-recovery',
        expectedRunId: owner.id,
        keepWork: true,
        preserveAgents: true,
        keepWarm: true,
      },
      () => {},
    ),
    (error) => error === failure,
  );
  t.after(async () => {
    resume.resolve();
    await rejected;
  });
  await entered.promise;
  assert.equal((await readRow()).phase, 'releasing');
  assert.equal(
    isTerminalTeardownInFlight('owned-recovery'),
    true,
    'stale-fence reconciliation must see the release while its settlement is pending',
  );
  resume.resolve();
  await rejected;
  assert.equal((await readRow()).phase, 'occupied');
  assert.equal(isTerminalTeardownInFlight('owned-recovery'), false);
});

test('failed fence settlement preserves both errors and releases its registry count', async () => {
  await seedDeadline();
  const failure = new Error('fetch failed'),
    settlementFailure = new Error('status commit failed');
  afterMarker = async () => {
    throw failure;
  };
  beforeSettlement = async () => {
    throw settlementFailure;
  };
  await assert.rejects(
    slotRelease(
      {
        slotId: 'owned-recovery',
        expectedRunId: owner.id,
        keepWork: true,
        preserveAgents: true,
      },
      () => {},
    ),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === failure &&
      error.errors[1] === settlementFailure,
  );
  assert.equal(isTerminalTeardownInFlight('owned-recovery'), false);
});

test('an ordinary command failure retains unconfirmed cleanup ownership', async () => {
  await seedDeadline();
  const failure = new Error('transport closeout unconfirmed');
  afterMarker = async () => {
    await trackCleanupCommand(Promise.reject(failure));
  };
  await assert.rejects(
    slotRelease(
      {
        slotId: 'owned-recovery',
        expectedRunId: owner.id,
        keepWork: true,
        preserveAgents: true,
      },
      () => {},
    ),
    (error) => error === failure,
  );
  const held = await readRow();
  assert.equal(held.lifecycle, 'held');
  assert.equal(held.phase, 'occupied');
  assert.equal(held.current_run_id, null);
  assert.equal(held.cleanup_run_id, owner.id);
  assert.equal(held.cleanup_stop_unconfirmed, true);
  assert.match(String(held.held_reason), /unconfirmed/);
  assert.equal(replaySlotReclaimCheck(held, owner.id).ok, false);
});

for (const successor of [{ slot_epoch: 8 }, { current_run_id: 'successor' }]) {
  test(`ordinary release failure preserves successor ${JSON.stringify(successor)}`, async () => {
    await seedDeadline();
    const failure = new Error('fetch failed after claim changed');
    let expected: Awaited<ReturnType<typeof readRow>>;
    afterMarker = async () => {
      await core.updateSlotStatus('owned-recovery', successor);
      expected = await readRow();
      throw failure;
    };
    await assert.rejects(
      slotRelease(
        {
          slotId: 'owned-recovery',
          expectedRunId: owner.id,
          keepWork: true,
          preserveAgents: true,
        },
        () => {},
      ),
      (error) => error === failure,
    );
    assert.deepEqual(await readRow(), expected!);
  });
}

test(
  'unconfirmed command closeout retains a cleanup hold instead of admitting replay',
  { timeout: 4000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    await seedDeadline();
    const entered = deferred(),
      resume = deferred(),
      pending = deferred();
    t.after(() => {
      pending.resolve();
      resume.resolve();
    });
    afterMarker = async () => {
      trackCleanupCommand(pending.promise);
      entered.resolve();
      await resume.promise;
    };
    const operation = slotRelease(
      {
        slotId: 'owned-recovery',
        expectedRunId: owner.id,
        keepWork: true,
        preserveAgents: true,
      },
      () => {},
    );
    await entered.promise;
    const rejected = assert.rejects(operation, /timed out after 300000ms/);
    t.mock.timers.tick(300000);
    await setImmediate();
    t.mock.timers.tick(10000);
    await rejected;
    const held = await readRow();
    assert.equal(held.current_run_id, null);
    assert.equal(held.cleanup_run_id, owner.id);
    assert.equal(held.cleanup_stop_unconfirmed, true);
    assert.equal(held.lifecycle, 'held');
    assert.equal(replaySlotReclaimCheck(held, owner.id).ok, false);
    assert.match(String(held.held_reason), /unconfirmed/);
    pending.resolve();
    resume.resolve();
    await setImmediate();
    assert.deepEqual(await readRow(), held);
  },
);

test(
  'warm re-prepare keeps its existing budget and finishes ready after five minutes',
  { timeout: 4000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    await seedDeadline();
    await core.updateSlotStatus('owned-recovery', { cleanup_stop_unconfirmed: true });
    const entered = deferred(),
      resume = deferred();
    t.after(resume.resolve);
    reprepare = async () => {
      entered.resolve();
      await resume.promise;
      return { prepared: true, requestId: 'warm' };
    };
    let settled = false;
    const operation = slotRelease(
      {
        slotId: 'owned-recovery',
        expectedRunId: owner.id,
        keepWork: true,
        keepWarm: true,
        preserveAgents: true,
      },
      () => {},
    );
    const observed = operation.finally(() => {
      settled = true;
    });
    await Promise.race([
      entered.promise,
      observed.then(() => {
        throw new Error('release skipped re-prepare');
      }),
    ]);
    t.mock.timers.tick(300_001);
    await setImmediate();
    assert.equal(settled, false, 're-prepare is not cancelled by the terminal cleanup budget');
    assert.equal(isTerminalTeardownInFlight('owned-recovery'), true);
    resume.resolve();
    assert.equal((await observed).released, true);
    assert.equal((await readRow()).lifecycle, 'ready');
    assert.equal((await readRow()).cleanup_stop_unconfirmed, null);
    assert.equal(isTerminalTeardownInFlight('owned-recovery'), false);
  },
);

for (const nested of [false, true]) {
  test(
    `release timeout settles its durable fence for replay${nested ? ' under an expired parent' : ''}`,
    { timeout: 4000 },
    async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
      await seedDeadline();
      const entered = deferred(),
        resume = deferred();
      t.after(resume.resolve);
      afterMarker = async () => {
        entered.resolve();
        await resume.promise;
      };
      let release!: Promise<SlotReleaseResult>;
      const start = () =>
        (release = slotRelease(
          {
            slotId: 'owned-recovery',
            expectedRunId: owner.id,
            keepWork: true,
            preserveAgents: true,
          },
          () => {},
        ));
      const operation = nested ? withTerminalTeardown('owned-recovery', start) : start();
      await Promise.race([
        entered.promise,
        operation.then(() => {
          throw new Error('release finished before the marker pause');
        }),
      ]);
      assert.equal((await readRow()).phase, 'releasing');
      const rejected = assert.rejects(operation, /timed out after 300000ms/);
      const innerRejected = nested ? assert.rejects(release, /timed out after 300000ms/) : rejected;
      t.mock.timers.tick(300_000);
      await rejected;
      await innerRejected;
      const held = await readRow();
      assert.equal(held.lifecycle, 'held');
      assert.equal(held.phase, 'occupied');
      assert.equal(held.current_run_id, owner.id);
      assert.equal(held.releasing_since, null);
      assert.ok(typeof held.held_reason === 'string');
      assert.match(held.held_reason, /timed out/);
      assert.equal(replaySlotReclaimCheck(held, owner.id).ok, true);
      assert.equal(isTerminalTeardownInFlight('owned-recovery'), false);
      resume.resolve();
      await setImmediate();
      await setImmediate();
      assert.deepEqual(
        await readRow(),
        held,
        'late marker completion cannot restore the stale release',
      );
    },
  );
}
for (const advanceEpoch of [false, true]) {
  test(
    `release timeout preserves a successor ${advanceEpoch ? 'epoch' : 'owner at the same epoch'}`,
    { timeout: 4000 },
    async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
      await seedDeadline();
      const entered = deferred(),
        resume = deferred();
      t.after(resume.resolve);
      afterMarker = async () => {
        entered.resolve();
        await resume.promise;
      };
      const operation = slotRelease(
        {
          slotId: 'owned-recovery',
          expectedRunId: owner.id,
          keepWork: true,
          preserveAgents: true,
        },
        () => {},
      );
      await Promise.race([
        entered.promise,
        operation.then(() => {
          throw new Error('release finished before the marker pause');
        }),
      ]);
      await core.updateSlotStatus('owned-recovery', {
        current_run_id: 'successor',
        slot_epoch: advanceEpoch ? 8 : 7,
        foreign: 'preserve',
      });
      const successor = await readRow();
      const rejected = assert.rejects(operation, /timed out after 300000ms/);
      t.mock.timers.tick(300_000);
      await rejected;
      assert.deepEqual(await readRow(), successor);
      resume.resolve();
      await setImmediate();
      await setImmediate();
      assert.deepEqual(await readRow(), successor, 'late release cannot change the successor');
    },
  );
}

async function seedInterruptedRelease() {
  await seedDeadline();
  store.updateRun(owner.id, { status: 'cancelled', slotId: 'owned-recovery' });
  probeCalls = 0;
  retryProbe = async () => null;
  await core.updateSlotStatus('owned-recovery', {
    lifecycle: 'busy',
    phase: 'releasing',
    held_reason: null,
    release_gateway_instance: 'previous-gateway',
    releasing_since: '2026-11-15T19:42:50.605Z',
    cleanup_release_token: 'previous-cleanup-token',
  });
}

test('same-owner retry may inspect a restart-interrupted release without waiting thirty minutes', async () => {
  await seedInterruptedRelease();
  const before = await readRow();
  const preflight = await slotReleasePreflight({
    slotId: 'owned-recovery',
    expectedRunId: owner.id,
    forceReset: true,
  });
  assert.ok(preflight, 'A previous gateway fence must not permanently refuse its owner retry');
  assert.equal(preflight.boundOwner, owner.id);
  assert.equal(probeCalls, 1);
  assert.deepEqual(await readRow(), before, 'Read-only preflight never clears the fence');
});

test('current-gateway release and a foreign owner retain their fence', async () => {
  await seedInterruptedRelease();
  await core.updateSlotStatus('owned-recovery', core.slotReleasingFenceFields());
  const before = await readRow();
  assert.equal(
    await slotReleasePreflight({
      slotId: 'owned-recovery',
      expectedRunId: owner.id,
      forceReset: true,
    }),
    null,
  );
  assert.equal(probeCalls, 0);
  assert.deepEqual(await readRow(), before);
  await seedInterruptedRelease();
  await core.updateSlotStatus('owned-recovery', { current_run_id: 'foreign-owner' });
  const foreign = await readRow();
  assert.equal(
    await slotReleasePreflight({
      slotId: 'owned-recovery',
      expectedRunId: owner.id,
      forceReset: true,
    }),
    null,
  );
  assert.equal(probeCalls, 0);
  assert.deepEqual(await readRow(), foreign);
});

test('unknown process occupancy prevents reclaiming an interrupted release', async () => {
  await seedInterruptedRelease();
  retryProbe = async () => 'Workspace process identity is unavailable';
  const before = await readRow();
  assert.equal(
    await slotReleasePreflight({
      slotId: 'owned-recovery',
      expectedRunId: owner.id,
      forceReset: true,
    }),
    null,
  );
  assert.equal(probeCalls, 1);
  assert.deepEqual(await readRow(), before);
});

for (const change of [
  { slot_epoch: 8 },
  { current_run_id: 'successor' },
  { releasing_since: '2026-11-15T19:42:51.605Z' },
  { release_gateway_instance: 'other-gateway' },
]) {
  test(`interrupted retry preserves a changed ${Object.keys(change)[0]}`, async () => {
    await seedInterruptedRelease();
    retryProbe = async () => {
      await core.updateSlotStatus('owned-recovery', change);
      return null;
    };
    afterMarker = async () => {
      throw new Error('Stale retry must not acquire the changed marker');
    };
    const result = await slotRelease(
      { slotId: 'owned-recovery', expectedRunId: owner.id, forceReset: true },
      () => {},
    );
    assert.equal(probeCalls, 1);
    assert.equal(result.released, false);
    const current = await readRow();
    for (const [key, value] of Object.entries(change)) assert.equal(current[key], value);
  });
}

test('owner retry atomically rotates a dead fence before any cleanup', async () => {
  await seedInterruptedRelease();
  const before = await readRow();
  let claimed: Record<string, unknown> | undefined;
  afterMarker = async () => {
    claimed = await readRow();
    throw new Error('RETRY_FENCE_CLAIMED');
  };
  await assert.rejects(
    slotRelease({ slotId: 'owned-recovery', expectedRunId: owner.id, forceReset: true }, () => {}),
    /RETRY_FENCE_CLAIMED/,
  );
  assert.ok(claimed);
  assert.equal(claimed.current_run_id, owner.id);
  assert.equal(
    claimed.slot_epoch,
    before.slot_epoch,
    'retry retains the exact observed claim epoch',
  );
  assert.equal(claimed.release_gateway_instance, releaseState.currentReleaseGatewayInstance());
  assert.notEqual(claimed.cleanup_release_token, before.cleanup_release_token);
  assert.equal(typeof claimed.cleanup_release_token, 'string');
});

test('a live teardown prevents both inspection and acquisition of an old fence', async () => {
  await seedInterruptedRelease();
  const before = await readRow();
  await withTerminalTeardown('owned-recovery', async () => {
    assert.equal(
      await slotReleasePreflight({
        slotId: 'owned-recovery',
        expectedRunId: owner.id,
        forceReset: true,
      }),
      null,
    );
    assert.equal(
      (
        await slotRelease(
          { slotId: 'owned-recovery', expectedRunId: owner.id, forceReset: true },
          () => {},
        )
      ).released,
      false,
    );
  });
  assert.equal(probeCalls, 0);
  assert.deepEqual(await readRow(), before);
});
