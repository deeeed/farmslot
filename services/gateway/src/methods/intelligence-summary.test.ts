import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { intelligenceActionsSummary, parseIntelligenceActionLine } from './intelligence.js';

test('typed parser accepts valid action and drops shape drift separately from JSON parse', () => {
  const valid: any = {
    id: 'a1',
    timestamp: '2026-05-11T00:00:00.000Z',
    decidedAt: '2026-05-11T00:00:01.000Z',
    runId: 'r1',
    actor: 'auto-recovery',
    verdict: { confidence: 'high', category: 'infra' },
    guards: [],
    outcome: 'applied',
    tier: 'deterministic',
    costUsd: 0,
  };
  assert.equal(parseIntelligenceActionLine(valid)?.id, 'a1');
  assert.equal(parseIntelligenceActionLine({ ...valid, verdict: { confidence: 'certain' } }), null);
  assert.equal(
    parseIntelligenceActionLine({
      ...valid,
      verdict: { confidence: 'high', category: 'real-bug' },
    }),
    null,
  );
  assert.equal(
    parseIntelligenceActionLine({ ...valid, appliedAction: { type: 'shell.exec' } }),
    null,
  );
  assert.equal(
    parseIntelligenceActionLine({
      ...valid,
      appliedAction: { type: 'run.replayStep', stepName: 42 },
    }),
    null,
  );
  assert.equal(
    parseIntelligenceActionLine({ ...valid, appliedAction: { type: 'tmux.send', tmuxKeys: [] } }),
    null,
  );
  assert.equal(parseIntelligenceActionLine({ ...valid, followupOutcome: 'maybe' }), null);
  assert.equal(parseIntelligenceActionLine({ ...valid, latencyMs: 'fast' }), null);
});
test('typed parser returns sanitized schema fields only', () => {
  const valid: any = {
    id: 'a1',
    timestamp: '2026-05-11T00:00:00.000Z',
    decidedAt: '2026-05-11T00:00:01.000Z',
    runId: 'r1',
    actor: 'auto-recovery',
    verdict: { confidence: 'high', category: 'infra', rationale: 'drop' },
    guards: [{ name: 'enabled', passed: true, secret: 'drop' }],
    outcome: 'proposed',
    tier: 'deterministic',
    costUsd: 0,
    appliedAction: { type: 'tmux.send', tmuxKeys: 'x', command: 'drop' },
    extra: 'drop',
  };
  const parsed: any = parseIntelligenceActionLine(valid);
  assert.equal(parsed.extra, undefined);
  assert.equal(parsed.verdict.rationale, undefined);
  assert.equal(parsed.guards[0].secret, undefined);
  assert.equal(parsed.appliedAction.command, undefined);
  assert.equal(parsed.appliedAction.tmuxKeys, 'x');
});

test('intelligenceActionsSummary filters records by decidedAt range before totals and limit', async (t) => {
  const originalDir = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-intel-summary-'));
  await mkdir(dir, { recursive: true });
  process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = dir;
  t.after(async () => {
    if (originalDir === undefined) delete process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
    else process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = originalDir;
    await rm(dir, { recursive: true, force: true });
  });
  const base = {
    timestamp: '2026-05-12T00:00:00.000Z',
    runId: 'r1',
    actor: 'auto-recovery',
    verdict: { confidence: 'high', category: 'infra' },
    guards: [],
    outcome: 'applied',
    tier: 'deterministic',
    costUsd: 0,
  };
  await writeFile(
    path.join(dir, '2026-05-12.ndjson'),
    [
      JSON.stringify({ ...base, id: 'old', decidedAt: '2026-05-12T00:00:00.000Z' }),
      JSON.stringify({ ...base, id: 'keep-1', decidedAt: '2026-05-12T01:00:00.000Z' }),
      JSON.stringify({
        ...base,
        id: 'keep-2',
        decidedAt: '2026-05-12T02:00:00.000Z',
        outcome: 'proposed',
      }),
      JSON.stringify({ ...base, id: 'new', decidedAt: '2026-05-12T03:00:00.000Z' }),
    ].join('\n') + '\n',
    'utf8',
  );

  const result = await intelligenceActionsSummary({
    dateFrom: '2026-05-12T00:30:00.000Z',
    dateTo: '2026-05-12T02:30:00.000Z',
    limit: 1,
  });

  assert.equal(result.summary.total, 2);
  assert.deepEqual(result.summary.byOutcome, { proposed: 1, applied: 1 });
  assert.deepEqual(
    result.summary.records.map((record) => record.id),
    ['keep-2'],
  );
});
