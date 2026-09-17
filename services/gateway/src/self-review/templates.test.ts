import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { invalidateProjectVarsCache } from '@farmslot/slot-config';

import { farmslotRoot } from '../fleet/state.js';
import { createRun, deleteRun, updateRun } from '../runs/store.js';

import { expandSelfReviewTemplate } from './templates.js';

test('configured review depth selects canonical bytes and records provenance without a runtime-to-static fallback', async (t) => {
  const project = `.canonical-review-${process.pid}`;
  const root = path.join(farmslotRoot, 'projects', project);
  await mkdir(path.join(root, 'shared/self-review'), { recursive: true });
  const contents = Object.fromEntries(
    ['static-code', 'full-live'].map((depth) => [
      depth,
      `---\nplatforms: [cli]\nlabels: [review-depth:${depth}]\n---\n\n# ${depth}\n\n- [ ] Follow the shared ${depth} review.\n`,
    ]),
  );
  for (const [depth, content] of Object.entries(contents))
    await writeFile(path.join(root, 'shared/self-review', `${depth}.md`), content);
  const config = {
    name: project,
    execution_templates: {
      sources: [{ id: 'workspace:canonical', kind: 'workspace', root: { projectPath: 'shared' } }],
    },
    self_review: {
      execution_templates: {
        'static-code': 'self-review/static-code',
        'full-live': 'self-review/full-live',
      },
    },
  };
  const save = async () => {
    await writeFile(path.join(root, 'project.json'), JSON.stringify(config));
    invalidateProjectVarsCache(project);
  };
  await save();
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project,
    ticketOrPr: 'TEST-REVIEW-TEMPLATE',
  });
  const taskRoot = path.join(root, 'task');
  await mkdir(taskRoot);
  await writeFile(path.join(taskRoot, 'TASK.md'), '# Fixture task\n');
  updateRun(run.id, { taskFile: path.join(taskRoot, 'TASK.md') });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
    await rm(root, { recursive: true, force: true });
    invalidateProjectVarsCache(project);
  });
  const vars = {
    slotId: 'fixture',
    projectName: project,
    host: 'localhost',
    machine: 'fixture',
    remoteRepo: '/tmp/fixture',
    platform: 'cli',
    session: 'fixture',
    resourceVars: {},
  } as never;
  for (const depth of ['static-code', 'full-live'] as const) {
    const rendered = await expandSelfReviewTemplate(vars, 'temp/tasks/review', run.id, depth);
    assert(rendered.startsWith(contents[depth]));
    assert(rendered.includes(createHash('sha256').update(contents[depth]).digest('hex')));
    assert(rendered.includes('workspace:canonical'));
    assert(rendered.includes('SELF-REVIEW-SIGNAL.json'));
    const bindings = JSON.parse(rendered.split('```json\n')[1].split('\n```')[0]);
    const saved = JSON.parse(
      await readFile(path.join(taskRoot, bindings.retainedProvenanceArtifact), 'utf8'),
    );
    assert.deepEqual(saved.executionTemplate, bindings.executionTemplate);
    assert.equal(
      await expandSelfReviewTemplate(vars, 'temp/tasks/review', run.id, depth),
      rendered,
    );
  }
  config.self_review.execution_templates['full-live'] = 'self-review/static-code';
  await save();
  await assert.rejects(
    expandSelfReviewTemplate(vars, 'temp/tasks/review', run.id, 'full-live'),
    /must declare review-depth:full-live/,
  );
});

test('expandSelfReviewTemplate resolves farmslot_dir placeholders', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: 'TEST-FARMSLOT-DIR',
    runner: 'claude',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  const rendered = await expandSelfReviewTemplate(
    {
      slotId: 'slot-1',
      projectName: 'farmslot-farm',
      host: 'localhost',
      machine: 'test-machine',
      remoteRepo: '/tmp/farmslot',
      platform: 'ios',
      session: 'slot-1',
      resourceVars: { port: '8061', cdpPort: '9222' },
    } as never,
    'temp/tasks/test/self-review',
    run.id,
    'full-live',
  );

  assert.equal(rendered.includes('{{farmslot_dir}}'), false);
  assert.equal(rendered.includes('{{FARMSLOT_DIR}}'), false);
  assert.match(
    rendered,
    new RegExp(
      `${farmslotRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/scripts/quality/check-task-artifact-contract\\.mjs`,
    ),
  );

  const remoteRendered = await expandSelfReviewTemplate(
    {
      slotId: 'slot-remote',
      projectName: 'farmslot-farm',
      host: 'remote-node.local',
      machine: 'remote-node',
      remoteRepo: '/tmp/farmslot',
      platform: 'ios',
      session: 'slot-remote',
      resourceVars: { port: '8061', cdpPort: '9222' },
    } as never,
    'temp/tasks/test/self-review',
    run.id,
    'full-live',
  );

  assert.match(
    remoteRendered,
    /~\/farmslot-node\/scripts\/quality\/check-task-artifact-contract\.mjs/,
  );
});
