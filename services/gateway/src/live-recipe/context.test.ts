import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { DEFAULT_TASK_DIR, type Run } from '@farmslot/protocol';

import { sanitizeLatestValidRecipeRunPointer } from '../core/recipe-artifacts.js';
import { registerNode, unregisterByWs } from '../fleet/machine-registry.js';
import { farmslotRoot } from '../projects/repo-root.js';

import {
  attachLiveRecipeContext,
  listRecipeRunArtifactGroupsForRun,
  loadLiveRecipeContextForRun,
} from './context.js';
import { FakeNodeWebSocket, makeRun, poolDir } from './test-fixtures.js';

test('loadLiveRecipeContextForRun projects live recipe artifacts without decision fallback', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-live-recipe-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const taskDir = path.join(root, 'tasks', 'live-recipe');
  const artifactsDir = path.join(taskDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(path.join(artifactsDir, 'recipe.json'), '{"entry":"start"}\n', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'learnings.md'),
    'Watch for stale metro sockets.\n',
    'utf-8',
  );
  await writeFile(
    path.join(artifactsDir, 'recipe-quality.json'),
    JSON.stringify({
      version: 1,
      verdict: 'pass',
      compact: {
        verdict: 'PASS',
        reasons: ['Recipe-run artifacts were found.'],
        better_version_guidance: [],
      },
      dimensions: {},
      structural_findings: [],
      contextual_findings: [],
      suggested_recipe_delta: [],
      training_fields: { project: 'example-mobile-farm', flow_type: 'dev', proof_mode: 'mixed' },
      meta: {
        producer: 'worker',
        fallback_used: false,
        legacy_task: false,
        artifact_required: true,
        source_signals: ['recipe-quality.json'],
      },
    }),
    'utf-8',
  );

  const run = makeRun(path.join(taskDir, 'TASK.md'), { id: 'run-typed-artifacts-1' });
  const context = await loadLiveRecipeContextForRun(run);

  assert.ok(context);
  assert.equal(context.source, 'recipe-run-artifacts');
  assert.equal(context.recipeRunId, null);
  assert.equal(context.selectionReason, 'latest-run');
  assert.equal(context.artifactRoot, artifactsDir);
  assert.equal(context.recipeJson, '{"entry":"start"}\n');
  assert.equal(context.workerLearnings, 'Watch for stale metro sockets.\n');
  assert.equal(context.recipeQualityArtifact?.compact.verdict, 'PASS');
  assert.ok((context.artifactManifest?.length ?? 0) >= 3);
});

test('loadLiveRecipeContextForRun falls back to inputs/inherited recipe.json', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-inherited-recipe-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const taskDir = path.join(root, 'tasks', 'inherited-recipe-only');
  const inheritedDir = path.join(taskDir, 'inputs', 'inherited');
  await mkdir(inheritedDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(
    path.join(inheritedDir, 'recipe.json'),
    '{"title":"Inherited related-markets recipe"}\n',
    'utf-8',
  );

  const run = makeRun(path.join(taskDir, 'TASK.md'), { id: 'run-inherited-recipe-1' });
  const context = await loadLiveRecipeContextForRun(run);
  const groups = await listRecipeRunArtifactGroupsForRun(run);

  assert.ok(context);
  assert.match(context.recipeJson ?? '', /Inherited related-markets recipe/);
  assert.equal(context.artifactRoot, inheritedDir);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.groupKind, 'current-artifacts');
  assert.equal(groups[0]?.label, 'Inherited recipe package');
});

test('loadLiveRecipeContextForRun includes current artifact screenshots referenced by evidence manifest', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-current-evidence-screenshots-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const taskDir = path.join(root, 'tasks', 'current-evidence-screenshots');
  const artifactsDir = path.join(taskDir, 'artifacts');
  const screenshotsDir = path.join(artifactsDir, 'screenshots');
  await mkdir(screenshotsDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(path.join(artifactsDir, 'recipe.json'), '{"entry":"start"}\n', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'evidence-manifest.json'),
    JSON.stringify({
      version: 1,
      standalone: [{ label: 'AC1 proof', file: 'screenshots/after-ac1.png' }],
    }),
    'utf-8',
  );
  await writeFile(path.join(screenshotsDir, 'after-ac1.png'), 'png', 'utf-8');
  await writeFile(path.join(screenshotsDir, 'raw-debug.png'), 'png', 'utf-8');
  await mkdir(path.join(screenshotsDir, '.omc'), { recursive: true });
  await writeFile(path.join(screenshotsDir, '.omc', 'state.json'), '{}', 'utf-8');

  const context = await loadLiveRecipeContextForRun(makeRun(path.join(taskDir, 'TASK.md')));
  const artifactPaths = (context?.artifactManifest ?? []).map((artifact) => artifact.path);
  assert.ok(
    artifactPaths.includes('artifacts/screenshots/after-ac1.png'),
    'current-artifacts must expose screenshots referenced by evidence-manifest.json',
  );
  assert.equal(
    artifactPaths.includes('artifacts/screenshots/raw-debug.png'),
    false,
    'current-artifacts should not expose unreferenced raw screenshot spool files',
  );
  assert.equal(
    artifactPaths.includes('artifacts/screenshots/.omc/state.json'),
    false,
    'artifact scans should ignore hidden tool state under artifact roots',
  );
});

