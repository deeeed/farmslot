import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PipelineSteps, type Run } from '@farmslot/protocol';

import { farmslotRoot } from '../core/config.js';
import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import { intelligenceAuditPathForDate } from './audit-writer.js';

export async function makeProject(
  t: { after: (fn: () => unknown) => void },
  config: Record<string, unknown>,
): Promise<string> {
  const project = `auto-recovery-watcher-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const projectDir = path.join(farmslotRoot, 'projects', project);
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({ name: project, ...config }, null, 2),
    'utf8',
  );
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  return project;
}

export function failRun(project: string, overrides: Partial<Run> = {}): Run {
  const run = createRun({
    flowType: overrides.flowType ?? 'fix-bug',
    project,
    ticketOrPr: `PROJ-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    slotId: overrides.slotId ?? undefined,
    app: overrides.app,
  });
  const completedAt = overrides.completedAt ?? '2026-05-12T10:00:00.000Z';
  return updateRun(run.id, {
    status: 'failed',
    completedAt,
    error: overrides.error ?? 'dev server crashed: ECONNREFUSED',
    engineState: { generation: 0, ...(overrides.engineState ?? {}) },
    steps:
      overrides.steps ??
      run.steps.map((step) =>
        step.name === PipelineSteps.PREPARE
          ? { ...step, status: 'failed' as const, detail: 'dev server crashed' }
          : step,
      ),
    recoveryAttempts: overrides.recoveryAttempts,
    recoveryProposal: overrides.recoveryProposal,
    ciWatchState: overrides.ciWatchState,
  });
}

export function activeRun(project: string, overrides: Partial<Run> = {}): Run {
  const run = createRun({
    flowType: overrides.flowType ?? 'fix-bug',
    project,
    ticketOrPr: `PROJ-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    slotId: overrides.slotId ?? 'auto-recovery-stale-slot',
  });
  return updateRun(run.id, {
    status: overrides.status ?? 'monitoring',
    engineState: { generation: 0, ...(overrides.engineState ?? {}) },
    steps:
      overrides.steps ??
      run.steps.map((step) =>
        step.name === PipelineSteps.MONITOR
          ? { ...step, status: 'running' as const, detail: 'worker monitor active' }
          : step,
      ),
    recoveryProposal: overrides.recoveryProposal,
    autoRecoveryDisabled: overrides.autoRecoveryDisabled,
  });
}

export async function cleanupRun(runId: string): Promise<void> {
  if (!getRun(runId)) return;
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

export function withTempAuditDir(t: { after: (fn: () => unknown) => void }): string {
  const previousDir = process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
  const auditDir = mkdtempSync(path.join(tmpdir(), 'farmslot-watcher-audit-'));
  process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = auditDir;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR;
    else process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR = previousDir;
    await rm(auditDir, { recursive: true, force: true });
  });
  return auditDir;
}

export async function readAuditLines(date = new Date()): Promise<any[]> {
  const raw = await readFile(intelligenceAuditPathForDate(date), 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
