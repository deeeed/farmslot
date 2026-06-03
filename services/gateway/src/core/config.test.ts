import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  farmslotRoot,
  getOrchestratorTaskRoot,
  isHttpFetchForbiddenPort,
  isMockModeProject,
  loadProjectVars,
  resolveTaskRelDir,
} from './config.js';

test('isMockModeProject detects external mock_mode flag', () => {
  assert.equal(isMockModeProject({ external: { mock_mode: true } } as any), true);
  assert.equal(isMockModeProject({} as any), false);
});

test('isHttpFetchForbiddenPort flags CDP ports that Node fetch refuses', () => {
  assert.equal(isHttpFetchForbiddenPort(6665), true);
  assert.equal(isHttpFetchForbiddenPort(6666), true);
  assert.equal(isHttpFetchForbiddenPort(7665), false);
  assert.equal(isHttpFetchForbiddenPort(7666), false);
});

test('getOrchestratorTaskRoot uses sandbox path for mock projects', () => {
  assert.equal(
    getOrchestratorTaskRoot('farmslot-farm', {
      external: { mock_mode: true },
      task_dir: '.sandbox/farmslot-farm/worker-task',
    } as any),
    path.join(farmslotRoot, '.sandbox', 'farmslot-farm', 'tasks'),
  );
});

test('getOrchestratorTaskRoot uses projects path for normal projects', () => {
  assert.equal(
    getOrchestratorTaskRoot('example-mobile-farm', {} as any),
    path.join(farmslotRoot, 'projects', 'example-mobile-farm', 'tasks'),
  );
});

test('resolveTaskRelDir derives task-relative directories from task roots', () => {
  assert.equal(
    resolveTaskRelDir(
      path.join(farmslotRoot, 'projects', 'demo-project', 'tasks', 'feature', 'TASK.md'),
      path.join(farmslotRoot, 'projects', 'demo-project', 'tasks'),
    ),
    'feature',
  );
});

test('resolveTaskRelDir rejects task files outside the task root', () => {
  assert.equal(
    resolveTaskRelDir(
      path.join(farmslotRoot, 'projects', 'other-project', 'tasks', 'feature', 'TASK.md'),
      path.join(farmslotRoot, 'projects', 'demo-project', 'tasks'),
    ),
    null,
  );
});

test('resolveTaskRelDir supports alternate task filenames when requested', () => {
  assert.equal(
    resolveTaskRelDir(
      path.join(farmslotRoot, 'projects', 'demo-project', 'tasks', 'feature', 'SELF-REVIEW.md'),
      path.join(farmslotRoot, 'projects', 'demo-project', 'tasks'),
      'SELF-REVIEW.md',
    ),
    'feature',
  );
});

test('loadProjectVars validates auto_recovery disabled_patterns as string array', async (t) => {
  const project = `auto-recovery-config-${process.pid}`;
  const projectDir = path.join(farmslotRoot, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  t.after(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      auto_recovery: {
        enabled: true,
        maxAttempts: 1,
        allowedSteps: ['prepare'],
        allowedCategories: ['infra'],
        disabled_patterns: ['devserver-crashed'],
        llm: { enabled: false, dailyUsdCap: 0 },
      },
    }),
  );
  await assert.doesNotReject(() => loadProjectVars(project));
  const invalidProject = `${project}-invalid`;
  const invalidDir = path.join(farmslotRoot, 'projects', invalidProject);
  await mkdir(invalidDir, { recursive: true });
  t.after(async () => {
    await rm(invalidDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(invalidDir, 'project.json'),
    JSON.stringify({ name: invalidProject, auto_recovery: { disabled_patterns: ['ok', 42] } }),
  );
  await assert.rejects(
    () => loadProjectVars(invalidProject),
    /auto_recovery\.disabled_patterns must be a string\[\]/,
  );
});

test('loadProjectVars rejects unknown auto_recovery categories', async (t) => {
  const project = `auto-recovery-category-${process.pid}`;
  const projectDir = path.join(farmslotRoot, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  t.after(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({ name: project, auto_recovery: { allowedCategories: ['flaky'] } }),
  );
  await assert.rejects(
    () => loadProjectVars(project),
    /auto_recovery\.allowedCategories contains an unknown failure category/,
  );
});

test('loadProjectVars validates publication_review snake_case config', async (t) => {
  const project = `publication-review-config-${process.pid}`;
  const projectDir = path.join(farmslotRoot, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  t.after(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      publication_review: {
        dev: { minimum_independent_reviews: 0, require_cross_runner: false },
        'fix-bug': { minimum_independent_reviews: 1 },
      },
    }),
  );
  await assert.doesNotReject(() => loadProjectVars(project));

  const invalidProject = `${project}-invalid`;
  const invalidDir = path.join(farmslotRoot, 'projects', invalidProject);
  await mkdir(invalidDir, { recursive: true });
  t.after(async () => {
    await rm(invalidDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(invalidDir, 'project.json'),
    JSON.stringify({
      name: invalidProject,
      publication_review: { dev: { minimum_independent_reviews: -1 } },
    }),
  );
  await assert.rejects(
    () => loadProjectVars(invalidProject),
    /publication_review\.dev\.minimum_independent_reviews must be a non-negative integer/,
  );
});