test('loadLiveRecipeContextForRun prefers typed artifact manifest metadata over scanned fallback artifacts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-typed-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const taskDir = path.join(root, 'tasks', 'typed-artifacts');
  const artifactsDir = path.join(taskDir, 'artifacts');
  const screenshotsDir = path.join(artifactsDir, 'screenshots');
  await mkdir(screenshotsDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(path.join(artifactsDir, 'summary.json'), '{"status":"pass"}\n', 'utf-8');
  await writeFile(path.join(artifactsDir, 'trace.json'), '[]\n', 'utf-8');
  await writeFile(path.join(screenshotsDir, 'proof.png'), 'png', 'utf-8');
  await writeFile(path.join(artifactsDir, 'console-errors.json'), '[]\n', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'artifact-manifest.json'),
    JSON.stringify({
      version: 1,
      runStatus: 'pass',
      artifacts: [
        {
          path: 'screenshots/proof.png',
          type: 'screenshot',
          label: 'Human readable proof',
          nodeId: 'ac1-proof',
          mimeType: 'image/png',
        },
        // Early runners sometimes wrote paths with an `artifacts/` prefix; keep
        // accepting that form while normalizing to one artifact-root prefix.
        { path: 'artifacts/summary.json', type: 'summary', label: 'Run summary' },
        { path: './trace.json', type: 'trace', label: 'Step trace' },
      ],
    }),
    'utf-8',
  );

  const run = makeRun(path.join(taskDir, 'TASK.md'));
  const context = await loadLiveRecipeContextForRun(run);
  const artifactManifest = context?.artifactManifest ?? [];
  const proof = artifactManifest.find(
    (artifact) => artifact.path === 'artifacts/screenshots/proof.png',
  );

  assert.equal(context?.source, 'recipe-run-artifacts');
  assert.equal(context?.usedTypedArtifactManifest, true);
  assert.equal(proof?.purpose, 'screenshot');
  assert.equal(proof?.type, 'screenshot');
  assert.equal(proof?.label, 'Human readable proof');
  assert.equal(proof?.nodeId, 'ac1-proof');
  assert.equal(proof?.mimeType, 'image/png');
  assert.ok(
    artifactManifest.some(
      (artifact) => artifact.path === 'artifacts/summary.json' && artifact.purpose === 'summary',
    ),
  );
  assert.ok(
    artifactManifest.some(
      (artifact) => artifact.path === 'artifacts/trace.json' && artifact.purpose === 'trace',
    ),
  );
  assert.deepEqual(
    artifactManifest.map((artifact) => artifact.path).sort(),
    ['artifacts/screenshots/proof.png', 'artifacts/summary.json', 'artifacts/trace.json'],
    'typed artifact manifests are the rendering source of truth when valid',
  );
  assert.ok(
    !artifactManifest.some((artifact) => artifact.path === 'artifacts/console-errors.json'),
  );
  assert.ok(
    !artifactManifest.some((artifact) => artifact.path === 'artifacts/artifact-manifest.json'),
  );
});

test('loadLiveRecipeContextForRun quarantines invalid typed artifact manifests behind legacy scanning', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-invalid-typed-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const taskDir = path.join(root, 'tasks', 'typed-artifacts');
  const artifactsDir = path.join(taskDir, 'artifacts');
  const screenshotsDir = path.join(artifactsDir, 'screenshots');
  await mkdir(screenshotsDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(path.join(artifactsDir, 'summary.json'), '{"status":"pass"}\n', 'utf-8');
  await writeFile(path.join(screenshotsDir, 'proof.png'), 'png', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'artifact-manifest.json'),
    JSON.stringify({
      version: 1,
      runStatus: 'pass',
      artifacts: [
        { path: 'screenshots/proof.png', type: 'screenshot' },
        { path: '../outside.png', type: 'screenshot' },
      ],
    }),
    'utf-8',
  );

  const context = await loadLiveRecipeContextForRun(makeRun(path.join(taskDir, 'TASK.md')));
  const artifactManifest = context?.artifactManifest ?? [];

  assert.equal(context?.source, 'recipe-run-artifacts');
  assert.equal(context?.usedTypedArtifactManifest, false);
  assert.ok(artifactManifest.some((artifact) => artifact.path === 'artifacts/summary.json'));
  assert.ok(!artifactManifest.some((artifact) => artifact.path.includes('outside')));
});

