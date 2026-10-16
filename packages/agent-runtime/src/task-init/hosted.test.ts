import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

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
