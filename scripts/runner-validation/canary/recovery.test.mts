import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import runtimeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

mock.module('node:module', {
  namedExports: { ...runtimeModule, registerHooks: undefined },
});

const { runRecoveryMatrix } = await import('./recovery.mjs');

test('unsupported Node refuses recovery before allocating any stack', async () => {
  let allocated = false;
  await assert.rejects(
    runRecoveryMatrix({
      root: '/unused',
      evidence: '/dev/null/f416-prerequisite',
      reaper: { group() {}, command() {}, path() {}, done() {} },
      cliSnapshots: '/unused',
      onCleanup() {
        allocated = true;
      },
      onCheck() {},
      log: async () => {},
    }),
    /Recovery matrix requires.*22\.22\.3.*registerHooks/,
  );
  assert.equal(allocated, false);
});

test('unsupported Node also refuses the fault preload instead of skipping injection', async () => {
  await assert.rejects(
    import('./recovery-faults.mjs'),
    /Recovery matrix requires.*22\.22\.3.*registerHooks/,
  );
});

for (const cases of [undefined, ['node-timeout'], ['interrupted-teardown']] as const) {
  test(`every recovery stack receives Node pin with cases=${cases?.join(',') ?? 'all'}`, async (t) => {
    const evidence = await mkdtemp(path.join(os.tmpdir(), 'recovery-stack-options-'));
    t.after(() => rm(evidence, { recursive: true, force: true }));
    const allocated: Array<{ slots: string[]; nodeBin?: string }> = [];
    const stop = new Error('stop before allocating fixture processes');
    let rejectAllocation!: (error: Error) => void;
    const allocation = new Promise<never>((_resolve, reject) => {
      rejectAllocation = reject;
    });
    const prerequisites = mock.module('./recovery-prerequisites.mjs', {
      namedExports: { requireRecoveryFaultSupport() {} },
    });
    const stacks = mock.module('../lib/remote-node-stack.mjs', {
      namedExports: {
        async startRemoteNodeStack(options: (typeof allocated)[number]) {
          allocated.push(options);
          if (allocated.length === (cases ? 1 : 2)) rejectAllocation(stop);
          return allocation;
        },
      },
    });
    t.after(() => prerequisites.restore());
    t.after(() => stacks.restore());
    const { runRecoveryMatrix: run } = await import(
      `./recovery.mjs?stack-options=${cases?.join(',') ?? 'all'}`
    );
    await assert.rejects(
      run({
        cases,
        root: '/unused',
        evidence,
        reaper: { group() {}, command() {}, path() {}, done() {} },
        cliSnapshots: '/unused',
        onCleanup() {},
        onCheck() {},
        log: async () => {},
      }),
      stop,
    );
    assert.equal(allocated.length, cases ? 1 : 2);
    assert.deepEqual(
      allocated.flatMap((stack) => stack.slots).sort(),
      (
        cases ?? [
          'deferred-fix-active',
          'review-cap',
          'silent-reviewer',
          'out-of-band-commit',
          'node-timeout',
          'fixer-scope',
          'interrupted-teardown',
        ]
      )
        .map((name) => `recovery-${name}-1`)
        .sort(),
    );
    for (const stack of allocated) {
      assert.equal(stack.nodeBin, path.dirname(process.execPath));
    }
  });
}
