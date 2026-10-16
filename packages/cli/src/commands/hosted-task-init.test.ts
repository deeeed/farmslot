import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  type HostedTaskInitRequest,
  type HostedTaskTemplateCatalog,
  parseHostedTaskInitRequest,
  runHostedTaskInit,
  selectHostedTaskTemplate,
} from './hosted-task-init.js';

function request(): HostedTaskInitRequest {
  return {
    version: 1,
    slotId: 'fixture-core-1',
    binding: 'static',
    task: {
      taskDir: '/fixture/checkout/tasks/dev/proof',
      flow: 'dev',
      platform: 'core',
      task: { title: 'Retained task', sourceKind: 'text' },
      handoff: { surface: 'farmslot', project: 'fixture', attemptId: 'run-fixture' },
    },
    template: {
      sourceId: 'project:fixture',
      id: 'dev',
      sha256: 'a'.repeat(64),
      selectionReason: 'configured-default',
    },
  };
}

test('private request accepts the declared grammar and rejects executable or gate authority', () => {
  const valid = request();
  assert.deepEqual(parseHostedTaskInitRequest(valid), valid);
  for (const forbidden of [
    { execution: {} },
    { markCommand: 'unfrozen mark' },
    { template: { sources: [] } },
  ])
    assert.throws(
      () => parseHostedTaskInitRequest({ ...valid, task: { ...valid.task, ...forbidden } }),
      /invalid or forbidden/,
    );
  assert.throws(
    () => parseHostedTaskInitRequest({ ...valid, authorizedProviders: ['arbitrary'] }),
    /invalid or forbidden/,
  );
  assert.throws(
    () =>
      parseHostedTaskInitRequest({
        ...valid,
        template: { ...valid.template, selectionReason: 'invented' },
      }),
    /invalid or forbidden/,
  );
});

test('private requests validate replay and authored data instead of asserting its type', () => {
  const valid = request();
  assert.throws(
    () =>
      parseHostedTaskInitRequest({
        ...valid,
        task: { ...valid.task, artifactOnlyReplay: { base: 7 } },
      }),
    /invalid or forbidden/,
  );
  assert.throws(
    () =>
      parseHostedTaskInitRequest({
        ...valid,
        task: {
          ...valid.task,
          authored: { taskMarkdown: '# Authored', checklistMarkdown: null, handoff: {} },
        },
      }),
    /invalid or forbidden/,
  );
});

test('temporary request is removed on refusal and ordinary user files are preserved', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-init-wire-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requestFile = path.join(root, `.task-init-${randomUUID()}.json`);
  fs.writeFileSync(requestFile, '{"version":0}');
  await assert.rejects(runHostedTaskInit(requestFile), /invalid or forbidden/);
  assert.equal(fs.existsSync(requestFile), false);
  const userFile = path.join(root, 'project.json');
  fs.writeFileSync(userFile, '{}');
  await assert.rejects(runHostedTaskInit(userFile), /Only owned temporary/);
  assert.equal(fs.readFileSync(userFile, 'utf8'), '{}');
});

test('oversized requests refuse before reading and remove their owned transport file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-init-bound-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requestFile = path.join(root, `.task-init-${randomUUID()}.json`);
  fs.writeFileSync(requestFile, '');
  fs.truncateSync(requestFile, 8 * 1024 * 1024 + 1);
  await assert.rejects(runHostedTaskInit(requestFile), /at most 8 MiB/);
  assert.equal(fs.existsSync(requestFile), false);
});

/** A pack whose QA template lives in an environment-rooted package source, like the MetaMask packs. */
function qaCatalog(
  t: TestContext,
  rootInMachineEnv: boolean,
): {
  catalog: HostedTaskTemplateCatalog;
  request: Pick<HostedTaskInitRequest, 'task' | 'template'>;
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-qa-template-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const template = path.join(root, 'cook/references/templates/qa/default.md');
  fs.mkdirSync(path.dirname(template), { recursive: true });
  fs.writeFileSync(template, '---\nplatforms: [core]\n---\n# QA\n\n- [ ] Observe\n');
  fs.mkdirSync(path.join(root, 'pack/templates'), { recursive: true });
  return {
    catalog: {
      project: {
        projectName: 'fixture',
        projectConfig: path.join(root, 'pack/project.json'),
        projectTemplatesDir: path.join(root, 'pack/templates'),
        projectJson: {
          execution_templates: {
            sources: [
              {
                id: 'package:fixture-cook',
                kind: 'package',
                root: { env: 'FIXTURE_COOK_ROOT' },
                subpath: 'references/templates',
              },
            ],
          },
          qa: { profiles: [{ id: 'release', title: 'Release QA', template_id: 'qa/default' }] },
        },
      },
      slot: {
        platform: 'core',
        machineEnv: rootInMachineEnv ? { FIXTURE_COOK_ROOT: path.join(root, 'cook') } : {},
      },
    },
    request: {
      task: { ...request().task, flow: 'qa' },
      template: {
        sourceId: 'package:fixture-cook',
        id: 'qa/default',
        sha256: createHash('sha256').update(fs.readFileSync(template)).digest('hex'),
        selectionReason: 'explicit',
      },
    },
  };
}

test('QA task selects qa/default from a template root in the slot machine environment', (t) => {
  assert.equal(process.env.FIXTURE_COOK_ROOT, undefined);
  const { catalog, request: qa } = qaCatalog(t, true);
  const { selected, sources } = selectHostedTaskTemplate(catalog, qa);
  assert.equal(selected.entry.id, 'qa/default');
  assert.equal(selected.entry.flow, 'qa');
  assert.equal(selected.entry.sourceId, 'package:fixture-cook');
  assert.equal(selected.entry.sha256, qa.template.sha256);
  assert.deepEqual(
    sources.map((source) => source.id),
    ['project:fixture', 'package:fixture-cook'],
  );
});

test('a template source whose root only the gateway has refuses with its name and variable', (t) => {
  const { catalog, request: qa } = qaCatalog(t, false);
  assert.throws(
    () => selectHostedTaskTemplate(catalog, qa),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'TASK_TEMPLATE_SOURCE_UNAVAILABLE' &&
      error.message ===
        'Execution-template source "package:fixture-cook" is unavailable on this node (missing-environment); set FIXTURE_COOK_ROOT in the slot machine environment.',
  );
});

test('normal hosted tasks cannot weaken configured terminal gates', async () => {
  const { builtinTerminalContract } = await import('@farmslot/agent-runtime');
  const { hostedTerminalPolicy } = await import('./hosted-task-init.js');
  const configured = { ...builtinTerminalContract('dev'), acceptance: { require: true } };
  const weakened = { ...configured, acceptance: { require: false } };
  assert.throws(
    () => hostedTerminalPolicy({ ...request().task, terminalContract: weakened }, configured),
    /differs from the node configuration/,
  );
  const projected = hostedTerminalPolicy(
    {
      ...request().task,
      terminalContract: {
        ...configured,
        claimReviewGate: true,
        recordedEvidenceContractVersion: 1,
      },
    },
    configured,
  );
  assert.equal(projected.claimReviewGate, true);
  assert.deepEqual(projected.acceptance, { require: true });
});
