import assert from 'node:assert/strict';
import runtimeModule from 'node:module';
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
