import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { RECIPE_PROTOCOL_SCHEMA_URL, type Run } from '@farmslot/protocol';

import { retainFixtureTask } from '../../../../packages/run-bundle/src/retained.test-support.js';
import { runBundleStore } from '../run-completion/retained-artifacts.js';

import { materializeInheritedContext } from './context.js';
import { buildFamilyObservabilitySnapshotFromRuns } from './snapshot.js';

export function makeRecipeJson(nodes: Record<string, unknown>, entry = 'start'): string {
  return JSON.stringify({
    $schema: RECIPE_PROTOCOL_SCHEMA_URL,
    description: 'Gateway observability test recipe.',
    workflow: { entry, nodes },
  });
}

export function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? 'run-1',
    familyId: overrides.familyId ?? 'family-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'PROJ-1',
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? null,
    flowType: overrides.flowType ?? 'fix-bug',
    mode: overrides.mode ?? 'interactive',
    status: overrides.status ?? 'done',
    project: overrides.project ?? 'example-mobile-farm',
    ticketOrPr: overrides.ticketOrPr ?? 'PROJ-1',
    app: overrides.app,
    slotId: 'slotId' in overrides ? overrides.slotId! : null,
    branch: 'branch' in overrides ? overrides.branch! : null,
    completionPolicy: overrides.completionPolicy,
    taskFile: 'taskFile' in overrides ? overrides.taskFile! : null,
    activeTaskFile: overrides.activeTaskFile,
    prNumber: 'prNumber' in overrides ? overrides.prNumber : undefined,
    steps: overrides.steps ?? [],
    decisions: overrides.decisions ?? [],
    metrics: overrides.metrics ?? {
      nudgeCount: 0,
      model: 'gpt-5.5',
      runner: 'codex',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: overrides.createdAt ?? '2026-04-15T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-15T00:00:00.000Z',
    ticketData: overrides.ticketData,
    grade: overrides.grade,
    humanGrade: overrides.humanGrade,
    links: overrides.links,
    summary: 'summary' in overrides ? overrides.summary! : 'Root summary',
    reviewTier: overrides.reviewTier,
    completedAt: overrides.completedAt,
    error: overrides.error,
    monitorState: overrides.monitorState,
  };
}

export async function writeArtifact(taskDir: string, relPath: string, content: string) {
  const full = path.join(taskDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf-8');
}

/** Explicit capture keeps historical fixtures subject to the production retention boundary. */
export async function retainFamilyFixtures(runs: Run[]): Promise<void> {
  const store = await runBundleStore(true);
  for (const run of new Map(runs.map((run) => [run.id, run])).values()) {
    if (run.taskFile) await retainFixtureTask(path.dirname(run.taskFile), run, store);
  }
}

export async function buildRetainedFamilySnapshot(runs: Run[], allRuns: Run[] = []) {
  await retainFamilyFixtures([...runs, ...allRuns]);
  return buildFamilyObservabilitySnapshotFromRuns(runs, allRuns);
}

export async function materializeRetainedFamilyContext(run: Run, taskDir: string, allRuns: Run[]) {
  await retainFamilyFixtures(allRuns);
  return materializeInheritedContext(run, taskDir, allRuns);
}
