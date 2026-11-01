import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  buildRunEpisode,
  captureMissingRunEpisodes,
  captureRunEpisode,
  type EpisodeBundle,
  readRunEpisode,
  RUN_EPISODE_SCHEMA,
  runEpisodeDir,
} from './run-episode.js';

const NOW = '2026-11-01T10:00:00.000Z';
const SHA = (n: number) => String(n).padStart(64, '0');

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-episode-1',
    familyId: 'fam-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'done',
    project: 'demo-farm',
    ticketOrPr: 'DEMO-1',
    slotId: 'host-demo-1',
    branch: 'fix/demo-1',
    taskFile: null,
    steps: [
      { name: 'dispatch', status: 'done' },
      { name: 'review', status: 'failed' },
    ],
    decisions: [],
    metrics: { outcome: 'failure' } as Run['metrics'],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Run;
}

test('an episode references inventory and bundle digests by role, never media bytes', () => {
  const bundle: EpisodeBundle = {
    digest: 'b'.repeat(64),
    taskKey: 'key-1',
    entries: {
      'tasks/key-1/artifacts/recipe-runs/r1/summary.json': {
        path: 'tasks/key-1/artifacts/recipe-runs/r1/summary.json',
        sha256: SHA(1),
        bytes: 10,
      },
      'tasks/key-1/artifacts/recipe-runs/r1/recipe.json': {
        path: 'tasks/key-1/artifacts/recipe-runs/r1/recipe.json',
        sha256: SHA(2),
        bytes: 20,
      },
      'tasks/key-1/artifacts/recipe-runs/r1/evidence-manifest.json': {
        path: 'tasks/key-1/artifacts/recipe-runs/r1/evidence-manifest.json',
        sha256: SHA(14),
        bytes: 30,
      },
      'tasks/key-1/artifacts/recipe-runs/r1/video/full-run.mp4': {
        path: 'tasks/key-1/artifacts/recipe-runs/r1/video/full-run.mp4',
        sha256: SHA(3),
        bytes: 3000,
      },
      'tasks/other-key/artifacts/recipe.json': {
        path: 'tasks/other-key/artifacts/recipe.json',
        sha256: SHA(4),
        bytes: 1,
      },
    },
  };
  const episode = buildRunEpisode(
    run({
      output: {
        artifactManifest: [
          // A retained copy of the same path wins over the inventory entry.
          { path: 'artifacts/recipe-runs/r1/summary.json', purpose: 'other', sha256: SHA(9) },
          { path: 'artifacts/recipe-runs/r0/summary.json', purpose: 'other', sha256: SHA(5) },
          { path: 'artifacts/recipe-runs/r0/trace.json', purpose: 'other', sha256: SHA(6) },
          {
            path: 'artifacts/pipeline-review-loop-1/review-result.json',
            purpose: 'other',
            sha256: SHA(7),
          },
          { path: 'artifacts/recipe-quality.json', purpose: 'other', sha256: SHA(8) },
          { path: 'artifacts/acceptance-status.json', purpose: 'other', sha256: SHA(10) },
          { path: 'artifacts/recipe.json', purpose: 'other', sha256: SHA(11) },
          { path: 'TASK.md', purpose: 'other', sha256: SHA(12) },
          { path: 'artifacts/screens/after.png', purpose: 'screenshot', sha256: SHA(13) },
          { path: 'artifacts/unhashed.json', purpose: 'other' },
        ],
      } as Run['output'],
    }),
    [bundle],
    [{ digest: 'c'.repeat(64), error: 'Retained bundle manifest digest mismatch.' }],
    NOW,
  );

  assert.equal(episode.schema, RUN_EPISODE_SCHEMA);
  assert.deepEqual(
    episode.trajectory.recipeRuns.map(({ dir, files }) => [dir, files.map((file) => file.sha256)]),
    [
      ['artifacts/recipe-runs/r0', [SHA(5), SHA(6)]],
      ['artifacts/recipe-runs/r1', [SHA(14), SHA(2), SHA(1)]],
    ],
  );
  const retained = episode.trajectory.recipeRuns[1].files.find((file) =>
    file.path.endsWith('summary.json'),
  );
  assert.equal(retained?.bundle, bundle.digest);
  assert.deepEqual(
    episode.labels.reviews.map((file) => file.sha256),
    [SHA(7)],
  );
  assert.deepEqual(
    episode.labels.recipeQuality.map((file) => file.sha256),
    [SHA(8)],
  );
  assert.deepEqual(
    episode.labels.evidence.map((file) => file.sha256),
    // An attempt's own evidence manifest is a label too, not only part of the attempt.
    [SHA(10), SHA(14)],
  );
  assert.deepEqual(
    episode.trajectory.recipes.map((file) => file.sha256),
    [SHA(11)],
  );
  assert.deepEqual(
    episode.input.files.map((file) => file.path),
    ['TASK.md'],
  );
  assert.equal(episode.sources.media, 2);
  assert.equal(episode.sources.undigested, 1);
  assert.deepEqual(episode.sources.unreadableBundles, [
    { digest: 'c'.repeat(64), error: 'Retained bundle manifest digest mismatch.' },
  ]);
  assert.equal(episode.labels.failedStep, 'review');
  assert.equal(episode.labels.outcome, 'failure');
});