test('attachLiveRecipeContext preserves explicit stale context when no live artifacts can be materialized', async () => {
  const run = makeRun(null, {
    liveRecipeContext: {
      source: 'recipe-run-artifacts',
      recipeRunId: 'recipe-run-stale-1',
      artifactRoot: '/tmp/missing',
      artifactManifest: null,
      recipeJson: null,
      recipeQualityArtifact: null,
      qualityReport: null,
      workerLearnings: null,
      isStale: true,
      selectionReason: 'user-selected',
    },
  });

  const enriched = await attachLiveRecipeContext(run);
  assert.equal(enriched.liveRecipeContext?.recipeRunId, 'recipe-run-stale-1');
  assert.equal(enriched.liveRecipeContext?.isStale, true);
});

test('sanitizeLatestValidRecipeRunPointer rejects parent traversal', () => {
  const pointer = sanitizeLatestValidRecipeRunPointer({
    version: 1,
    runId: 'bad',
    relativeArtifactRoot: 'recipe-runs/../../../tmp/outside',
  });
  assert.equal(pointer, null);
});

test('sanitizeLatestValidRecipeRunPointer rejects non-numeric version', () => {
  const pointer = sanitizeLatestValidRecipeRunPointer({
    version: '1' as unknown as number,
    runId: 'bad',
    relativeArtifactRoot: 'recipe-runs/run-1',
  });
  assert.equal(pointer, null);
});

test('sanitizeLatestValidRecipeRunPointer rejects unsupported version numbers', () => {
  const pointer = sanitizeLatestValidRecipeRunPointer({
    version: 2,
    runId: 'bad',
    relativeArtifactRoot: 'recipe-runs/run-1',
  });
  assert.equal(pointer, null);
});

test('loadLiveRecipeContextForRun warns when latest-valid recipe-run pointer is invalid', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-live-invalid-pointer-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const taskDir = path.join(root, 'tasks', 'invalid-pointer');
  const artifactsDir = path.join(taskDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      runId: 'bad',
      relativeArtifactRoot: '../outside',
    }),
    'utf-8',
  );

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown, ...rest: unknown[]) => {
    warnings.push([message, ...rest].map((part) => String(part)).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  const context = await loadLiveRecipeContextForRun(makeRun(path.join(taskDir, 'TASK.md')));
  assert.equal(context, null);
  assert.ok(
    warnings.some((warning) => warning.includes('invalid latest valid recipe-run pointer')),
  );
});

test('loadLiveRecipeContextForRun ignores schema-invalid recipe-quality artifacts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-live-invalid-quality-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const taskDir = path.join(root, 'tasks', 'invalid-quality');
  const artifactsDir = path.join(taskDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'recipe-quality.json'),
    JSON.stringify({ version: 1 }),
    'utf-8',
  );

  const context = await loadLiveRecipeContextForRun(makeRun(path.join(taskDir, 'TASK.md')));
  assert.equal(context, null);
});

