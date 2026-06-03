import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Events, type IntelligenceAction } from '@farmslot/protocol';

import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import {
  INTELLIGENCE_AUDIT_MAX_LINE_BYTES,
  INTELLIGENCE_AUDIT_TMUX_TRUNCATION_SUFFIX,
  intelligenceAuditPathForDate,
  writeAuditRecord,
} from './audit-writer.js';
function action(overrides: Partial<IntelligenceAction> = {}): IntelligenceAction {
  return {
    id: 'a',
    timestamp: '2026-05-12T00:00:00.000Z',
    decidedAt: '2026-05-12T00:00:01.000Z',
    runId: 'r',
    project: 'farmslot-farm',
    stepName: 'prepare',
    actor: 'auto-recovery',
    verdict: { category: 'infra', confidence: 'high' },
    guards: [{ name: 'enabled', passed: true, reason: 'drop' } as any],
    outcome: 'applied',
    tier: 'deterministic',
    costUsd: 0,
    ...(overrides as any),
  };
}
function terminalRun() {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-31031',
  });
  return updateRun(run.id, {
    status: 'failed',
    completedAt: '2026-05-12T00:00:00.000Z',
    engineState: { intelligenceAuditDegraded: true },
  });
}
test('writeAuditRecord writes allowlisted bounded NDJSON and clears degraded flag', async (t) => {
  const prev = process.env.HOME;
  const home = mkdtempSync(path.join(tmpdir(), 'farmslot-audit-home-'));
  process.env.HOME = home;
  const run = terminalRun();
  t.after(async () => {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    if (getRun(run.id)) await deleteRun(run.id);
    await rm(home, { recursive: true, force: true });
  });
  const events: any[] = [];
  await writeAuditRecord(
    action({ runId: run.id, appliedAction: { type: 'tmux.send', tmuxKeys: 'x'.repeat(3000) } }),
    {
      runId: run.id,
      emit: (event, payload) => events.push({ event, payload }),
      now: new Date('2026-05-12T12:00:00.000Z'),
    },
  );
  const auditPath = intelligenceAuditPathForDate(new Date('2026-05-12T12:00:00.000Z'));
  const mode = (await stat(path.dirname(auditPath))).mode & 0o777;
  const line = (await readFile(auditPath, 'utf8')).trim();
  const parsed = JSON.parse(line);
  assert.equal(mode, 0o700);
  assert.ok(Buffer.byteLength(line, 'utf8') <= INTELLIGENCE_AUDIT_MAX_LINE_BYTES);
  assert.equal(parsed.guards[0].reason, undefined);
  assert.ok(parsed.appliedAction.tmuxKeys.endsWith(INTELLIGENCE_AUDIT_TMUX_TRUNCATION_SUFFIX));
  assert.equal(getRun(run.id)?.engineState?.intelligenceAuditDegraded, false);
  assert.equal(events[0].event, Events.RUN_UPDATED);
});
test('writeAuditRecord marks audit degraded and emits when append path is unwritable', async (t) => {
  const prev = process.env.HOME;
  const home = mkdtempSync(path.join(tmpdir(), 'farmslot-audit-block-'));
  process.env.HOME = home;
  const run = terminalRun();
  t.after(async () => {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    if (getRun(run.id)) await deleteRun(run.id);
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(path.join(home, '.farmslot', 'logs'), { recursive: true });
  await writeFile(path.join(home, '.farmslot', 'logs', 'intelligence-actions'), 'not a directory');
  const events: any[] = [];
  await writeAuditRecord(action({ runId: run.id }), {
    runId: run.id,
    emit: (event, payload) => events.push({ event, payload }),
  });
  assert.equal(getRun(run.id)?.engineState?.intelligenceAuditDegraded, true);
  assert.equal(events[0].event, Events.RUN_UPDATED);
});
test('writeAuditRecord treats chmod-locked audit directories as degraded instead of repairing silently', async (t) => {
  const prev = process.env.HOME;
  const home = mkdtempSync(path.join(tmpdir(), 'farmslot-audit-chmod-'));
  process.env.HOME = home;
  const run = terminalRun();
  const dir = path.join(home, '.farmslot', 'logs', 'intelligence-actions');
  t.after(async () => {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    if (getRun(run.id)) await deleteRun(run.id);
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o000);
  const events: any[] = [];
  await writeAuditRecord(action({ runId: run.id }), {
    runId: run.id,
    emit: (event, payload) => events.push({ event, payload }),
  });
  assert.equal(getRun(run.id)?.engineState?.intelligenceAuditDegraded, true);
  assert.equal(events[0].event, Events.RUN_UPDATED);
});

test('writeAuditRecord honors explicit audit directory override for isolated validation', async (t) => {
  const previous = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
  const auditDir = mkdtempSync(path.join(tmpdir(), 'farmslot-audit-override-'));
  process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = auditDir;
  const run = terminalRun();
  t.after(async () => {
    if (previous === undefined) delete process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
    else process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = previous;
    if (getRun(run.id)) await deleteRun(run.id);
    await rm(auditDir, { recursive: true, force: true });
  });

  await writeAuditRecord(action({ runId: run.id }), {
    runId: run.id,
    emit: () => undefined,
    now: new Date('2026-05-12T12:00:00.000Z'),
  });

  const auditPath = intelligenceAuditPathForDate(new Date('2026-05-12T12:00:00.000Z'));
  assert.equal(path.dirname(auditPath), auditDir);
  const line = (await readFile(auditPath, 'utf8')).trim();
  assert.equal(JSON.parse(line).runId, run.id);
});
