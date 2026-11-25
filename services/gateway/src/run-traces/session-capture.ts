// ADR-039 Amendment 10: archive each agent session when it ends, not only at slot release.
import { contextIdFor, primaryRoleForFlow, type Run } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import type { SlotLocality } from '../core/slot-io.js';
import { loadProjectConfig } from '../fleet/state.js';
import {
  captureRunnerSession,
  captureRunnerSessionBeforeReplay,
} from '../runners/session-archive.js';
import { getRun } from '../runs/store.js';

/** Training traces are on unless the project sets `traces.enabled: false`. */
export async function tracesEnabled(project: string): Promise<boolean> {
  const config = await loadProjectConfig(project).catch((error: unknown) => {
    // An unreadable config keeps the default (on) and says why.
    console.warn(
      `[session-archive] ${project}: project config unreadable: ${(error as Error).message}`,
    );
    return undefined;
  });
  return config?.traces?.enabled !== false;
}

/** The worker's context id, as the archive targets name it. */
export function workerContextId(run: Pick<Run, 'flowType'>): string {
  return contextIdFor(primaryRoleForFlow(run.flowType));
}

async function sessionVars(run: Run, vars?: SlotLocality): Promise<SlotLocality | undefined> {
  if (vars) return vars;
  if (!run.slotId) return undefined;
  return loadSlotVars(run.slotId).catch((error: unknown) => {
    console.warn(
      `[session-archive] ${run.id.slice(0, 8)}: slot ${run.slotId} unavailable: ${(error as Error).message}`,
    );
    return undefined;
  });
}

/**
 * Captures one session after its transition commits. Fire-and-forget: it never throws and
 * never blocks the caller; a failure is recorded `missing` and slot release retries it.
 */
export function captureSessionAtEnd(params: {
  runId: string;
  contextId?: string;
  vars?: SlotLocality;
  answersRound?: number;
  /** The review round a reviewer capture belongs to. */
  round?: number;
}): void {
  void (async () => {
    const run = getRun(params.runId);
    if (!run || !(await tracesEnabled(run.project))) return;
    const vars = await sessionVars(run, params.vars);
    if (!vars) return;
    await captureRunnerSession({
      vars,
      runId: params.runId,
      contextId: params.contextId ?? workerContextId(run),
      answersRound: params.answersRound,
      round: params.round,
    });
  })().catch((error: unknown) =>
    console.warn(
      `[session-archive] capture for ${params.runId.slice(0, 8)} failed: ${(error as Error).message}`,
    ),
  );
}

/** Captures the worker session a replay is about to replace; bounded, never throws. */
export async function captureSessionBeforeReplay(params: {
  runId: string;
  vars?: SlotLocality;
}): Promise<void> {
  try {
    const run = getRun(params.runId);
    if (!run || !(await tracesEnabled(run.project))) return;
    const vars = await sessionVars(run, params.vars);
    if (!vars) return;
    await captureRunnerSessionBeforeReplay({
      vars,
      runId: params.runId,
      contextId: workerContextId(run),
    });
  } catch (error) {
    console.warn(
      `[session-archive] pre-replay capture for ${params.runId.slice(0, 8)} failed: ${(error as Error).message}`,
    );
  }
}