test('loadLiveRecipeContextForRun prefers remote slot artifacts over coincidental local path matches', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-live-remote-locality-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const projectName = `remote-locality-${Date.now()}`;
  const projectDir = path.join(farmslotRoot, 'projects', projectName);
  const taskDir = path.join(projectDir, 'tasks', 'remote-locality');
  const collidingArtifactRoot = path.join(
    '/tmp/repo',
    DEFAULT_TASK_DIR,
    'remote-locality',
    'artifacts',
    'recipe-runs',
    'remote-run',
  );
  await mkdir(taskDir, { recursive: true });
  await mkdir(collidingArtifactRoot, { recursive: true });
  await writeFile(path.join(projectDir, 'project.json'), JSON.stringify({ hooks: {} }), 'utf-8');
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(path.join(collidingArtifactRoot, 'recipe.json'), '{"entry":"local"}\n', 'utf-8');
  await writeFile(path.join(collidingArtifactRoot, 'learnings.md'), 'local learnings\n', 'utf-8');

  const poolFile = path.join(poolDir, `remote-slot-locality-${Date.now()}.json`);
  await writeFile(
    poolFile,
    JSON.stringify({
      machine: 'remote-machine-locality',
      project: 'demo-project',
      platform: 'ios',
      os: 'linux',
      host: '203.0.113.20',
      ssh_user: 'tester',
      slots: [
        {
          id: 'remote-slot-locality',
          repo: '/tmp/repo',
          session: 'slot',
        },
      ],
    }),
    'utf-8',
  );
  t.after(() => rm(poolFile, { force: true }));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  t.after(() => rm('/tmp/repo', { recursive: true, force: true }));

  const fakeWs = new FakeNodeWebSocket({
    onRead: ({ path: requestedPath }) => {
      if (requestedPath === path.join(collidingArtifactRoot, 'recipe.json'))
        return { content: '{"entry":"remote"}\n' };
      if (requestedPath === path.join(collidingArtifactRoot, 'learnings.md'))
        return { content: 'remote learnings\n' };
      return undefined;
    },
    onList: ({ path: requestedPath }) =>
      requestedPath === collidingArtifactRoot
        ? {
            entries: [
              { name: 'recipe.json', type: 'file', size: 19 },
              { name: 'learnings.md', type: 'file', size: 17 },
            ],
          }
        : { entries: [] },
  });
  registerNode('remote-machine-locality', 123, fakeWs as any);
  t.after(() => {
    unregisterByWs(fakeWs as any);
  });

  const context = await loadLiveRecipeContextForRun(
    makeRun(path.join(taskDir, 'TASK.md'), {
      slotId: 'remote-slot-locality',
      project: projectName,
      liveRecipeContext: {
        source: 'recipe-run-artifacts',
        recipeRunId: 'remote-run',
        artifactRoot: collidingArtifactRoot,
        artifactManifest: null,
        recipeJson: null,
        recipeQualityArtifact: null,
        qualityReport: null,
        workerLearnings: null,
        isStale: false,
        selectionReason: 'user-selected',
      },
    }),
  );

  assert.equal(context?.recipeJson, '{"entry":"remote"}\n');
  assert.equal(context?.workerLearnings, 'remote learnings\n');
  assert.deepEqual(
    [...(context?.artifactManifest?.map((artifact) => artifact.path) ?? [])].sort(),
    ['artifacts/learnings.md', 'artifacts/recipe.json'].sort(),
  );
});

test('loadLiveRecipeContextForRun prefers reachable worker texts over stale local artifact copies', async (t) => {
  await withOfflineRemoteCachedArtifacts(t, async ({ run, artifactsDir }) => {
    await writeFile(path.join(artifactsDir, 'recipe.json'), '{"entry":"stale-local"}\n', 'utf-8');
    await writeFile(path.join(artifactsDir, 'learnings.md'), 'stale local learnings\n', 'utf-8');

    const remoteArtifactsDir = path.join(
      '/tmp/repo',
      DEFAULT_TASK_DIR,
      'offline-cache',
      'artifacts',
    );
    const fakeWs = new FakeNodeWebSocket({
      onRead: ({ path: requestedPath }) => {
        if (requestedPath === path.join(remoteArtifactsDir, 'recipe.json'))
          return { content: '{"entry":"fresh-remote"}\n' };
        if (requestedPath === path.join(remoteArtifactsDir, 'learnings.md'))
          return { content: 'fresh remote learnings\n' };
        return undefined;
      },
      onList: ({ path: requestedPath }) =>
        requestedPath === remoteArtifactsDir
          ? {
              entries: [
                { name: 'recipe.json', type: 'file', size: 25 },
                { name: 'learnings.md', type: 'file', size: 22 },
              ],
            }
          : { entries: [] },
    });
    registerNode('remote-machine-offline', 127, fakeWs as any);
    t.after(() => {
      unregisterByWs(fakeWs as any);
    });

    const context = await loadLiveRecipeContextForRun({
      ...run,
      liveRecipeContext: {
        source: 'recipe-run-artifacts',
        recipeRunId: null,
        artifactRoot: artifactsDir,
        artifactManifest: null,
        recipeJson: null,
        recipeQualityArtifact: null,
        qualityReport: null,
        workerLearnings: null,
        isStale: false,
        selectionReason: 'latest-run',
      },
    });

    assert.equal(context?.recipeJson, '{"entry":"fresh-remote"}\n');
    assert.equal(context?.workerLearnings, 'fresh remote learnings\n');
  });
});

