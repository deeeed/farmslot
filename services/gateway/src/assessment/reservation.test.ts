import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assessmentRecords, finishAssessment, reserveAssessment } from './store.js';

test('reservation coalesces requests, counts other owners and survives restart without replay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'assessment-reservation-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = root;
  try {
    const context = {
      ownerId: 'operator-test',
      consumer: 'failure-triage' as const,
      subject: {
        run: {
          id: 'run-test',
          project: 'fixture',
          step: 'validation',
          snapshotHash: 'a'.repeat(64),
        },
      },
      policyVersion: 'failure-triage-v1',
    };
    const reservation = { key: 'b'.repeat(64), maxUsd: 0.01, priceHash: 'c'.repeat(64) };
    const limits = { maxCalls: 2, maxUsd: 0.01 };
    const pair = await Promise.all([
      reserveAssessment(context, reservation, limits),
      reserveAssessment(context, reservation, limits),
    ]);
    assert.deepEqual(pair.map((r) => r.status).sort(), ['existing', 'reserved']);
    assert.equal((await assessmentRecords(context.ownerId)).length, 1);
    assert.equal(
      (
        await reserveAssessment(
          { ...context, ownerId: 'second-operator' },
          { ...reservation, key: 'd'.repeat(64) },
          limits,
        )
      ).status,
      'budget-blocked',
    );
    const source = `
      import { reserveAssessment } from './src/assessment/store.ts';
      const result = await reserveAssessment(${JSON.stringify(context)}, ${JSON.stringify(reservation)}, ${JSON.stringify(limits)});
      console.log(JSON.stringify(result));
    `;
    const restarted = JSON.parse(
      execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
        cwd: new URL('../..', import.meta.url),
        env: { ...process.env, TSX_TSCONFIG_PATH: 'tsconfig.json' },
        encoding: 'utf8',
      }),
    );
    assert.equal(restarted.status, 'existing');
    assert.equal(restarted.record.status, 'interrupted');
    assert.equal(restarted.record.reservation.maxUsd, 0.01);
    assert.equal(restarted.record.result, undefined);
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    await rm(root, { recursive: true });
  }
});

test('confirmed pre-transport rejection frees daily budget but retains an audit record', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'assessment-no-call-'));
  const prior = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = root;
  try {
    const context = {
      ownerId: 'operator-test',
      consumer: 'failure-triage' as const,
      subject: {
        run: {
          id: 'run-test',
          project: 'fixture',
          step: 'validation',
          snapshotHash: 'a'.repeat(64),
        },
      },
      policyVersion: 'failure-triage-v1',
    };
    const reservation = { key: 'b'.repeat(64), maxUsd: 0.01, priceHash: 'c'.repeat(64) };
    const limits = { maxCalls: 1, maxUsd: 0.01 };
    const first = await reserveAssessment(context, reservation, limits);
    assert.equal(first.status, 'reserved');
    if (first.status !== 'reserved') throw new Error('Missing fixture reservation');
    await finishAssessment(first.record, {
      status: 'unavailable',
      attempted: false,
      provider: 'typesafe',
      requestedModel: 'jev-fixture',
      error: 'Assessment provider request failed',
    });
    const second = await reserveAssessment(
      context,
      { ...reservation, key: 'd'.repeat(64) },
      limits,
    );
    assert.equal(second.status, 'reserved');
    assert.equal((await assessmentRecords(context.ownerId)).length, 2);
    assert.equal(
      (await reserveAssessment(context, { ...reservation, key: 'e'.repeat(64) }, limits)).status,
      'budget-blocked',
    );
  } finally {
    if (prior === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = prior;
    await rm(root, { recursive: true });
  }
});
