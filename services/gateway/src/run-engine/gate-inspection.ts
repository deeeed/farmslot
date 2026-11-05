import { isDeepStrictEqual } from 'node:util';

import type { Run } from '@farmslot/protocol';

import { outsideGatewayRequest } from '../observability/performance.js';
import { captureRunResources, publishRunResources } from '../resources/run-changes.js';
import { getRun } from '../runs/store.js';

import { refreshRunGateReadiness } from './gate-prerequisites.js';
import { reconcilePublicationPackageForInspection } from './publish-package-refresh.js';

/**
 * Live gate checks (source HEAD, retained package, worker progress, prerequisites) run here,
 * off the read path. A read serves the stored run and asks for a check: one runs per run at a
 * time, at most once per interval, and a read inside the interval gets one at its end. Command
 * handlers keep their own checks, so a served projection is never approval authority.
 */
export const GATE_INSPECTION_INTERVAL_MS = 30_000;

interface GateInspection {
  lastStartedAt: number;
  running: boolean;
  requested: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** Decisions a check projected without storing them (a package still collecting). */
  projected?: { updatedAt: string; decisions: Run['decisions'] };
}

const inspections = new Map<string, GateInspection>();

/** The stored run, with the decisions its last check projected while the run is unchanged. */
export function inspectedRun(run: Run): Run {
  requestGateInspection(run);
  const projected = inspections.get(run.id)?.projected;
  return projected?.updatedAt === run.updatedAt ? { ...run, decisions: projected.decisions } : run;
}

function requestGateInspection(run: Run): void {
  if (!run.decisions.some((decision) => !decision.resolvedAt)) {
    inspections.delete(run.id);
    return;
  }
  let entry = inspections.get(run.id);
  if (!entry)
    inspections.set(run.id, (entry = { lastStartedAt: 0, running: false, requested: false }));
  if (entry.running) entry.requested = true;
  else schedule(run.id, entry);
}

function schedule(runId: string, entry: GateInspection): void {
  if (entry.timer) return;
  const wait = entry.lastStartedAt + GATE_INSPECTION_INTERVAL_MS - Date.now();
  outsideGatewayRequest(() => {
    if (wait <= 0) void inspect(runId, entry);
    else {
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        void inspect(runId, entry);
      }, wait);
      entry.timer.unref();
    }
  });
}

async function inspect(runId: string, entry: GateInspection): Promise<void> {
  entry.running = true;
  entry.requested = false;
  entry.lastStartedAt = Date.now();
  const before = entry.projected;
  try {
    const run = getRun(runId);
    if (!run?.decisions.some((decision) => !decision.resolvedAt)) {
      inspections.delete(runId);
      return;
    }
    const inspected = await reconcilePublicationPackageForInspection(
      await refreshRunGateReadiness(run),
    );
    const stored = getRun(runId);
    if (!stored) {
      inspections.delete(runId);
      return;
    }
    entry.projected =
      inspected !== stored && inspected.updatedAt === stored.updatedAt
        ? { updatedAt: stored.updatedAt, decisions: inspected.decisions }
        : undefined;
    // Stored changes were published by their writer; a change to what reads serve is published here.
    const served = (projected: GateInspection['projected']) =>
      projected?.updatedAt === stored.updatedAt ? projected.decisions : stored.decisions;
    if (!isDeepStrictEqual(served(before), served(entry.projected)))
      publishRunResources(captureRunResources(stored));
  } catch (error) {
    console.warn(
      `[gate-inspection] ${runId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    entry.running = false;
    if (entry.requested && inspections.get(runId) === entry) schedule(runId, entry);
  }
}