async function withOfflineRemoteCachedArtifacts(
  t: TestContext,
  fn: (args: {
    run: Run;
    taskDir: string;
    artifactsDir: string;
    passingRunDir: string;
    poolFile: string;
    projectDir: string;
  }) => Promise<void>,
) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const projectName = `remote-cache-${suffix}`;
  const projectDir = path.join(farmslotRoot, 'projects', projectName);
  const taskDir = path.join(projectDir, 'tasks', 'offline-cache');
  const artifactsDir = path.join(taskDir, 'artifacts');
  const passingRunDir = path.join(artifactsDir, 'recipe-runs', 'passing-run');
  const poolFile = path.join(farmslotRoot, 'pool', `remote-cache-${suffix}.json`);

  await mkdir(passingRunDir, { recursive: true });
  await writeFile(path.join(projectDir, 'project.json'), JSON.stringify({ hooks: {} }), 'utf-8');
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(path.join(artifactsDir, 'recipe.json'), '{"entry":"bundle"}\n', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      runId: 'passing-run',
      relativeArtifactRoot: 'recipe-runs/passing-run',
    }),
    'utf-8',
  );
  await writeFile(
    path.join(passingRunDir, 'summary.json'),
    JSON.stringify({ status: 'pass' }),
    'utf-8',
  );
  await writeFile(path.join(passingRunDir, 'recipe.json'), '{"entry":"passing"}\n', 'utf-8');
  await writeFile(
    poolFile,
    JSON.stringify({
      machine: 'remote-machine-offline',
      project: projectName,
      platform: 'ios',
      os: 'linux',
      host: '203.0.113.30',
      ssh_user: 'tester',
      slots: [
        {
          id: 'remote-slot-offline',
          repo: '/tmp/repo',
          session: 'slot',
        },
      ],
    }),
    'utf-8',
  );

  t.after(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(poolFile, { force: true });
  });

  await fn({
    run: makeRun(path.join(taskDir, 'TASK.md'), {
      slotId: 'remote-slot-offline',
      project: projectName,
    }),
    taskDir,
    artifactsDir,
    passingRunDir,
    poolFile,
    projectDir,
  });
}

test('loadLiveRecipeContextForRun falls back to the local promoted pointer when the remote slot is offline', async (t) => {
  await withOfflineRemoteCachedArtifacts(t, async ({ run, passingRunDir }) => {
    const context = await loadLiveRecipeContextForRun(run);
    assert.equal(context?.recipeRunId, 'passing-run');
    assert.equal(context?.artifactRoot, passingRunDir);
    assert.equal(context?.recipeJson, '{"entry":"passing"}\n');
  });
});

test('listRecipeRunArtifactGroupsForRun falls back to local cached groups when worker artifacts are unreachable', async (t) => {
  await withOfflineRemoteCachedArtifacts(t, async ({ run, passingRunDir }) => {
    const groups = await listRecipeRunArtifactGroupsForRun(run);
    assert.deepEqual(
      groups.map((group) => group.groupKind),
      ['current-artifacts', 'latest-valid'],
    );
    assert.equal(groups[0]?.artifactRoot, path.join(path.dirname(run.taskFile!), 'artifacts'));
    assert.equal(groups[1]?.artifactRoot, passingRunDir);
    assert.equal(groups[1]?.recipeRunId, 'passing-run');
  });
});

test('loadLiveRecipeContextForRun falls back to the next readable promoted pointer when the worker pointer target is missing', async (t) => {
  await withOfflineRemoteCachedArtifacts(t, async ({ run, passingRunDir }) => {
    const workerArtifactsDir = path.join(
      '/tmp/repo',
      DEFAULT_TASK_DIR,
      'offline-cache',
      'artifacts',
    );
    const workerPointerPath = path.join(workerArtifactsDir, 'latest-valid-recipe-run.json');
    const fakeWs = new FakeNodeWebSocket({
      onRead: ({ path: requestedPath }) => {
        if (requestedPath === workerPointerPath) {
          return {
            content: JSON.stringify({
              version: 1,
              runId: 'passing-run',
              relativeArtifactRoot: 'recipe-runs/passing-run',
            }),
          };
        }
        return undefined;
      },
      onList: () => ({ entries: [] }),
    });
    registerNode('remote-machine-offline', 123, fakeWs as any);
    t.after(() => {
      unregisterByWs(fakeWs as any);
    });

    const context = await loadLiveRecipeContextForRun(run);
    assert.equal(context?.recipeRunId, 'passing-run');
    assert.equal(context?.artifactRoot, passingRunDir);
    assert.equal(context?.recipeJson, '{"entry":"passing"}\n');
  });
});