test('captureRunEpisode writes ended runs only', async () => {
  await rm(runEpisodeDir(), { recursive: true, force: true });
  assert.equal(await captureRunEpisode(run({ id: 'run-active', status: 'monitoring' })), null);
  assert.equal(await readRunEpisode('run-active'), undefined);

  const episode = await captureRunEpisode(run({ id: 'run-ended', status: 'cancelled' }));
  assert.equal(episode?.status, 'cancelled');
  const stored = JSON.parse(await readFile(path.join(runEpisodeDir(), 'run-ended.json'), 'utf8'));
  assert.equal(stored.runId, 'run-ended');
  assert.deepEqual(
    (await readdir(runEpisodeDir())).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

const LIB_A = { name: 'perps', head: 'a'.repeat(40), sourceFingerprint: 'f1', dirtyDigest: null };
const LIB_B = { name: 'bundled', head: null, sourceFingerprint: 'f2', dirtyDigest: 'd1' };
const binding = (libraries: unknown) => ({
  provider: { package: '@demo/provider', version: '1.2.3', module: '/abs/provider.js' },
  identity: { provider: { head: null, sourceFingerprint: 'p1' }, libraries },
});

test('captureRunEpisode copies the pinned provider and library revisions from the task binding', async () => {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'run-episode-binding-'));
  const write = (file: string, value: unknown) =>
    writeFile(path.join(taskDir, file), typeof value === 'string' ? value : JSON.stringify(value));
  try {
    await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
    await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
    const taskFile = path.join(taskDir, 'TASK.md');

    // A task with no binding file (written before bindings existed) has no provenance.
    assert.equal((await captureRunEpisode(run({ id: 'run-legacy', taskFile })))?.provenance, null);

    await write('inputs/recipe-binding.json', binding([LIB_A, LIB_B]));
    const bound = await captureRunEpisode(run({ id: 'run-bound', taskFile }));
    assert.deepEqual(bound?.provenance, {
      source: 'inputs/recipe-binding.json',
      provider: { package: '@demo/provider', version: '1.2.3' },
      libraries: [
        { name: 'perps', revision: 'a'.repeat(40), fingerprint: 'f1', dirty: false },
        { name: 'bundled', revision: null, fingerprint: 'f2', dirty: true },
      ],
      recordedAt: null,
      mirrored: false,
    });

    // After a repin the receipt is refreshed and the binding is not: libraries come
    // from the receipt and the stale provider is dropped.
    const repinned = { ...LIB_A, head: 'b'.repeat(40) };
    await write('artifacts/harness-provenance.json', {
      bindingIdentity: { libraries: [repinned] },
      recordedAt: NOW,
    });
    const output = { capturedAt: NOW, workerFinished: true } as Run['output'];
    const afterRepin = await captureRunEpisode(run({ id: 'run-repinned', taskFile, output }));
    assert.deepEqual(afterRepin?.provenance, {
      source: 'artifacts/harness-provenance.json',
      provider: null,
      libraries: [{ name: 'perps', revision: 'b'.repeat(40), fingerprint: 'f1', dirty: false }],
      recordedAt: NOW,
      mirrored: true,
    });
    await rm(path.join(taskDir, 'artifacts/harness-provenance.json'));

    // An unbound task, a wrongly shaped binding and invalid JSON give null, never a throw.
    for (const [id, value] of [
      ['run-unbound', { identity: null }],
      ['run-shape', { identity: { libraries: {} } }],
      ['run-entries', binding([null, 3, { name: 7 }])],
      ['run-bad-json', '{not json'],
    ] as const) {
      await write('inputs/recipe-binding.json', value);
      const episode = await captureRunEpisode(run({ id, taskFile }));
      assert.equal(
        id === 'run-entries' ? episode?.provenance?.libraries.length : episode?.provenance,
        id === 'run-entries' ? 0 : null,
        id,
      );
      assert.equal((await readRunEpisode(id))?.runId, id);
    }

    // Once retention archives the task copy, a re-capture keeps the recorded value.
    await write('inputs/recipe-binding.json', binding([LIB_A]));
    const first = await captureRunEpisode(run({ id: 'run-archived', taskFile }));
    await rm(taskDir, { recursive: true, force: true });
    const again = await captureRunEpisode(
      run({ id: 'run-archived', taskFile, updatedAt: '2026-11-02T00:00:00.000Z' }),
    );
    assert.deepEqual(again?.provenance, first?.provenance);

    assert.equal((await captureRunEpisode(run({ id: 'run-no-task' })))?.provenance, null);
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});

test('the retry pass visits runs updated since its watermark and keeps it at a failure', async () => {
  await rm(runEpisodeDir(), { recursive: true, force: true });
  const now = Date.parse('2026-11-01T12:00:00.000Z');
  const current = run({ id: 'run-current', updatedAt: '2026-11-01T11:00:00.000Z' });
  await captureRunEpisode(current);
  const runs = [
    current,
    run({ id: 'run-missing', updatedAt: '2026-11-01T11:30:00.000Z' }),
    run({ id: 'run-old', updatedAt: '2026-10-30T11:00:00.000Z' }),
    run({ id: 'run-active', status: 'monitoring', updatedAt: '2026-11-01T11:45:00.000Z' }),
    run({ id: '../escape', updatedAt: '2026-11-01T11:10:00.000Z' }),
  ];

  assert.deepEqual(await captureMissingRunEpisodes(runs, now), { captured: 1, failed: 1 });
  assert.ok(await readRunEpisode('run-missing'));
  assert.equal(await readRunEpisode('run-old'), undefined, 'older than the first retry window');
  const watermark = JSON.parse(
    await readFile(path.join(runEpisodeDir(), 'watermark.json'), 'utf8'),
  );
  assert.equal(watermark.since, Date.parse('2026-11-01T11:10:00.000Z'));

  // The next pass retries from the failure; the captured runs are up to date.
  assert.deepEqual(await captureMissingRunEpisodes(runs.slice(0, 4), now + 1), {
    captured: 0,
    failed: 0,
  });
  const advanced = JSON.parse(await readFile(path.join(runEpisodeDir(), 'watermark.json'), 'utf8'));
  assert.equal(advanced.since, now + 1);
});
