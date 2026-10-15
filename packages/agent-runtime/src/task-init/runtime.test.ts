import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildBranchUpdateGuardCommand,
  buildBranchUpdateInstructions,
  buildHandoffMetadata,
  buildTaskDocument,
  builtinTerminalContract,
  defaultMarkCommand,
  ensureTaskRuntime,
} from './index.js';

test('interactive task documents teach the shared operator wait and resume commands', () => {
  const input = {
    flowType: 'dev',
    modePreamble: '',
    vars: { TASK_DIR: '.task/operator', MODE: 'interactive' },
    description: 'Review the approach before continuing',
    acceptanceCriteria: [],
    hasTicketData: false,
  };
  const interactive = buildTaskDocument(input);
  assert.match(interactive, /\.task\/operator\/mark wait --who .* --reason/);
  assert.match(interactive, /\.task\/operator\/mark resume/);
  assert.match(interactive, /Resuming grants no approval or completion/);
  assert.doesNotMatch(
    buildTaskDocument({ ...input, vars: { ...input.vars, MODE: 'autonomous' } }),
    /## Waiting for an operator/,
  );
});

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
  assert.match(document, /Prefix every task proof invocation.*RECIPE_TASK_DIR=.*cd.*\.task\/proof/);
  assert.match(document, /proves/);
  assert.match(
    document,
    /--contract "\.task\/proof\/inputs\/worker-terminal-contract\.json" --terminal complete/,
  );
  assert.match(document, /fresh directory under.*artifacts\/recipe-runs/);
  assert.match(document, /run gate.*authorized person.*untestable override.*reason/);
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

test('branch maintenance consumes the supplied publication base separately from freshness', () => {
  for (const flowType of ['pr-complete', 'update-branch', 'ci-fix']) {
    const document = buildTaskDocument({
      flowType,
      modePreamble: '',
      vars: {
        TASK_DIR: '.task/stack',
        BRANCH: 'feat/child',
        PUBLICATION_BASE: 'feat/upstream',
        DEFAULT_BRANCH: 'trunk',
      },
      description: 'Maintain child work',
      acceptanceCriteria: [],
      hasTicketData: true,
    });
    assert.match(document, /PUBLICATION_BASE: feat\/upstream/);
    assert.match(document, /Branch updates target `origin\/feat\/upstream`/);
    assert.match(document, /default-branch freshness checks separate/);
    assert.ok(document.includes(buildBranchUpdateInstructions('feat/upstream')));
    assert.doesNotMatch(document, /rebase onto `origin\/trunk`/);
  }
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

test('maintenance commands reuse one captured operation and refuse missing stack ownership', () => {
  const vars = {
    PUBLICATION_BASE: 'parent',
    DEFAULT_BRANCH: 'main',
    REPO: '/product',
    BRANCH: 'child',
    BRANCH_UPDATE_SCRIPT: '/supplying/runtime/branch-update.mjs',
    BRANCH_UPDATE_CONTEXT: JSON.stringify({ id: 'retained-operation', kind: 'rebase' }),
  };
  assert.equal(
    buildBranchUpdateGuardCommand(vars),
    `node '/supplying/runtime/branch-update.mjs' execute '${vars.BRANCH_UPDATE_CONTEXT}'`,
  );
  assert.equal(
    buildBranchUpdateGuardCommand(vars, 'push'),
    `node '/supplying/runtime/branch-update.mjs' push '${vars.BRANCH_UPDATE_CONTEXT}'`,
  );
  assert.match(
    buildBranchUpdateGuardCommand({ ...vars, BRANCH_UPDATE_CONTEXT: '' }),
    /PARENT_BOUNDARY_MISSING/,
  );
  const ordinary = buildBranchUpdateGuardCommand({
    ...vars,
    BRANCH_UPDATE_CONTEXT: '',
    PUBLICATION_BASE: 'main',
  });
  assert.match(ordinary, /execute.*ordinary/);
  assert.ok(ordinary.includes('"baseRef":"main"'));
});

// The task document supplies the same policy regardless of pack or selected review depth.
test('all worker review paths receive the shared scope rule exactly once', () => {
  for (const flowType of ['dev', 'fix-bug', 'self-review', 'review', 'review-pr']) {
    const document = buildTaskDocument({
      flowType,
      modePreamble: '',
      vars: { TASK_DIR: '.task/review' },
      description: 'Review the ticket',
      acceptanceCriteria: ['The requested behavior works'],
      hasTicketData: true,
    });
    assert.equal(document.split('\n## Diff scope\n').length - 1, 1);
    assert.ok(document.includes('Each file must serve an AC or a required test'));
    assert.ok(document.includes('Any scope BLOCKER requires REQUEST_CHANGES, never APPROVE'));
  }
});
