import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildHandoffMetadata,
  buildTaskDocument,
  builtinTerminalContract,
  defaultMarkCommand,
  ensureTaskRuntime,
} from './index.js';

test('task instructions consume supplied helper commands and leave verdicts to recipe execution', () => {
  const input = {
    flowType: 'dev',
    modePreamble: '',
    vars: {
      TASK_DIR: '.task/proof',
      farmslot_dir: '/wrong/deployment',
      AC_CMD: 'node /connected/runtime/acceptance-cli.cjs',
      ARTIFACT_CHECK_CMD: 'node /connected/runtime/check-task-artifact-contract.mjs',
    },
    description: 'Prove the task',
    acceptanceCriteria: ['The task behavior passes'],
    hasTicketData: true,
  };
  const document = buildTaskDocument(input);
  assert.match(
    document,
    /node \/connected\/runtime\/acceptance-cli\.cjs list --task-dir "\.task\/proof"/,
  );
  assert.match(
    document,
    /node \/connected\/runtime\/check-task-artifact-contract\.mjs "\.task\/proof"/,
  );
  assert.match(document, /proofTargets/);
  assert.match(document, /proves/);
  assert.match(document, /authorized reviewer.*untestable override.*actor and reason/);
  assert.doesNotMatch(document, /\/wrong\/deployment|ac set .*proven/);
  const standalone = buildTaskDocument({ ...input, vars: { TASK_DIR: '.task/proof' } });
  assert.ok(
    standalone.includes(
      defaultMarkCommand().replace('scripts/mark-checklist-step.cjs', 'bin/farmslot-agent.mjs') +
        ' ac',
    ),
  );
  assert.ok(
    standalone.includes(
      defaultMarkCommand().replace('scripts/mark-checklist-step.cjs', 'bin/farmslot-agent.mjs') +
        ' artifact-check',
    ),
  );
});

test('existing tasks receive the shared runtime without replacing author data', async (t) => {
  const taskDir = await mkdtemp(path.join(tmpdir(), 'existing-task-runtime-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  await writeFile(path.join(taskDir, 'TASK.md'), '# Manual task\n- [ ] Prove behavior\n');
  await writeFile(path.join(taskDir, 'CHECKLIST.md'), '# Author checklist\n- [x] Prior work\n');
  const terminalContract = builtinTerminalContract('dev');
  const handoff = buildHandoffMetadata({
    attemptId: 'fixture',
    surface: 'farmslot',
    project: 'example',
    flow: 'dev',
    title: 'Manual task',
    sourceKind: 'text',
    acceptanceCriteria: [],
    terminalContract,
  });
  await ensureTaskRuntime({
    taskDir,
    markCommand: 'node fixture-marker',
    handoff,
    terminalContract,
    checklistMarkdown: '- [ ] New default\n',
  });
  assert.equal(
    await readFile(path.join(taskDir, 'TASK.md'), 'utf8'),
    '# Manual task\n- [ ] Prove behavior\n',
  );
  assert.equal(
    await readFile(path.join(taskDir, 'CHECKLIST.md'), 'utf8'),
    '# Author checklist\n- [x] Prior work\n',
  );
  assert.ok((await stat(path.join(taskDir, 'mark'))).mode & 0o100);
  assert.match(await readFile(path.join(taskDir, 'mark'), 'utf8'), /node fixture-marker/);
  const saved = await readFile(path.join(taskDir, 'inputs/handoff.json'), 'utf8');
  await ensureTaskRuntime({
    taskDir,
    handoff: { ...handoff, attemptId: 'replacement' },
    terminalContract,
    checklistMarkdown: null,
  });
  assert.equal(await readFile(path.join(taskDir, 'inputs/handoff.json'), 'utf8'), saved);
  await ensureTaskRuntime({
    taskDir,
    handoff,
    terminalContract: { ...terminalContract, resolvedAt: new Date().toISOString() },
    markCommand: 'node updated-marker',
    checklistMarkdown: null,
  });
  assert.match(await readFile(path.join(taskDir, 'mark'), 'utf8'), /node updated-marker/);
  for (const changed of [
    { ...handoff, flow: 'fix-bug' },
    { ...handoff, task: { ...handoff.task, acceptanceCriteria: ['Prove the new gate'] } },
  ]) {
    await assert.rejects(
      ensureTaskRuntime({ taskDir, handoff: changed, terminalContract, checklistMarkdown: null }),
      /Existing task handoff differs/,
    );
  }
  await assert.rejects(
    ensureTaskRuntime({
      taskDir,
      handoff,
      terminalContract: builtinTerminalContract('fix-bug'),
      checklistMarkdown: null,
    }),
    /Existing worker terminal contract differs/,
  );
  assert.equal(await readFile(path.join(taskDir, 'inputs/handoff.json'), 'utf8'), saved);
  assert.equal(
    await readFile(path.join(taskDir, 'CHECKLIST.md'), 'utf8'),
    '# Author checklist\n- [x] Prior work\n',
  );
});
