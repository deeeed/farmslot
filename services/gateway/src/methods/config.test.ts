import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { farmslotRoot } from '../core/config.js';

import {
  configProject,
  configProjectAutoRecoveryUpdate,
  configProjectBacklogUpdate,
} from './config.js';

async function makeProject(
  t: { after: (fn: () => unknown) => void },
  name: string,
): Promise<string> {
  const projectDir = path.join(farmslotRoot, 'projects', name);
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({ name, default_branch: 'main' }, null, 2) + '\n',
    'utf8',
  );
  t.after(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });
  return projectDir;
}

test('configProjectAutoRecoveryUpdate writes typed auto_recovery config with backup', async (t) => {
  const project = `config-auto-recovery-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const projectDir = await makeProject(t, project);

  const result = await configProjectAutoRecoveryUpdate({
    project,
    autoRecovery: {
      enabled: true,
      maxAttempts: 2,
      allowedSteps: ['prepare', 'monitor'],
      allowedCategories: ['infra', 'timeout'],
      disabledPatterns: ['flaky-test'],
      llm: { enabled: false, dailyUsdCap: 0, timeoutMs: 1500 },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.project.autoRecovery?.enabled, true);
  assert.equal(result.project.autoRecovery?.disabledPatterns?.[0], 'flaky-test');
  assert.match(result.backup, /project\.json\.bak\./);
  const raw = JSON.parse(await readFile(path.join(projectDir, 'project.json'), 'utf8'));
  assert.deepEqual(raw.auto_recovery.disabled_patterns, ['flaky-test']);
  assert.equal(raw.auto_recovery.llm.timeoutMs, 1500);
});

test('configProjectAutoRecoveryUpdate rejects malformed typed arrays before writing', async (t) => {
  const project = `config-auto-recovery-invalid-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const projectDir = await makeProject(t, project);
  const before = await readFile(path.join(projectDir, 'project.json'), 'utf8');

  await assert.rejects(
    () =>
      configProjectAutoRecoveryUpdate({
        project,
        autoRecovery: { enabled: true, allowedSteps: ['prepare', 42 as unknown as string] },
      }),
    /auto_recovery\.allowedSteps must be a string\[\]/,
  );

  assert.equal(await readFile(path.join(projectDir, 'project.json'), 'utf8'), before);
});

test('configProjectAutoRecoveryUpdate rejects non-finite LLM daily caps before writing', async (t) => {
  const project = `config-auto-recovery-nan-cap-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const projectDir = await makeProject(t, project);
  const before = await readFile(path.join(projectDir, 'project.json'), 'utf8');

  await assert.rejects(
    () =>
      configProjectAutoRecoveryUpdate({
        project,
        autoRecovery: { llm: { enabled: true, dailyUsdCap: Number.NaN } },
      }),
    /auto_recovery\.llm\.dailyUsdCap must be a finite non-negative number/,
  );

  await assert.rejects(
    () =>
      configProjectAutoRecoveryUpdate({
        project,
        autoRecovery: { llm: { enabled: true, dailyUsdCap: Number.POSITIVE_INFINITY } },
      }),
    /auto_recovery\.llm\.dailyUsdCap must be a finite non-negative number/,
  );

  assert.equal(await readFile(path.join(projectDir, 'project.json'), 'utf8'), before);
});

test('configProjectAutoRecoveryUpdate rejects unknown failure categories before writing', async (t) => {
  const project = `config-auto-recovery-category-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const projectDir = await makeProject(t, project);
  const before = await readFile(path.join(projectDir, 'project.json'), 'utf8');

  await assert.rejects(
    () =>
      configProjectAutoRecoveryUpdate({
        project,
        autoRecovery: {
          enabled: true,
          allowedCategories: ['flaky' as unknown as import('@farmslot/protocol').FailureCategory],
        },
      }),
    /auto_recovery\.allowedCategories contains an unknown failure category/,
  );

  assert.equal(await readFile(path.join(projectDir, 'project.json'), 'utf8'), before);
});

test('configProjectAutoRecoveryUpdate merges partial updates into existing auto_recovery config', async (t) => {
  const project = `config-auto-recovery-merge-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const projectDir = await makeProject(t, project);
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify(
      {
        name: project,
        default_branch: 'main',
        auto_recovery: {
          enabled: true,
          maxAttempts: 3,
          allowedSteps: ['prepare'],
          allowedCategories: ['infra'],
          disabled_patterns: ['devserver-crashed'],
          llm: { enabled: true, dailyUsdCap: 1, timeoutMs: 2000 },
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  await configProjectAutoRecoveryUpdate({
    project,
    autoRecovery: { enabled: false },
  });

  const raw = JSON.parse(await readFile(path.join(projectDir, 'project.json'), 'utf8'));
  assert.equal(raw.auto_recovery.enabled, false);
  assert.equal(raw.auto_recovery.maxAttempts, 3);
  assert.deepEqual(raw.auto_recovery.allowedSteps, ['prepare']);
  assert.deepEqual(raw.auto_recovery.disabled_patterns, ['devserver-crashed']);
  assert.deepEqual(raw.auto_recovery.llm, { enabled: true, dailyUsdCap: 1, timeoutMs: 2000 });
});

test('configProjectBacklogUpdate writes typed backlog policy with backup', async (t) => {
  const project = `config-backlog-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const projectDir = await makeProject(t, project);

  const result = await configProjectBacklogUpdate({
    project,
    backlog: { autoDispatch: { enabled: true } },
  });

  assert.equal(result.ok, true);
  assert.equal(result.project.backlog?.autoDispatch?.enabled, true);
  assert.match(result.backup, /project\.json\.bak\./);
  const raw = JSON.parse(await readFile(path.join(projectDir, 'project.json'), 'utf8'));
  assert.equal(raw.backlog.auto_dispatch.enabled, true);
});

test('configProject returns project learnings document when present', async (t) => {
  const project = `config-learnings-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const projectDir = await makeProject(t, project);
  await mkdir(path.join(projectDir, 'learnings'), { recursive: true });
  await writeFile(
    path.join(projectDir, 'learnings', 'LEARNINGS.md'),
    '# Lessons\n\n- Keep loop visible.\n',
    'utf8',
  );

  const result = await configProject({ project });

  assert.equal(result.project.name, project);
  assert.equal(result.learnings.exists, true);
  assert.equal(result.learnings.relativePath, `projects/${project}/learnings/LEARNINGS.md`);
  assert.match(result.learnings.content, /Keep loop visible/);
  assert.equal(typeof result.learnings.updatedAt, 'string');
  assert.equal(
    result.learnings.sizeBytes,
    Buffer.byteLength('# Lessons\n\n- Keep loop visible.\n'),
  );
});

test('configProject returns empty learnings document when absent', async (t) => {
  const project = `config-learnings-missing-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  await makeProject(t, project);

  const result = await configProject({ project });

  assert.equal(result.learnings.exists, false);
  assert.equal(result.learnings.content, '');
  assert.equal(result.learnings.updatedAt, null);
  assert.equal(result.learnings.sizeBytes, null);
});
