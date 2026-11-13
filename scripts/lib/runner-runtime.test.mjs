import assert from 'node:assert/strict';
import test from 'node:test';

import { runnerLaunchDir, runnerRuntimeDir } from './runner-runtime.cjs';

test('runner state is outside each checkout and preserves distinct runtime namespaces', () => {
  assert.equal(runnerRuntimeDir('/work/product'), '/work/.farmslot-runtime/product/.agent');
  assert.equal(
    runnerRuntimeDir('/work/product', 'runtime/workers/id'),
    '/work/.farmslot-runtime/product/runtime/workers/id',
  );
  assert.equal(runnerRuntimeDir('/work/product', '/state/lane'), '/state/lane');
  assert.equal(runnerRuntimeDir('/work/product', '../lane'), '/work/lane');
  assert.equal(runnerRuntimeDir('~/work/product'), '~/work/.farmslot-runtime/product/.agent');
});

test('tmux launch scripts live in the slot runtime, beside the checkout', () => {
  assert.equal(runnerLaunchDir('/work/product'), '/work/.farmslot-runtime/product/.agent/.launch');
});