test('listRecipeRunArtifactGroupsForRun skips missing worker promoted targets and keeps local cached evidence', async (t) => {
  await withOfflineRemoteCachedArtifacts(t, async ({ run, passingRunDir }) => {
    const workerArtifactsDir = path.join(
      '/tmp/repo',
      DEFAULT_TASK_DIR,
      'offline-cache',
      'artifacts',
    );
    const workerPointerPath = path.join(workerArtifactsDir, 'latest-valid-recipe-run.json');
    const fakeWs = new FakeNodeWebSocket({
      onRead: ({ path: requestedPath }) => {
        if (requestedPath === workerPointerPath) {
          return {
            content: JSON.stringify({
              version: 1,
              runId: 'passing-run',
              relativeArtifactRoot: 'recipe-runs/passing-run',
            }),
          };
        }
        return undefined;
      },
      onList: () => ({ entries: [] }),
    });
    registerNode('remote-machine-offline', 124, fakeWs as any);
    t.after(() => {
      unregisterByWs(fakeWs as any);
    });

    const groups = await listRecipeRunArtifactGroupsForRun(run);
    assert.deepEqual(
      groups.map((group) => group.groupKind),
      ['current-artifacts', 'latest-valid'],
    );
    assert.equal(groups[1]?.artifactRoot, passingRunDir);
    assert.equal(groups[1]?.recipeRunId, 'passing-run');
  });
});

test('loadLiveRecipeContextForRun re-materializes missing promoted files from the remote slot when the local cache is partial', async (t) => {
  await withOfflineRemoteCachedArtifacts(t, async ({ run, passingRunDir }) => {
    await unlink(path.join(passingRunDir, 'recipe.json'));
    const remotePassingRunDir = path.join(
      '/tmp/repo',
      DEFAULT_TASK_DIR,
      'offline-cache',
      'artifacts',
      'recipe-runs',
      'passing-run',
    );
    const fakeWs = new FakeNodeWebSocket({
      onRead: ({ path: requestedPath }) => {
        if (requestedPath === path.join(remotePassingRunDir, 'recipe.json'))
          return { content: '{"entry":"remote-passing"}\n' };
        if (requestedPath === path.join(remotePassingRunDir, 'learnings.md'))
          return { content: 'remote learnings\n' };
        if (requestedPath === path.join(remotePassingRunDir, 'summary.json'))
          return { content: '{"status":"pass"}' };
        if (requestedPath === path.join(remotePassingRunDir, 'after.mp4'))
          return { content: 'video.mp4' };
        return undefined;
      },
      onList: ({ path: requestedPath }) =>
        requestedPath === remotePassingRunDir
          ? {
              entries: [
                { name: 'summary.json', type: 'file', size: 17 },
                { name: 'recipe.json', type: 'file', size: 27 },
                { name: 'learnings.md', type: 'file', size: 17 },
              ],
            }
          : { entries: [] },
    });
    registerNode('remote-machine-offline', 125, fakeWs as any);
    t.after(() => {
      unregisterByWs(fakeWs as any);
    });

    const context = await loadLiveRecipeContextForRun(run);
    assert.equal(context?.recipeRunId, 'passing-run');
    assert.equal(context?.artifactRoot, passingRunDir);
    assert.equal(context?.recipeJson, '{"entry":"remote-passing"}\n');
    assert.ok(
      context?.artifactManifest?.some((artifact) => artifact.path === 'artifacts/learnings.md'),
    );
  });
});

