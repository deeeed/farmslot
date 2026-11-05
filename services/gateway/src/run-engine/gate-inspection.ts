import { isDeepStrictEqual } from 'node:util';

import type { Run, RunDecision } from '@farmslot/protocol';

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
  /**
   * Decisions a check projected without storing them (a package still collecting), by id, with
   * the stored payload each was taken from. Writers replace a payload rather than edit it.
   */
  projected: Map<string, { from: RunDecision['payload']; decision: RunDecision }>;
}

const inspections = new Map<string, GateInspection>();

const hasOpenDecision = (run: Run | undefined) =>
  Boolean(run?.decisions.some((decision) => !decision.resolvedAt));

/** A projection stands only while its decision is still open on the payload it was taken from. */
function servedDecisions(run: Run, projected: GateInspection['projected']): Run['decisions'] {
  if (!projected.size) return run.decisions;
  let changed = false;
  const decisions = run.decisions.map((decision) => {
    const entry = projected.get(decision.id);
    if (!entry || decision.resolvedAt || decision.payload !== entry.from) return decision;
    changed = true;
    return entry.decision;
  });
  return changed ? decisions : run.decisions;
}

/** The stored run, with the decisions its last check projected. */
export function inspectedRun(run: Run): Run {
  requestGateInspection(run);
  const projected = inspections.get(run.id)?.projected;
  const decisions = projected ? servedDecisions(run, projected) : run.decisions;
  return decisions === run.decisions ? run : { ...run, decisions };
}

function retire(runId: string): void {
  const entry = inspections.get(runId);
  if (!entry || entry.running) return;
  clearTimeout(entry.timer);
  inspections.delete(runId);
}

function requestGateInspection(run: Run): void {
  if (!hasOpenDecision(run)) return retire(run.id);
  let entry = inspections.get(run.id);
  if (!entry)
    inspections.set(
      run.id,
      (entry = { lastStartedAt: 0, running: false, requested: false, projected: new Map() }),
    );
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
  try {
    const run = getRun(runId);
    if (!hasOpenDecision(run)) return;
    // Readiness is stored by its writer; the package check may only project.
    const refreshed = await refreshRunGateReadiness(run!);
    const from = new Map(refreshed.decisions.map((decision) => [decision.id, decision.payload]));
    const inspected = await reconcilePublicationPackageForInspection(refreshed);
    const stored = getRun(runId);
    if (!stored) return;
    const before = servedDecisions(stored, entry.projected);
    entry.projected = new Map();
    for (const decision of inspected.decisions) {
      const taken = from.get(decision.id);
      const current = stored.decisions.find(({ id }) => id === decision.id);
      // Only what the check itself changed, and only while the store still holds its source.
      if (current && decision.payload !== taken && current.payload === taken)
        entry.projected.set(decision.id, { from: taken, decision });
    }
    // Stored changes were published by their writer; a change to what reads serve is published here.
    if (!isDeepStrictEqual(before, servedDecisions(stored, entry.projected)))
      publishRunResources(captureRunResources(stored));
  } catch (error) {
    console.warn(
      `[gate-inspection] ${runId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    entry.running = false;
    if (inspections.get(runId) === entry) {
      if (!hasOpenDecision(getRun(runId))) retire(runId);
      else if (entry.requested) schedule(runId, entry);
    }
    // Runs closed, archived or deleted since their last read keep no entry.
    for (const id of inspections.keys()) if (!hasOpenDecision(getRun(id))) retire(id);
  }
}
