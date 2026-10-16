import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildHandoffMetadata,
  builtinTerminalContract,
  quoteMarkCommandWord,
  writeTaskDir,
} from '@farmslot/agent-runtime';

import type { SlotVars } from '../core/config.js';

import {
  CHECKLIST_TARGET_BY_AGENT_ROLE,
  checklistTargetForAgentRole,
  CI_FIX_CHECKLIST_TARGET,
  DEFAULT_CHECKLIST_TARGET_REGISTRY,
  restoreWorkerChecklistTargetOnSlot,
  REVIEW_CHECKLIST_TARGET,
  REVIEW_FIX_CHECKLIST_TARGET,
  syncChecklistTargetOnSlot,
  targetForChecklistBasename,
  taskDirRelPath,
} from './checklist-target.js';

async function fixture(t: test.TestContext, fixed: boolean) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'task-marker-role-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  const taskDir = '.task/retained task';
  const absolute = path.join(repo, taskDir);
  const vars: SlotVars = {
    slotId: 'marker-fixture',
    machine: 'marker-fixture',
    host: 'localhost',
    platform: 'cli',
    sshUser: '',
    osType: process.platform,
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo,
    remoteRepo: repo,
    session: 'marker-fixture',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    // A role change must not load a newer project to reselect tooling.
    projectName: 'not-installed-marker-fixture',
    resourceVars: {},
  };
  const checklist = '- [ ] Run CI [DETERMINISTIC: ci.local_check]\n';
  const terminalContract = builtinTerminalContract('dev');
  const helper = fileURLToPath(
    new URL('../../../../packages/agent-runtime/scripts/mark-checklist-step.cjs', import.meta.url),
  );
  await writeTaskDir({
    taskDir: absolute,
    taskMarkdown: '# Retained task\n',
    checklistMarkdown: checklist,
    fixedMarkCommand: fixed,
    markCommand: `${quoteMarkCommandWord(process.execPath)} ${quoteMarkCommandWord(helper)}`,
    handoff: buildHandoffMetadata({
      attemptId: 'marker-fixture',
      surface: 'farmslot',
      project: vars.projectName,
      flow: 'dev',
      title: 'Retain the task marker',
      sourceKind: 'text',
      terminalContract,
    }),
    terminalContract,
    deterministicCommands: {
      'ci.local_check': `${quoteMarkCommandWord(process.execPath)} -e 'process.exit(17)'`,
    },
  });
  for (const name of ['REVIEW.md', 'REVIEW-FIX.md', 'CI-FIX.md'])
    await writeFile(path.join(absolute, name), checklist);
  return { repo, taskDir, absolute, vars, checklist };
}

for (const fixed of [true, false]) {
  test(`${fixed ? 'frozen' : 'legacy'} task marker survives review and worker role changes`, async (t) => {
    const { taskDir, absolute, vars } = await fixture(t, fixed);
    const before = await readFile(path.join(absolute, 'mark'));
    const handoff = await readFile(path.join(absolute, 'inputs/handoff.json'));
    for (const checklist of ['REVIEW.md', 'REVIEW-FIX.md', 'CI-FIX.md']) {
      await syncChecklistTargetOnSlot(vars, taskDir, checklist);
      assert.deepEqual(await readFile(path.join(absolute, 'mark')), before);
      assert.deepEqual(
        JSON.parse(await readFile(path.join(absolute, 'checklist-target.json'), 'utf8')),
        {
          checklist,
          signal: checklist.replace('.md', '-SIGNAL.json'),
        },
      );
    }
    await restoreWorkerChecklistTargetOnSlot(vars, taskDir, true);
    await assert.rejects(access(path.join(absolute, 'checklist-target.json')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(path.join(absolute, 'mark')), before);
    assert.deepEqual(await readFile(path.join(absolute, 'inputs/handoff.json')), handoff);
    // The task's original CI gate still refuses progress, including an attempted
    // environment override of a frozen marker.
    const env = { ...process.env };
    delete env.FARMSLOT_MARK_CMD;
    if (fixed) env.FARMSLOT_MARK_CMD = 'true';
    const result = spawnSync('bash', [path.join(absolute, 'mark'), '1'], {
      cwd: vars.remoteRepo,
      env,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(await readFile(path.join(absolute, 'CHECKLIST.md'), 'utf8'), /\[ \]/);
    const receipt = JSON.parse(
      await readFile(
        path.join(absolute, 'artifacts/deterministic-checks/CHECKLIST.md/1.json'),
        'utf8',
      ),
    );
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.exitCode, 17);
  });
}

test('custom checklist restoration preserves the existing marker too', async (t) => {
  const { taskDir, absolute, vars } = await fixture(t, true);
  const before = await readFile(path.join(absolute, 'mark'));
  const registry = { ...DEFAULT_CHECKLIST_TARGET_REGISTRY, interactiveChecklist: 'CUSTOM.md' };
  await restoreWorkerChecklistTargetOnSlot(vars, taskDir, true, registry);
  assert.deepEqual(await readFile(path.join(absolute, 'mark')), before);
  assert.equal(
    JSON.parse(await readFile(path.join(absolute, 'checklist-target.json'), 'utf8')).checklist,
    'CUSTOM.md',
  );
});

test('targetForChecklistBasename maps role checklists to sibling signal files', () => {
  assert.deepEqual(targetForChecklistBasename('REVIEW.md'), REVIEW_CHECKLIST_TARGET);
  assert.deepEqual(targetForChecklistBasename('CI-FIX.md'), CI_FIX_CHECKLIST_TARGET);
  assert.deepEqual(targetForChecklistBasename('TASK.md'), {
    checklist: 'TASK.md',
    signal: 'SIGNAL.json',
  });
});

test('CHECKLIST_TARGET_BY_AGENT_ROLE exposes nested-loop role targets', () => {
  assert.deepEqual(CHECKLIST_TARGET_BY_AGENT_ROLE['review'], REVIEW_CHECKLIST_TARGET);
  assert.deepEqual(CHECKLIST_TARGET_BY_AGENT_ROLE['review-fix'], REVIEW_FIX_CHECKLIST_TARGET);
  assert.deepEqual(CHECKLIST_TARGET_BY_AGENT_ROLE['ci-fix'], CI_FIX_CHECKLIST_TARGET);
  assert.deepEqual(
    checklistTargetForAgentRole('ci-fix'),
    DEFAULT_CHECKLIST_TARGET_REGISTRY.roles['ci-fix'],
  );
});

test('taskDirRelPath joins task dir and basename without double slashes', () => {
  assert.equal(taskDirRelPath('tasks/foo', 'SIGNAL.json'), 'tasks/foo/SIGNAL.json');
  assert.equal(taskDirRelPath('tasks/foo/', 'CI-FIX.md'), 'tasks/foo/CI-FIX.md');
});
