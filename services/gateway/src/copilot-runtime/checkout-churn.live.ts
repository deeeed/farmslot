// Live check for the Co-Pilot checkout read under the writes the gateway makes in its own
// checkout (.runs/, .omx/logs/, the PR rule archive). The controller, its checkout watch
// (workspaceObservations) and its git inspection are real; only the tmux and native transports
// are the test fakes, so no runner starts. On a controller that fails reads on any watch event,
// most reads fail and the dangerous start needs retries.
// Run: TSX_TSCONFIG_PATH=tsconfig.json node --import tsx --test --test-force-exit \
//   src/copilot-runtime/checkout-churn.live.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CopilotRuntimeController } from './controller.js';
import { CopilotRuntimeStore } from './session-store.js';
import { FakeCopilotNative, FakeCopilotTmux, testWorkload } from './test-helpers.js';

test('status reads and a dangerous start succeed while the checkout is written every 5 ms', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'copilot-churn-live-'));
  let writer: NodeJS.Timeout | undefined;
  // Stop the writer before removing the checkout it writes into, whether the test passes or not.
  t.after(async () => {
    clearInterval(writer);
    await rm(home, { recursive: true, force: true });
  });
  const checkout = path.join(home, 'checkout');
  mkdirSync(checkout);
  const git = (...args: string[]) =>
    execFileSync('git', [
      '-C',
      checkout,
      '-c',
      'user.name=P',
      '-c',
      'user.email=p@example.invalid',
      ...args,
    ]);
  git('init', '-q', '--initial-branch=main');
  writeFileSync(path.join(checkout, '.gitignore'), '/.runs/\n');
  writeFileSync(path.join(checkout, 'README.md'), 'live\n');
  git('add', '.');
  git('commit', '-q', '-m', 'seed');
  mkdirSync(path.join(checkout, '.runs'));
  writeFileSync(path.join(checkout, 'archive.jsonl'), '');
  const native = new FakeCopilotNative();
  const controller = new CopilotRuntimeController({
    store: new CopilotRuntimeStore(path.join(home, 'store')),
    tmux: new FakeCopilotTmux(),
    native,
    owner: () => 'farm',
    checkout,
    buildBootstrap: async () => '# live',
    workload: testWorkload,
  });

  let writes = 0;
  writer = setInterval(() => {
    writes += 1;
    writeFileSync(path.join(checkout, '.runs', 'run.json'), JSON.stringify({ writes }));
    appendFileSync(path.join(checkout, 'archive.jsonl'), `{"n":${writes}}\n`);
  }, 5);

  const failures: string[] = [];
  for (let i = 0; i < 40; i++)
    await controller.status().catch((error: Error) => failures.push(error.message));
  assert.deepEqual(failures, [], `${failures.length} of 40 reads failed under ${writes} writes`);

  const { session } = await controller.status();
  const started = await controller.start({
    runner: session.runner,
    model: session.model,
    safetyTier: 'dangerous',
    confirmation: {
      fingerprint: session.dangerousLaunch.fingerprint,
      typedPhrase: session.dangerousLaunch.typedPhrase,
      warningAcknowledged: true,
    },
  });
  assert.equal(started.session.safetyTier, 'dangerous');
  clearInterval(writer);
  assert.equal(native.launches, 1);
  console.log(`40 status reads and a dangerous start, under ${writes} checkout writes`);
});