test('loadLiveRecipeContextForRun re-materializes promoted artifact manifests when the local cache root is missing', async (t) => {
  await withOfflineRemoteCachedArtifacts(t, async ({ run, passingRunDir }) => {
    await rm(passingRunDir, { recursive: true, force: true });
    const remotePassingRunDir = path.join(
      '/tmp/repo',
      DEFAULT_TASK_DIR,
      'offline-cache',
      'artifacts',
      'recipe-runs',
      'passing-run',
    );
    const fakeWs = new FakeNodeWebSocket({
      onRead: ({ path: requestedPath }) => {
        if (requestedPath === path.join(remotePassingRunDir, 'recipe.json'))
          return { content: '{"entry":"remote-passing"}\n' };
        if (requestedPath === path.join(remotePassingRunDir, 'learnings.md'))
          return { content: 'remote learnings\n' };
        if (requestedPath === path.join(remotePassingRunDir, 'summary.json'))
          return { content: '{"status":"pass"}' };
        if (requestedPath === path.join(remotePassingRunDir, 'after.mp4'))
          return { content: 'video.mp4' };
        return undefined;
      },
      onList: ({ path: requestedPath }) =>
        requestedPath === remotePassingRunDir
          ? {
              entries: [
                { name: 'summary.json', type: 'file', size: 17 },
                { name: 'recipe.json', type: 'file', size: 27 },
                { name: 'learnings.md', type: 'file', size: 17 },
                { name: 'after.mp4', type: 'file', size: 9 },
              ],
            }
          : { entries: [] },
    });
    registerNode('remote-machine-offline', 126, fakeWs as any);
    t.after(() => {
      unregisterByWs(fakeWs as any);
    });

    const context = await loadLiveRecipeContextForRun(run);
    assert.equal(context?.recipeRunId, 'passing-run');
    assert.equal(context?.recipeJson, '{"entry":"remote-passing"}\n');
    assert.ok(
      context?.artifactManifest?.some((artifact) => artifact.path === 'artifacts/after.mp4'),
    );
  });
});

test('loadLiveRecipeContextForRun keeps live recipe-run context ahead of promoted pointer', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-live-priority-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const taskDir = path.join(root, 'tasks', 'live-priority');
  const artifactsDir = path.join(taskDir, 'artifacts');
  const liveRunDir = path.join(artifactsDir, 'recipe-runs', 'live-run');
  const passingRunDir = path.join(artifactsDir, 'recipe-runs', 'passing-run');
  await mkdir(liveRunDir, { recursive: true });
  await mkdir(passingRunDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'latest-valid-recipe-run.json'),
    JSON.stringify({
      version: 1,
      runId: 'passing-run',
      relativeArtifactRoot: 'recipe-runs/passing-run',
    }),
    'utf-8',
  );
  await writeFile(
    path.join(liveRunDir, 'summary.json'),
    JSON.stringify({ status: 'fail' }),
    'utf-8',
  );
  await writeFile(
    path.join(passingRunDir, 'summary.json'),
    JSON.stringify({ status: 'pass' }),
    'utf-8',
  );
  await writeFile(path.join(liveRunDir, 'trace.json'), JSON.stringify([{ id: 'live' }]), 'utf-8');
  await writeFile(
    path.join(passingRunDir, 'trace.json'),
    JSON.stringify([{ id: 'pass' }]),
    'utf-8',
  );

  const run = makeRun(path.join(taskDir, 'TASK.md'), {
    liveRecipeContext: {
      source: 'recipe-run-live',
      recipeRunId: 'live-run',
      artifactRoot: liveRunDir,
      artifactManifest: null,
      recipeJson: null,
      recipeQualityArtifact: null,
      qualityReport: null,
      workerLearnings: null,
      isStale: false,
      selectionReason: 'latest-run',
    },
  });

  const context = await loadLiveRecipeContextForRun(run);
  assert.equal(context?.recipeRunId, 'live-run');
  assert.equal(context?.artifactRoot, liveRunDir);
});

test('loadLiveRecipeContextForRun does not mark fresh remote recipe-run-live selections stale before artifacts land', async (t) => {
  await withOfflineRemoteCachedArtifacts(t, async ({ run }) => {
    const liveRunDir = path.join(
      '/tmp/repo',
      DEFAULT_TASK_DIR,
      'offline-cache',
      'artifacts',
      'recipe-runs',
      'live-run',
    );
    const fakeWs = new FakeNodeWebSocket({
      onRead: () => undefined,
      onList: () => undefined,
    });
    registerNode('remote-machine-offline', 129, fakeWs as any);
    t.after(() => {
      unregisterByWs(fakeWs as any);
    });

    const context = await loadLiveRecipeContextForRun({
      ...run,
      liveRecipeContext: {
        source: 'recipe-run-live',
        recipeRunId: 'live-run',
        artifactRoot: liveRunDir,
        artifactManifest: null,
        recipeJson: null,
        recipeQualityArtifact: null,
        qualityReport: null,
        workerLearnings: null,
        isStale: false,
        selectionReason: 'latest-run',
      },
    });

    assert.equal(context?.recipeRunId, 'live-run');
    assert.equal(context?.artifactRoot, liveRunDir);
    assert.equal(context?.isStale, false);
  });
});

