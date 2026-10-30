import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

let run: Run;
let epoch = 7;
let captures = 0;
let onCapture = () => {};
let failPersist = false;
const base = 'a'.repeat(40),
  head = 'c'.repeat(40);
const diffText =
  'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+candidate\n';
mock.module('../core/config.js', {
  namedExports: { loadSlotVars: async () => ({ slotId: 'owned', remoteRepo: '/owned' }) },
});
mock.module('../core/state.js', {
  namedExports: {
    readSlotRow: async () => ({ slot_epoch: epoch, phase: 'working', current_run_id: run.id }),
    ownsRunSlotCleanup: (row: { current_run_id: string }, id: string) => row.current_run_id === id,
  },
});
mock.module('../core/exec.js', {
  namedExports: {
    execOnSlot: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ status: 'isolated', runId: run.id, baseSha: base }),
      stderr: '',
    }),
    execLocal: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }),
  },
});
mock.module('../run-engine/diff-artifacts.js', {
  namedExports: {
    captureRunDiffSnapshot: async () => {
      captures++;
      onCapture();
      return {
        source: 'artifact',
        available: true,
        files: 1,
        additions: 1,
        deletions: 1,
        baseSha: base,
        headSha: head,
        diffText,
      };
    },
  },
});
mock.module('../runs/store.js', {
  namedExports: {
    getRun: () => run,
    updateRun: (_id: string, update: Partial<Run>) => (run = { ...run, ...update }),
    persistRunNow: async () => {
      if (failPersist) throw new Error('simulated restart');
    },
  },
});
// Avoid the package-store -> core/index import graph: its text digest is the only dependency here.
mock.module('./package-store.js', {
  namedExports: { sha256Text: (value: string) => createHash('sha256').update(value).digest('hex') },
});
const { freezeBlindTrialFirstOutput, restoreBlindTrialGit } = await import('./blind-trial.js');

async function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blind-first-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run = {
    id: 'trial',
    status: 'monitoring',
    slotId: 'owned',
    branch: 'eval/candidate',
    engineState: {
      evalExperiment: {
        experimentId: 'experiment',
        experimentKey: 'key',
        experimentManifestPath: path.join(root, 'experiment.json'),
        packagePath: path.join(root, 'candidate.json'),
        candidateStrategyFingerprint: 'fingerprint',
        trialId: 'trial',
        blind: {
          version: 1,
          baseSha: base,
          problemDigest: 'problem',
          referenceCommits: ['b'.repeat(40)],
          referencePatchId: 'reference',
          forbiddenInputs: [],
          isolation: {
            slotId: 'owned',
            slotEpoch: 7,
            capsulePath: '/owned/capsule',
            verifiedAt: 'now',
          },
        },
      },
    },
  } as Run;
  epoch = 7;
  captures = 0;
  failPersist = false;
  onCapture = () => {};
  return root;
}

test('first output recovers exact bytes after persistence failure and is never recaptured', async (t) => {
  const root = await fixture(t);
  const initialBlind = structuredClone(run.engineState!.evalExperiment!.blind!);
  failPersist = true;
  await assert.rejects(freezeBlindTrialFirstOutput(run.id), /simulated restart/);
  run.engineState!.evalExperiment!.blind = initialBlind;
  failPersist = false;
  await freezeBlindTrialFirstOutput(run.id);
  assert.equal(captures, 1);
  assert.equal(await readFile(path.join(root, 'first-output.diff'), 'utf8'), diffText);
  await freezeBlindTrialFirstOutput(run.id);
  assert.equal(captures, 1);
  await writeFile(path.join(root, 'first-output.diff'), 'changed');
  await assert.rejects(freezeBlindTrialFirstOutput(run.id), /changed/);
});

test('ownership changes during capture cannot publish or persist a new owner contribution', async (t) => {
  const root = await fixture(t);
  onCapture = () => {
    epoch++;
  };
  await assert.rejects(freezeBlindTrialFirstOutput(run.id), /slot epoch/);
  await assert.rejects(readFile(path.join(root, 'first-output.json')), { code: 'ENOENT' });
  assert.equal(run.engineState!.evalExperiment!.blind!.firstOutput, undefined);
});

test('cancellation during capture and a foreign restoration epoch both fail closed', async (t) => {
  await fixture(t);
  onCapture = () => {
    run.status = 'cancelled';
  };
  await assert.rejects(freezeBlindTrialFirstOutput(run.id), /active run/);
  await assert.rejects(
    restoreBlindTrialGit(
      run,
      { slotId: 'owned' } as Awaited<
        ReturnType<(typeof import('../core/config.js'))['loadSlotVars']>
      >,
      8,
      async () => {},
    ),
    /slot epoch/,
  );
});
