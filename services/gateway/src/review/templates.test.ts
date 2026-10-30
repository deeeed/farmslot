import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { isRecord, type RequestFrame } from '@farmslot/protocol';
import { invalidateProjectVarsCache } from '@farmslot/slot-config';

import { registerNode, unregisterByWs } from '../fleet/machine-registry.js';
import { handleNodeResponse } from '../fleet/node-rpc.js';
import { farmslotRoot } from '../fleet/state.js';
import { publicationReviewLaunchRejectionFromError } from '../run-engine/review-launch-gate.js';
import { makeRun } from '../run-engine/test-fixtures.js';
import { makeVars } from '../runners/test-fixtures.js';
import { createRun, deleteRun, updateRun } from '../runs/store.js';

import { expandReviewFixTemplate, expandReviewTemplate } from './templates.js';

test('configured review depth selects canonical bytes and records provenance without a runtime-to-static fallback', async (t) => {
  const project = `.canonical-review-${process.pid}`;
  const root = path.join(farmslotRoot, 'projects', project);
  await mkdir(path.join(root, 'shared/review'), { recursive: true });
  const contents = Object.fromEntries(
    ['static-code', 'full-live'].map((depth) => [
      depth,
      `---\nplatforms: [cli]\nlabels: [review-depth:${depth}]\n---\n\n# ${depth}\n\n- [ ] Follow the shared ${depth} review.\n\nChecklist={{REVIEW_CHECKLIST}} signal={{REVIEW_SIGNAL}} feedback={{TASK_DIR}}/{{REVIEW_FEEDBACK}}\n`,
    ]),
  );
  for (const [depth, content] of Object.entries(contents))
    await writeFile(path.join(root, 'shared/review', `${depth}.md`), content);
  const config = {
    name: project,
    execution_templates: {
      sources: [{ id: 'workspace:canonical', kind: 'workspace', root: { projectPath: 'shared' } }],
    },
    review: {
      execution_templates: {
        'static-code': 'review/static-code',
        'full-live': 'review/full-live',
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
    const lane = {
      checklist: 'REVIEW.rev-test.md',
      signal: 'REVIEW.rev-test-SIGNAL.json',
      feedback: 'artifacts/review-feedback.rev-test.md',
    };
    const rendered = await expandReviewTemplate(vars, 'temp/tasks/review', run.id, depth, lane);
    assert.match(
      rendered,
      /Checklist=REVIEW.rev-test.md signal=REVIEW.rev-test-SIGNAL.json feedback=temp\/tasks\/review\/artifacts\/review-feedback.rev-test.md/,
    );
    assert.doesNotMatch(rendered, /\{\{[^}]+\}\}/);
    assert(rendered.includes(createHash('sha256').update(contents[depth]).digest('hex')));
    assert(rendered.includes('workspace:canonical'));
    assert(rendered.includes('REVIEW.rev-test-SIGNAL.json'));
    const bindings = JSON.parse(rendered.split('```json\n')[1].split('\n```')[0]);
    const saved = JSON.parse(
      await readFile(path.join(taskRoot, bindings.retainedProvenanceArtifact), 'utf8'),
    );
    assert.deepEqual(saved.executionTemplate, bindings.executionTemplate);
    assert.equal(
      await expandReviewTemplate(vars, 'temp/tasks/review', run.id, depth, lane),
      rendered,
    );
  }
  config.review.execution_templates['full-live'] = 'review/static-code';
  await save();
  await assert.rejects(
    expandReviewTemplate(vars, 'temp/tasks/review', run.id, 'full-live'),
    /must declare review-depth:full-live/,
  );
});

test('a farm review template can use {{DEFAULT_BRANCH}}', async (t) => {
  // The va-mmcx-terminal-farm review template diffs against the default branch.
  const project = `.default-branch-review-${process.pid}`;
  const root = path.join(farmslotRoot, 'projects', project);
  await mkdir(path.join(root, 'templates/worker'), { recursive: true });
  await writeFile(
    path.join(root, 'templates/worker/review.md'),
    '# Review\n\n- [ ] git diff origin/{{DEFAULT_BRANCH}}...HEAD in {{REPO}}\n',
  );
  const save = async (config: Record<string, unknown>) => {
    await writeFile(path.join(root, 'project.json'), JSON.stringify({ name: project, ...config }));
    invalidateProjectVarsCache(project);
  };
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project,
    ticketOrPr: 'TEST-BRANCH',
  });
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
  await save({ default_branch: 'develop' });
  assert.match(
    await expandReviewTemplate(vars, 'temp/tasks/review', run.id, 'static-code'),
    /git diff origin\/develop\.\.\.HEAD in \/tmp\/fixture/,
  );
  await save({});
  assert.match(
    await expandReviewTemplate(vars, 'temp/tasks/review', run.id, 'static-code'),
    /git diff origin\/main\.\.\.HEAD/,
  );
});

