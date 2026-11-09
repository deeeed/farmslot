import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { WorkerTerminalContractDocument } from '@farmslot/protocol';

import { taskInit, type TaskInitSpec } from './index.js';

async function spec(t: TestContext): Promise<TaskInitSpec> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hosted-task-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const templates = path.join(root, 'templates');
  await mkdir(path.join(templates, 'dev'), { recursive: true });
  await writeFile(
    path.join(templates, 'dev', 'default.md'),
    '---\nid: hosted-dev\nflow: dev\n---\n# Worker\n- [ ] Prove behavior\n- [ ] git push origin main\n',
  );
  return {
    taskDir: path.join(root, 'task'),
    flow: 'dev',
    platform: 'core',
    template: {
      sources: [{ id: 'fixture', kind: 'project', root: templates, layout: 'flow-tree' }],
      explicitId: 'hosted-dev',
    },
    task: {
      title: 'Hosted proof',
      sourceKind: 'text',
      acceptanceCriteria: ['Keep the authored identity'],
    },
    handoff: { surface: 'farmslot', project: 'fixture', attemptId: 'retained-run' },
  };
}

test('replay policy covers appended context before recording the rendered digest', async (t) => {
  const input = await spec(t);
  const result = await taskInit({
    ...input,
    taskDocumentAdditions: 'Run gh pr create after validation.',
    artifactOnlyReplay: { base: 'frozen-base' },
  });
  const checklist = await readFile(result.checklist!, 'utf8');
  const document = await readFile(result.taskDocument, 'utf8');
  assert.doesNotMatch(checklist, /- \[ \] git push/);
  assert.doesNotMatch(document, /Run gh pr create/);
  assert.match(document, /frozen-base/);
  assert.equal(
    result.executionTemplate.renderedSha256,
    createHash('sha256').update(checklist).digest('hex'),
  );
});

test('authored task keeps its documents, normalized criteria and original handoff', async (t) => {
  const input = await spec(t);
  const original = await taskInit(input);
  const taskMarkdown = '# Authored task\nKeep this prose.\n';
  const checklistMarkdown = '# Authored checklist\n- [x] Prior step\n- [ ] Final step\n';
  const imported = await taskInit({
    ...input,
    taskDir: path.join(input.taskDir, '..', 'authored'),
    authored: { taskMarkdown, checklistMarkdown, handoff: original.handoffMetadata },
  });
  assert.equal(await readFile(imported.taskDocument, 'utf8'), taskMarkdown);
  assert.equal(await readFile(imported.checklist!, 'utf8'), checklistMarkdown);
  assert.deepEqual(imported.handoffMetadata, original.handoffMetadata);
});

