import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SlotVars } from '../../core/config.js';

import { isOptionalFixtureAbsence, runHealthCheck, runUnlockHook } from './check.js';

function makeSlotVars(remoteRepo: string): SlotVars {
  return {
    slotId: 'health-test',
    machine: os.hostname(),
    platform: 'ios',
    host: 'localhost',
    sshUser: 'test',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: remoteRepo,
    session: 'health-test',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: '',
    remoteRepo,
    projectName: 'health-test',
    resourceVars: {},
  };
}

test('runHealthCheck ignores stdout from failed health commands', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'farmslot-health-'));
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const result = await runHealthCheck(
    makeSlotVars(repo),
    `printf '%s\\n' '{"ready":true,"route":"WalletView"}'; exit 7`,
    'python3 -c "import json,sys; print(json.load(sys.stdin).get(\\"route\\", \\"\\"))"',
  );

  assert.equal(result, '');
});

test('runUnlockHook reports a failed unlock with its exit code and output tail', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'farmslot-unlock-'));
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });
  const vars = makeSlotVars(repo);

  assert.equal(await runUnlockHook(vars, 'echo unlocked'), null);
  assert.equal(
    await runUnlockHook(vars, `printf '%s\\n' one two three 'call x: fail'; exit 4`),
    'unlock hook exited 4: two | three | call x: fail',
  );
});

test('isOptionalFixtureAbsence tolerates optional entries and unresolved placeholders', () => {
  assert.equal(
    isOptionalFixtureAbsence(
      { src: 'domains/blue/notes.md', optional: true },
      'domains/blue/notes.md',
    ),
    true,
  );
  assert.equal(
    isOptionalFixtureAbsence({ src: 'domains/{{domain}}/notes.md' }, 'domains/{{domain}}/notes.md'),
    true,
  );
  assert.equal(
    isOptionalFixtureAbsence({ src: 'sentry.debug.properties' }, 'sentry.debug.properties'),
    false,
  );
});
