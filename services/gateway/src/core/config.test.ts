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
  validatePrepareConfig,
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

const PREPARE_CONFIG_PATH = 'projects/test/project.json';

function prepareJson(prepare: unknown) {
  return { name: 'test', prepare } as Parameters<typeof validatePrepareConfig>[0];
}

test('validatePrepareConfig accepts a full profile set with fallback chain', () => {
  assert.doesNotThrow(() =>
    validatePrepareConfig(
      prepareJson({
        default: 'full',
        profiles: {
          full: { phases: ['git', 'fixtures', 'deps', 'preflight', 'health'] },
          relaunch: {
            label: 'Switch branch + relaunch app',
            phases: ['git', 'fixtures', 'preflight', 'health'],
            hooks: { preflight: 'bash relaunch.sh {{slot_id}}' },
            requires: ['deps_current', 'dev_server_up'],
            fallback: 'full',
          },
          attach: { phases: ['health'], requires: ['health_ok'], fallback: 'relaunch' },
        },
      }),
      PREPARE_CONFIG_PATH,
    ),
  );
});

test('validatePrepareConfig is a no-op without a prepare block', () => {
  assert.doesNotThrow(() => validatePrepareConfig({ name: 'test' }, PREPARE_CONFIG_PATH));
});

test('validatePrepareConfig rejects structural errors', () => {
  assert.throws(
    () => validatePrepareConfig(prepareJson([]), PREPARE_CONFIG_PATH),
    /prepare must be an object/,
  );
  assert.throws(
    () => validatePrepareConfig(prepareJson({}), PREPARE_CONFIG_PATH),
    /prepare\.profiles must be an object/,
  );
  assert.throws(
    () => validatePrepareConfig(prepareJson({ profiles: {} }), PREPARE_CONFIG_PATH),
    /must define at least one profile/,
  );
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ profiles: { Bad_Name: { phases: ['git'] } } }),
        PREPARE_CONFIG_PATH,
      ),
    /key "Bad_Name" is invalid/,
  );
});

test('validatePrepareConfig rejects bad phases', () => {
  assert.throws(
    () =>
      validatePrepareConfig(prepareJson({ profiles: { full: { phases: [] } } }), PREPARE_CONFIG_PATH),
    /phases must be a non-empty array/,
  );
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ profiles: { full: { phases: ['git', 'compile'] } } }),
        PREPARE_CONFIG_PATH,
      ),
    /unknown phase "compile"/,
  );
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ profiles: { full: { phases: ['git', 'git'] } } }),
        PREPARE_CONFIG_PATH,
      ),
    /phases contains duplicates/,
  );
});

test('validatePrepareConfig rejects bad requires and missing fallback', () => {
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ profiles: { full: { phases: ['git'], requires: ['cdp_up'] } } }),
        PREPARE_CONFIG_PATH,
      ),
    /unknown check "cdp_up"/,
  );
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ profiles: { full: { phases: ['git'], requires: ['health_ok'] } } }),
        PREPARE_CONFIG_PATH,
      ),
    /declares requires but no fallback profile/,
  );
});

test('validatePrepareConfig rejects bad fallback references and cycles', () => {
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ profiles: { full: { phases: ['git'], fallback: 'missing' } } }),
        PREPARE_CONFIG_PATH,
      ),
    /fallback must name an existing profile/,
  );
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ profiles: { full: { phases: ['git'], fallback: 'full' } } }),
        PREPARE_CONFIG_PATH,
      ),
    /fallback must not be itself/,
  );
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({
          profiles: {
            a: { phases: ['git'], requires: ['health_ok'], fallback: 'b' },
            b: { phases: ['git'], requires: ['health_ok'], fallback: 'a' },
          },
        }),
        PREPARE_CONFIG_PATH,
      ),
    /fallback chain from "a" contains a cycle/,
  );
});

test('validatePrepareConfig rejects unknown default profile', () => {
  assert.throws(
    () =>
      validatePrepareConfig(
        prepareJson({ default: 'fast', profiles: { full: { phases: ['git'] } } }),
        PREPARE_CONFIG_PATH,
      ),
    /prepare\.default must name an existing profile/,
  );
});

test('loadProjectVars validates the prepare block', async (t) => {
  const project = `prepare-config-${process.pid}`;
  const projectDir = path.join(farmslotRoot, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  t.after(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      prepare: { profiles: { full: { phases: ['git', 'health'], requires: ['health_ok'] } } },
    }),
  );
  await assert.rejects(() => loadProjectVars(project), /declares requires but no fallback profile/);
});
