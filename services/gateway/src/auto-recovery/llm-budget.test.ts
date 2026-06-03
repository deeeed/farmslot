import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canSpendLlmBudget,
  reconcileLlmBudgetReservation,
  recordLlmSpend,
  reserveLlmBudget,
  resetLlmBudgetForTest,
} from './llm-budget.js';

test('LLM budget is per-project per-day', () => {
  resetLlmBudgetForTest();
  assert.equal(canSpendLlmBudget('p', 0.02, 0.01), true);
  recordLlmSpend('p', 0.015);
  assert.equal(canSpendLlmBudget('p', 0.02, 0.01), false);
  assert.equal(canSpendLlmBudget('other', 0.02, 0.01), true);
});

test('LLM budget reservations are atomic for concurrent calls', async () => {
  resetLlmBudgetForTest();
  const previousAuditDir = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-llm-budget-'));
  process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = dir;
  try {
    const results = await Promise.all([
      reserveLlmBudget('p', 0.01, 0.01, new Date('2026-05-12T00:00:00.000Z')),
      reserveLlmBudget('p', 0.01, 0.01, new Date('2026-05-12T00:00:00.000Z')),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(results.find(Boolean), { reservedCostUsd: 0.01 });
    assert.equal(canSpendLlmBudget('p', 0.01, 0.01, new Date('2026-05-12T00:00:00.000Z')), false);
  } finally {
    resetLlmBudgetForTest();
    if (previousAuditDir === undefined) delete process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
    else process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = previousAuditDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test('LLM budget pessimistically holds remaining cap for in-flight calls', async () => {
  resetLlmBudgetForTest();
  const previousAuditDir = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-llm-budget-'));
  process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = dir;
  try {
    const date = new Date('2026-05-12T00:00:00.000Z');
    const results = await Promise.all([
      reserveLlmBudget('p', 0.03, 0.01, date),
      reserveLlmBudget('p', 0.03, 0.01, date),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const reservation = results.find(Boolean)!;
    assert.deepEqual(reservation, { reservedCostUsd: 0.03 });
    assert.deepEqual(
      await reconcileLlmBudgetReservation('p', reservation.reservedCostUsd, 0.02, 0.03, date),
      { spentUsd: 0.02, overBudget: false },
    );
    assert.deepEqual(await reserveLlmBudget('p', 0.03, 0.01, date), { reservedCostUsd: 0.01 });
  } finally {
    resetLlmBudgetForTest();
    if (previousAuditDir === undefined) delete process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
    else process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = previousAuditDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test('LLM budget is seeded from same-day audit records after restart', async () => {
  resetLlmBudgetForTest();
  const previousAuditDir = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-llm-budget-'));
  process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = dir;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, '2026-05-12.ndjson'),
      [
        JSON.stringify({ project: 'p', tier: 'llm-refined', costUsd: 0.015 }),
        JSON.stringify({ project: 'p', tier: 'deterministic', costUsd: 100 }),
        JSON.stringify({ project: 'other', tier: 'llm-refined', costUsd: 0.015 }),
        'not-json',
        '',
      ].join('\n'),
      'utf8',
    );

    assert.equal(
      await reserveLlmBudget('p', 0.02, 0.01, new Date('2026-05-12T12:00:00.000Z')),
      null,
    );
    assert.deepEqual(
      await reserveLlmBudget('p', 0.03, 0.01, new Date('2026-05-12T12:00:00.000Z')),
      { reservedCostUsd: 0.015 },
    );
    assert.deepEqual(
      await reserveLlmBudget('p', 0.03, 0.01, new Date('2026-05-13T12:00:00.000Z')),
      { reservedCostUsd: 0.03 },
    );
  } finally {
    resetLlmBudgetForTest();
    if (previousAuditDir === undefined) delete process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
    else process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = previousAuditDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test('LLM budget treats an existing ledger as authoritative over audit backfill', async () => {
  resetLlmBudgetForTest();
  const previousAuditDir = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-llm-budget-'));
  process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = dir;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, '2026-05-12.ndjson'),
      `${JSON.stringify({ project: 'p', tier: 'llm-refined', costUsd: 0.015 })}\n`,
      'utf8',
    );
    await writeFile(path.join(dir, '2026-05-12.llm-budget.ndjson'), 'not-json\n', 'utf8');

    assert.deepEqual(
      await reserveLlmBudget('p', 0.02, 0.01, new Date('2026-05-12T12:00:00.000Z')),
      { reservedCostUsd: 0.02 },
    );
    resetLlmBudgetForTest();
    assert.equal(
      await reserveLlmBudget('p', 0.02, 0.01, new Date('2026-05-12T12:00:00.000Z')),
      null,
    );
  } finally {
    resetLlmBudgetForTest();
    if (previousAuditDir === undefined) delete process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
    else process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = previousAuditDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test('LLM budget reservations persist before audit rows exist', async () => {
  resetLlmBudgetForTest();
  const previousAuditDir = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-llm-budget-'));
  process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = dir;
  try {
    const date = new Date('2026-05-12T00:00:00.000Z');
    assert.deepEqual(await reserveLlmBudget('p', 0.01, 0.01, date), { reservedCostUsd: 0.01 });
    resetLlmBudgetForTest();
    assert.equal(await reserveLlmBudget('p', 0.01, 0.01, date), null);
  } finally {
    resetLlmBudgetForTest();
    if (previousAuditDir === undefined) delete process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
    else process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = previousAuditDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test('LLM budget reconciliation refunds unused reservation budget', async () => {
  resetLlmBudgetForTest();
  const previousAuditDir = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-llm-budget-'));
  process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = dir;
  try {
    const date = new Date('2026-05-12T00:00:00.000Z');
    const reservation = await reserveLlmBudget('p', 0.03, 0.01, date);
    assert.deepEqual(reservation, { reservedCostUsd: 0.03 });
    assert.deepEqual(
      await reconcileLlmBudgetReservation('p', reservation!.reservedCostUsd, 0.025, 0.03, date),
      { spentUsd: 0.025, overBudget: false },
    );
    assert.equal(canSpendLlmBudget('p', 0.03, 0.01, date), false);
  } finally {
    resetLlmBudgetForTest();
    if (previousAuditDir === undefined) delete process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
    else process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = previousAuditDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test('LLM budget reconciliation flags actual cost above the daily cap', async () => {
  resetLlmBudgetForTest();
  const previousAuditDir = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-llm-budget-'));
  process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = dir;
  try {
    const date = new Date('2026-05-12T00:00:00.000Z');
    const reservation = await reserveLlmBudget('p', 0.015, 0.01, date);
    assert.deepEqual(reservation, { reservedCostUsd: 0.015 });
    assert.deepEqual(
      await reconcileLlmBudgetReservation('p', reservation!.reservedCostUsd, 0.02, 0.015, date),
      { spentUsd: 0.015, overBudget: true },
    );
    assert.equal(await reserveLlmBudget('p', 0.015, 0.01, date), null);
  } finally {
    resetLlmBudgetForTest();
    if (previousAuditDir === undefined) delete process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
    else process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = previousAuditDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test('LLM budget reconciliation deltas persist across restart', async () => {
  resetLlmBudgetForTest();
  const previousAuditDir = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-llm-budget-'));
  process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = dir;
  try {
    const date = new Date('2026-05-12T00:00:00.000Z');
    const reservation = await reserveLlmBudget('p', 0.03, 0.01, date);
    assert.deepEqual(reservation, { reservedCostUsd: 0.03 });
    assert.deepEqual(
      await reconcileLlmBudgetReservation('p', reservation!.reservedCostUsd, 0.025, 0.03, date),
      { spentUsd: 0.025, overBudget: false },
    );
    resetLlmBudgetForTest();
    assert.equal(await reserveLlmBudget('p', 0.03, 0.01, date), null);
  } finally {
    resetLlmBudgetForTest();
    if (previousAuditDir === undefined) delete process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
    else process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = previousAuditDir;
    await rm(dir, { recursive: true, force: true });
  }
});