test('a project without a review template refuses the review launch instead of failing a review', async (t) => {
  // F250: audiolab-farm had no templates/worker/review.md; the request became a failed review.
  const project = `.missing-review-template-${process.pid}`;
  const root = path.join(farmslotRoot, 'projects', project);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ name: project }));
  invalidateProjectVarsCache(project);
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project,
    ticketOrPr: 'TEST-NO-TEMPLATE',
  });
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
  const refusal = await expandReviewTemplate(vars, 'temp/tasks/review', run.id, 'static-code').then(
    () => assert.fail('a missing template must refuse the launch'),
    (error: unknown) => error,
  );
  assert.match(String(refusal), /Review template not found for project/);
  const rejection = publicationReviewLaunchRejectionFromError(refusal);
  assert.equal(rejection?.code, 'PUBLICATION_REVIEW_LAUNCH_REJECTED');
  assert.equal(
    rejection?.userAction,
    `Add templates/worker/review.md to project ${project}, then request the review again.`,
  );
});

test('expandReviewTemplate resolves farmslot_dir placeholders', async (t) => {
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

  const rendered = await expandReviewTemplate(
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
    'temp/tasks/test/review',
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

  const remoteRoot = '/relocated-node/development';
  const ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      const request = JSON.parse(String(raw));
      const rootQuery = request.params.argv?.join(' ') === 'node -p process.cwd()';
      if (rootQuery) assert.equal(request.params.cwd, undefined);
      handleNodeResponse(request.id, true, {
        exitCode: rootQuery ? 0 : 1,
        stdout: rootQuery ? remoteRoot : '',
        stderr: '',
      });
    },
  } as WebSocket;
  registerNode('remote-node', 1, ws);
  t.after(() => unregisterByWs(ws));
  const remoteRendered = await expandReviewTemplate(
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
    'temp/tasks/test/review',
    run.id,
    'full-live',
  );

  assert.match(
    remoteRendered,
    /\/relocated-node\/development\/scripts\/quality\/check-task-artifact-contract\.mjs/,
  );
});

test('review-fix templates resolve nested helpers in the active node and preserve authored issues', async (t) => {
  const project = `.review-fix-node-root-${process.pid}`;
  const root = path.join(farmslotRoot, 'projects', project);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    invalidateProjectVarsCache(project);
  });
  await mkdir(path.join(root, 'templates/worker'), { recursive: true });
  await writeFile(
    path.join(root, 'project.json'),
    JSON.stringify({
      name: project,
      vars: { harness_cmd: 'node "{{farmslot_dir}}/setup/resolve-harness.mjs" "{{FARMSLOT_DIR}}"' },
    }),
  );
  await writeFile(
    path.join(root, 'templates/worker/review-fix.md'),
    '{{HARNESS_CMD}}\n{{FARMSLOT_DIR}}\n{{ISSUES}}\n{{REVIEW_FEEDBACK_FILES}}',
  );
  invalidateProjectVarsCache(project);
  const nodeRoot = '/fixture/review-node-dev';
  const machine = 'review-fix-node-root';
  const requests: RequestFrame[] = [];
  const ws = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    send(raw: string, callback?: () => void) {
      const request: RequestFrame = JSON.parse(raw);
      requests.push(request);
      callback?.();
      handleNodeResponse(
        request.id,
        true,
        { exitCode: 0, stdout: nodeRoot + '\n', stderr: '' },
        undefined,
        undefined,
        ws,
      );
    },
  }) as WebSocket;
  registerNode(machine, 1, ws);
  t.after(() => unregisterByWs(ws));
  const vars = makeVars({
    machine,
    host: 'remote.invalid',
    projectName: project,
    remoteRepo: '/product',
  });
  const run = makeRun({ project, slotId: vars.slotId });
  const description = 'Keep the documented {{farmslot_dir}} token literal.';
  const rendered = await expandReviewFixTemplate(vars, 'tasks/fix', run, [
    { file: 'module.ts', line: 7, description },
  ]);
  assert.ok(
    rendered.includes(`node "${nodeRoot}/setup/resolve-harness.mjs" "${nodeRoot}"\n${nodeRoot}\n`),
  );
  assert.ok(rendered.includes(description));
  assert.equal(requests.length, 1);
  const params = requests[0]?.params;
  assert.ok(isRecord(params));
  assert.deepEqual(params.argv, ['node', '-p', 'process.cwd()']);
  assert.equal(params.cwd, undefined);
});