test('operator plan remains CHECKLIST while selected template remains TASK', async (t) => {
  const input = await spec(t);
  const operatorPlan = '# Operator plan\n- [ ] Present the approach\n';
  const result = await taskInit({
    ...input,
    operatorPlan,
    taskDocumentAdditions: 'Control-plane context',
  });
  assert.equal(await readFile(result.checklist!, 'utf8'), operatorPlan);
  assert.match(await readFile(result.taskDocument, 'utf8'), /# Worker/);
  assert.match(await readFile(result.taskDocument, 'utf8'), /Control-plane context/);
});

test('the frozen required skill set lands in the handoff and TASK.md, never the checklist', async (t) => {
  const input = await spec(t);
  const requiredSkills = {
    schemaVersion: 1 as const,
    selection: { flow: 'dev', platform: 'core', domain: '' },
    rules: ['testing'],
    skills: [
      {
        name: 'mms-mobile-testing',
        rules: ['testing'],
        files: [{ path: '.agents/skills/mms-mobile-testing/SKILL.md', sha256: 'a'.repeat(64) }],
      },
    ],
  };
  const result = await taskInit({ ...input, requiredSkills });
  const handoff: unknown = JSON.parse(await readFile(result.handoff, 'utf8'));
  assert.deepEqual((handoff as { requiredSkills?: unknown }).requiredSkills, requiredSkills);
  assert.match(
    await readFile(result.taskDocument, 'utf8'),
    /## Required skills\n\n.*\n\n- `mms-mobile-testing` \(rule `testing`\): `\.agents\/skills\/mms-mobile-testing\/SKILL\.md`/,
  );
  assert.doesNotMatch(await readFile(result.checklist!, 'utf8'), /Required skills/);
});

test('an authored task without a frozen set receives the node-selected one; a frozen one is kept', async (t) => {
  const input = await spec(t);
  const original = await taskInit(input);
  const requiredSkills = {
    schemaVersion: 1 as const,
    selection: { flow: 'dev', platform: 'core', domain: '' },
    rules: ['testing'],
    skills: [
      {
        name: 'mms-mobile-testing',
        rules: ['testing'],
        files: [{ path: '.agents/skills/mms-mobile-testing/SKILL.md', sha256: 'b'.repeat(64) }],
      },
    ],
  };
  const taskMarkdown = '# Authored task\nKeep this prose.\n';
  const imported = await taskInit({
    ...input,
    taskDir: path.join(input.taskDir, '..', 'authored'),
    authored: {
      taskMarkdown,
      checklistMarkdown: '- [ ] Step\n',
      handoff: original.handoffMetadata,
    },
    requiredSkills,
  });
  assert.deepEqual(imported.handoffMetadata.requiredSkills, requiredSkills);
  const document = await readFile(imported.taskDocument, 'utf8');
  assert.ok(document.startsWith(taskMarkdown));
  assert.match(document, /## Required skills[\s\S]*mms-mobile-testing/);

  const reimported = await taskInit({
    ...input,
    taskDir: path.join(input.taskDir, '..', 'reimported'),
    authored: {
      taskMarkdown: document,
      checklistMarkdown: '- [ ] Step\n',
      handoff: imported.handoffMetadata,
    },
    requiredSkills: { ...requiredSkills, rules: [], skills: [] },
  });
  assert.deepEqual(reimported.handoffMetadata.requiredSkills, requiredSkills);
  assert.equal(await readFile(reimported.taskDocument, 'utf8'), document);
});

test('a scripted-command task gets no worker checklist and freezes no checklist gates', async (t) => {
  const input = await spec(t);
  await writeFile(
    path.join(input.template.sources[0]!.root, 'dev', 'default.md'),
    '---\nid: hosted-dev\nflow: dev\n---\n# Worker\n- [ ] 1. Changed-file CI [DETERMINISTIC: ci.local_check]. Call `<task>/mark 1`.\n',
  );
  const { resolveWorkerTerminalContract } = createRequire(import.meta.url)(
    '../../scripts/worker-terminal-contract.cjs',
  ) as {
    resolveWorkerTerminalContract: (
      config: unknown,
      flow: string,
      options: { scriptedCommand?: true },
    ) => WorkerTerminalContractDocument;
  };
  const result = await taskInit({
    ...input,
    vars: { 'ci.local_check': 'bash temp/farmslot/ci-parity' },
    terminalContract: resolveWorkerTerminalContract({ acceptance: { require: true } }, 'dev', {
      scriptedCommand: true,
    }),
  });
  assert.equal(result.checklist, null, 'no CHECKLIST.md for a run without a worker');
  await assert.rejects(readFile(path.join(input.taskDir, 'CHECKLIST.md'), 'utf8'), /ENOENT/);
  const contract = JSON.parse(await readFile(result.terminalContract, 'utf8'));
  assert.equal(contract.deterministicChecks, undefined, 'no ci.local_check receipt is required');
  assert.deepEqual(contract.scriptedCommand, { result: 'artifacts/scripted-command-result.json' });
  assert.match(await readFile(result.taskDocument, 'utf8'), /Hosted proof/);
});

test('an interactive operator plan is a worker checklist too: a scripted-command task takes none', async (t) => {
  const input = await spec(t);
  const { resolveWorkerTerminalContract } = createRequire(import.meta.url)(
    '../../scripts/worker-terminal-contract.cjs',
  ) as {
    resolveWorkerTerminalContract: (
      config: unknown,
      flow: string,
      options: { scriptedCommand?: true },
    ) => WorkerTerminalContractDocument;
  };
  const result = await taskInit({
    ...input,
    vars: { 'ci.local_check': 'bash temp/farmslot/ci-parity' },
    operatorPlan:
      '# Plan\n- [ ] 1. Changed-file CI [DETERMINISTIC: ci.local_check]. Call `<task>/mark 1`.\n',
    terminalContract: resolveWorkerTerminalContract(null, 'dev', { scriptedCommand: true }),
  });
  assert.equal(result.checklist, null);
  const contract = JSON.parse(await readFile(result.terminalContract, 'utf8'));
  assert.equal(contract.deterministicChecks, undefined, 'no gate frozen from the operator plan');
  assert.doesNotMatch(await readFile(result.taskDocument, 'utf8'), /DETERMINISTIC/);
});
