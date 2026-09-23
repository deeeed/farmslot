import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  digest,
  prepareAdmittedTriage,
  RUBRIC_VERSION,
  textDigest,
} from '../../assessment/failure-triage/packet.js';
import { finishAssessment, reserveAssessment } from '../../assessment/store.js';
import { listLogRegistryEntries } from '../../observability/log-registry.js';
import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

import { readTriagePolicy } from './policy.js';
import { getFailureTriage } from './service.js';
import { admittedFailureSnapshot, triageFailureHash } from './snapshot.js';

test('saved triage advice remains linkable with model disabled but requires current source approval', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'triage-link-get-'));
  const logs = path.join(home, 'logs');
  await mkdir(logs);
  const priorHome = process.env.FARMSLOT_HOME;
  const priorLogs = process.env.FARMSLOT_LOG_DIR;
  const priorEnabled = process.env.FARMSLOT_ASSESSMENT_ENABLED;
  process.env.FARMSLOT_HOME = home;
  process.env.FARMSLOT_LOG_DIR = logs;
  process.env.FARMSLOT_ASSESSMENT_ENABLED = 'false';
  const source = path.join(logs, 'validation.log');
  const text = 'Synthetic validation: configured executable unavailable\n';
  await writeFile(source, text);
  const run = createRun({
    flowType: 'dev',
    mode: 'interactive',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-SYNTHETIC-TRIAGE',
  });
  const step = {
    name: 'validation',
    status: 'failed' as const,
    detail: 'Synthetic failure',
    outputs: { logPath: source },
  };
  updateRun(run.id, { status: 'done', steps: [step] });
  t.after(async () => {
    if (getRun(run.id)) await deleteRun(run.id);
    if (priorHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = priorHome;
    if (priorLogs === undefined) delete process.env.FARMSLOT_LOG_DIR;
    else process.env.FARMSLOT_LOG_DIR = priorLogs;
    if (priorEnabled === undefined) delete process.env.FARMSLOT_ASSESSMENT_ENABLED;
    else process.env.FARMSLOT_ASSESSMENT_ENABLED = priorEnabled;
    await rm(home, { recursive: true, force: true });
  });
  const entry = (await listLogRegistryEntries()).find(
    (candidate) => candidate.displayPath === '<farmslot-logs>/validation.log',
  );
  assert.ok(entry, 'Synthetic log is registered');
  const price = {
    version: 1 as const,
    provider: 'typesafe',
    model: 'jev-fixture',
    verifiedAt: new Date().toISOString(),
    source: 'https://example.invalid/price',
    inputUsdPerMillion: 0.01,
    outputUsdPerMillion: 0,
    maxRequestTokens: 1000,
  };
  const policyFile = path.join(home, 'triage-policy.json');
  const policy = {
    enabled: true,
    projects: [run.project],
    receiptDirectory: home,
    maxCalls: 2,
    maxUsd: 0.01,
    price,
    approvals: [
      {
        runId: run.id,
        project: run.project,
        step: step.name,
        failureHash: triageFailureHash(getRun(run.id)!, step),
        sources: [{ logId: entry.id, digest: textDigest(text) }],
        origin: { kind: 'synthetic', reference: 'fixture:link-get' },
      },
    ],
  };
  await writeFile(policyFile, JSON.stringify(policy));
  const snapshot = await admittedFailureSnapshot(
    run.id,
    step.name,
    (await readTriagePolicy()) as Extract<
      Awaited<ReturnType<typeof readTriagePolicy>>,
      { enabled: true }
    >,
  );
  const prepared = prepareAdmittedTriage(snapshot.packet, digest(snapshot.packet));
  const ownerId = 'triage-link-test-operator';
  const reservation = await reserveAssessment(
    {
      ownerId,
      consumer: 'failure-triage',
      subject: {
        run: {
          id: run.id,
          project: run.project,
          step: step.name,
          sources: snapshot.sources,
          snapshotHash: digest({
            source: snapshot.snapshotHash,
            packet: prepared.packetHash,
            questions: prepared.questionHash,
            provider: price.provider,
            model: price.model,
            rubric: RUBRIC_VERSION,
          }),
        },
      },
      requestedIdentity: {
        provider: price.provider,
        model: price.model,
        inputDigest: prepared.packetHash,
        questionSchemaHash: prepared.questionHash,
      },
      policyVersion: RUBRIC_VERSION,
    },
    { key: '1'.repeat(64), maxUsd: 0.001, priceHash: '2'.repeat(64), price },
    { maxCalls: 2, maxUsd: 0.01 },
  );
  assert.equal(reservation.status, 'reserved');
  if (reservation.status !== 'reserved') throw new Error('Synthetic assessment was not reserved');
  await finishAssessment(reservation.record, {
    status: 'completed',
    answers: { cause: { type: 'choice', choice: 'unclear', choices: ['unclear'] } },
  });
  const params = { runId: run.id };
  const disabledModel = await getFailureTriage(ownerId, params);
  assert.equal(disabledModel.availability, 'disabled');
  assert.equal(disabledModel.record?.id, reservation.record.id);
  assert.equal(disabledModel.decisionLinkable, true);
  assert.equal(
    disabledModel.stale,
    false,
    'Approved saved advice is current when new calls are disabled',
  );

  process.env.FARMSLOT_ASSESSMENT_ENABLED = 'true';
  const unavailableModel = await getFailureTriage(ownerId, params);
  assert.equal(unavailableModel.availability, 'unsupported-model');
  assert.equal(unavailableModel.decisionLinkable, true);
  policy.price = { ...price, verifiedAt: new Date(Date.now() - 2000).toISOString() };
  await writeFile(policyFile, JSON.stringify(policy));
  assert.equal((await getFailureTriage(ownerId, params)).decisionLinkable, true);
  process.env.FARMSLOT_ASSESSMENT_ENABLED = 'false';
  await writeFile(policyFile, JSON.stringify({ enabled: false }));
  const disabledApproval = await getFailureTriage(ownerId, params);
  assert.equal(disabledApproval.availability, 'disabled');
  assert.equal(disabledApproval.decisionLinkable, false);
  assert.equal(disabledApproval.stale, true);
  await writeFile(policyFile, JSON.stringify(policy));
  await writeFile(source, 'Changed log content\n');
  const changedSource = await getFailureTriage(ownerId, params);
  assert.equal(changedSource.decisionLinkable, false);
  await writeFile(source, text);
  // A newer assessment of an earlier failed step must not hide this step's valid advice.
  updateRun(run.id, {
    steps: [{ name: 'prepare', status: 'failed', detail: 'Earlier failure' }, step],
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const olderStep = await reserveAssessment(
    {
      ownerId,
      consumer: 'failure-triage',
      subject: { run: { ...reservation.record.subject.run!, step: 'prepare' } },
      requestedIdentity: reservation.record.requestedIdentity!,
      policyVersion: RUBRIC_VERSION,
    },
    { key: '3'.repeat(64), maxUsd: 0.001, priceHash: '4'.repeat(64), price },
    { maxCalls: 2, maxUsd: 0.01 },
  );
  assert.equal(olderStep.status, 'reserved');
  if (olderStep.status !== 'reserved') throw new Error('Older step assessment was not reserved');
  await finishAssessment(olderStep.record, {
    status: 'completed',
    answers: { cause: { type: 'choice', choice: 'unclear', choices: ['unclear'] } },
  });
  const current = await getFailureTriage(ownerId, params);
  assert.equal(current.record?.id, reservation.record.id);
  assert.equal(current.step, step.name);
  assert.equal(current.decisionLinkable, true);
  updateRun(run.id, {
    steps: [step, { name: 'later-validation', status: 'failed', detail: 'New failure' }],
  });
  assert.equal((await getFailureTriage(ownerId, params)).decisionLinkable, false);
});
