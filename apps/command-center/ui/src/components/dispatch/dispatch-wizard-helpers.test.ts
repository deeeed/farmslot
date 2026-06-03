import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  detectVariantCollision,
  filterRunsByExactTicket,
  groupPriorRunsByFamily,
  isVariantInputBlocked,
} from './dispatch-wizard-helpers.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? 'run-1',
    familyId: overrides.familyId ?? 'family-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'PROJ-1',
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? null,
    flowType: overrides.flowType ?? 'fix-bug',
    mode: overrides.mode ?? 'autonomous',
    status: overrides.status ?? 'done',
    project: overrides.project ?? 'example-mobile',
    ticketOrPr: overrides.ticketOrPr ?? 'PROJ-1',
    slotId: overrides.slotId ?? null,
    branch: overrides.branch ?? null,
    taskFile: overrides.taskFile ?? null,
    steps: overrides.steps ?? [],
    decisions: overrides.decisions ?? [],
    metrics: overrides.metrics ?? {
      nudgeCount: 0,
      model: null,
      runner: null,
      runnerSessionId: null,
      runnerSessionPath: null,
      outcome: 'success',
    },
    createdAt: overrides.createdAt ?? '2026-05-04T10:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-04T10:00:00.000Z',
    ...overrides,
  } as Run;
}

test('groupPriorRunsByFamily buckets runs by familyId and sorts newest-first within each group', () => {
  const runs = [
    makeRun({ id: 'a', familyId: 'fam-1', createdAt: '2026-05-01T00:00:00Z' }),
    makeRun({ id: 'b', familyId: 'fam-1', createdAt: '2026-05-03T00:00:00Z' }),
    makeRun({ id: 'c', familyId: 'fam-2', createdAt: '2026-05-02T00:00:00Z' }),
  ];
  const groups = groupPriorRunsByFamily(runs);
  assert.equal(groups.size, 2);
  assert.deepEqual(
    groups.get('fam-1')!.map((r) => r.id),
    ['b', 'a'],
  );
  assert.deepEqual(
    groups.get('fam-2')!.map((r) => r.id),
    ['c'],
  );
});

test('groupPriorRunsByFamily falls back to run.id when familyId is empty', () => {
  const runs = [makeRun({ id: 'orphan', familyId: '' })];
  const groups = groupPriorRunsByFamily(runs);
  assert.equal(groups.size, 1);
  assert.ok(groups.has('orphan'));
});

test('filterRunsByExactTicket matches both raw and normalized ticket forms', () => {
  const runs = [
    makeRun({ id: 'a', ticketOrPr: 'example-org/example-mobile#42' }),
    makeRun({ id: 'b', ticketOrPr: 'PROJ-2368' }),
    makeRun({ id: 'c', ticketOrPr: 'PROJ-9999' }),
  ];
  // Exact match on raw input
  assert.deepEqual(
    filterRunsByExactTicket(runs, 'PROJ-2368', '').map((r) => r.id),
    ['b'],
  );
  // Normalized form picks up alternate-key matches (operator typed bare PR number)
  assert.deepEqual(
    filterRunsByExactTicket(runs, '42', 'example-org/example-mobile#42').map((r) => r.id),
    ['a'],
  );
  // No-match case
  assert.deepEqual(
    filterRunsByExactTicket(runs, 'PROJ-0000', '').map((r) => r.id),
    [],
  );
});

test('filterRunsByExactTicket returns empty for blank input even with prior normalized form', () => {
  const runs = [makeRun({ ticketOrPr: 'PROJ-1' })];
  assert.deepEqual(filterRunsByExactTicket(runs, '   ', 'PROJ-1'), []);
});

test('detectVariantCollision returns no collision when family is empty', () => {
  const result = detectVariantCollision([], 'claude', 'sonnet');
  assert.equal(result.collides, false);
  assert.equal(result.suggested, '');
});

test('detectVariantCollision flags same-runner+same-model siblings and suggests next-free suffix', () => {
  const family = [makeRun({ id: 'sib-1', variant: 'claude-sonnet' })];
  const result = detectVariantCollision(family, 'claude', 'sonnet');
  assert.equal(result.collides, true);
  assert.equal(result.suggested, 'claude-sonnet-v2');
});

test('detectVariantCollision skips already-taken suffixes', () => {
  const family = [
    makeRun({ id: 'sib-1', variant: 'claude-sonnet' }),
    makeRun({ id: 'sib-2', variant: 'claude-sonnet-v2' }),
  ];
  const result = detectVariantCollision(family, 'claude', 'sonnet');
  assert.equal(result.suggested, 'claude-sonnet-v3');
});

test('detectVariantCollision says no collision when runner/model differs from siblings', () => {
  const family = [makeRun({ variant: 'claude-sonnet' })];
  const result = detectVariantCollision(family, 'codex', 'gpt-5.5');
  assert.equal(result.collides, false);
});

test('isVariantInputBlocked allows dispatch when there is no collision', () => {
  assert.equal(isVariantInputBlocked([], '', false), false);
});

test('isVariantInputBlocked blocks dispatch when collision exists and input is empty', () => {
  const family = [makeRun({ variant: 'claude-sonnet' })];
  assert.equal(isVariantInputBlocked(family, '   ', true), true);
});

test('isVariantInputBlocked blocks dispatch when input duplicates an existing sibling', () => {
  const family = [makeRun({ variant: 'claude-sonnet' })];
  assert.equal(isVariantInputBlocked(family, 'claude-sonnet', true), true);
});

test('isVariantInputBlocked allows dispatch when input is unique within family', () => {
  const family = [makeRun({ variant: 'claude-sonnet' })];
  assert.equal(isVariantInputBlocked(family, 'claude-sonnet-v2', true), false);
});