test('listRecipeRunArtifactGroupsForRun does not mark fresh remote live-run groups stale before artifacts land', async (t) => {
  await withOfflineRemoteCachedArtifacts(t, async ({ run }) => {
    const liveRunDir = path.join(
      '/tmp/repo',
      DEFAULT_TASK_DIR,
      'offline-cache',
      'artifacts',
      'recipe-runs',
      'live-run',
    );
    const fakeWs = new FakeNodeWebSocket({
      onRead: () => undefined,
      onList: () => undefined,
    });
    registerNode('remote-machine-offline', 130, fakeWs as any);
    t.after(() => {
      unregisterByWs(fakeWs as any);
    });

    const groups = await listRecipeRunArtifactGroupsForRun({
      ...run,
      liveRecipeContext: {
        source: 'recipe-run-live',
        recipeRunId: 'live-run',
        artifactRoot: liveRunDir,
        artifactManifest: null,
        recipeJson: null,
        recipeQualityArtifact: null,
        qualityReport: null,
        workerLearnings: null,
        isStale: false,
        selectionReason: 'latest-run',
      },
    });

    const liveGroup = groups.find((group) => group.groupKind === 'live-run');
    assert.equal(liveGroup?.recipeRunId, 'live-run');
    assert.equal(liveGroup?.isStale, false);
  });
});

test('attachLiveRecipeContext preserves run identity when context is structurally unchanged', async () => {
  const run = makeRun(null, {
    liveRecipeContext: {
      source: 'recipe-run-artifacts',
      recipeRunId: 'recipe-run-stale-1',
      artifactRoot: '/tmp/missing',
      artifactManifest: null,
      recipeJson: null,
      recipeQualityArtifact: null,
      qualityReport: null,
      workerLearnings: null,
      isStale: true,
      selectionReason: 'user-selected',
    },
  });

  const enriched = await attachLiveRecipeContext(run);
  assert.equal(enriched, run);
});

test('loadLiveRecipeContextForRun rejects persisted live artifact roots from a different task', async (t) => {
  await withOfflineRemoteCachedArtifacts(t, async ({ run }) => {
    const context = await loadLiveRecipeContextForRun({
      ...run,
      liveRecipeContext: {
        source: 'recipe-run-artifacts',
        recipeRunId: 'wrong-run',
        artifactRoot: '/tmp/other-task/artifacts/recipe-runs/wrong-run',
        artifactManifest: [{ path: 'artifacts/evidence.png', purpose: 'screenshot' }],
        recipeJson: '{"entry":"wrong"}',
        recipeQualityArtifact: null,
        qualityReport: null,
        workerLearnings: null,
        isStale: false,
        selectionReason: 'user-selected',
      },
    });

    assert.equal(
      context?.artifactRoot,
      path.join(path.dirname(run.taskFile!), 'artifacts', 'recipe-runs', 'passing-run'),
    );
    assert.equal(context?.recipeRunId, 'passing-run');
  });
});

test('loadLiveRecipeContextForRun keeps selected evidence stale instead of dropping it when remote artifact scan is unavailable', async (t) => {
  await withOfflineRemoteCachedArtifacts(t, async ({ run, passingRunDir }) => {
    await unlink(path.join(passingRunDir, 'recipe.json'));
    await unlink(path.join(passingRunDir, 'summary.json'));

    const remotePassingRunDir = path.join(
      '/tmp/repo',
      DEFAULT_TASK_DIR,
      'offline-cache',
      'artifacts',
      'recipe-runs',
      'passing-run',
    );
    const fakeWs = new FakeNodeWebSocket({
      onRead: ({ path: requestedPath }) => {
        if (requestedPath === path.join(remotePassingRunDir, 'recipe.json'))
          return { content: '{"entry":"remote-passing"}\n' };
        return undefined;
      },
      onList: () => undefined,
    });
    registerNode('remote-machine-offline', 128, fakeWs as any);
    t.after(() => {
      unregisterByWs(fakeWs as any);
    });

    const context = await loadLiveRecipeContextForRun({
      ...run,
      liveRecipeContext: {
        source: 'recipe-run-artifacts',
        recipeRunId: 'passing-run',
        artifactRoot: passingRunDir,
        artifactManifest: null,
        recipeJson: null,
        recipeQualityArtifact: null,
        qualityReport: null,
        workerLearnings: null,
        isStale: false,
        selectionReason: 'user-selected',
      },
    });

    assert.equal(context?.artifactRoot, passingRunDir);
    assert.equal(context?.recipeRunId, 'passing-run');
    assert.equal(context?.recipeJson, '{"entry":"remote-passing"}\n');
    assert.equal(context?.isStale, true);
  });
});
