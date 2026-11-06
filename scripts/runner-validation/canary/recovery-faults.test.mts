import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import runtimeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

test('the short reviewer watchdog belongs only to the silent fixture first attempt', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-watchdog-'));
  const previous = process.env.FARMSLOT_ROOT;
  process.env.FARMSLOT_ROOT = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.FARMSLOT_ROOT;
    else process.env.FARMSLOT_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'holds'));
  await writeFile(path.join(root, 'holds/recovery-fixture'), 'isolated');
  let hooks: Parameters<typeof runtimeModule.registerHooks>[0] | undefined;
  mock.module('node:module', {
    namedExports: {
      ...runtimeModule,
      registerHooks: (input: typeof hooks) => {
        hooks = input;
      },
    },
  });
  await import(new URL('./recovery-faults.mjs', import.meta.url).href);
  const checkpoint = 'const inactivityTimeoutMs = (configuredInactivityMinutes ?? 10) * 60_000;';
  const loaded = hooks!.load!(
    'file:///fixture/services/gateway/src/review/native-review-agent.ts',
    { format: 'module', importAttributes: {}, conditions: [] },
    () => ({ format: 'module', source: checkpoint }),
  );
  const timing = new Function(
    'run',
    'configuredInactivityMinutes',
    `${loaded.source} return inactivityTimeoutMs;`,
  );
  const worker = { metrics: { runner: 'scripted' } };
  assert.equal(timing({ ...worker, project: 'ri-review' }), 600_000);
  assert.equal(timing({ ...worker, project: 'ri-review' }, 5), 300_000);
  assert.equal(timing({ ...worker, project: 'recovery-silent-reviewer' }, 0.5), 500);
  assert.equal(
    timing(
      {
        ...worker,
        project: 'recovery-silent-reviewer',
        recoveryAttempts: [{ stepName: 'review' }],
      },
      0.5,
    ),
    30_000,
  );
  assert.throws(
    () =>
      hooks!.load!(
        'file:///fixture/services/gateway/src/review/native-review-agent.ts',
        { format: 'module', importAttributes: {}, conditions: [] },
        () => ({ format: 'module', source: 'changed checkpoint' }),
      ),
    /watchdog checkpoint/,
  );
});
