import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  type HostedTaskInitRequest,
  parseHostedTaskInitRequest,
  runHostedTaskInit,
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
