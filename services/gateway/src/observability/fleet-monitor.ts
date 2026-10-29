// monitor.ts — Server-side slot monitoring (replaces session-bound crons)
// Periodic fleet refresh + decision detection

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  FleetStatus,
  MonitorViolation,
  PendingDecision,
  SlotStatus,
} from '@farmslot/protocol';

import { projectTaskRoots } from '../core/config.js';
import { farmslotRoot } from '../fleet/state.js';
import { fleetStatus } from '../methods/fleet.js';
import { resourceRevisions } from '../resources/revisions.js';

const MONITOR_STATE_FILE = path.join(farmslotRoot, '.monitor_state.json');

export type MonitorEventHandler = {
  onFleetUpdated: (fleet: FleetStatus) => void;
  onDecisionNew: (decision: PendingDecision) => void;
  onViolation: (violation: MonitorViolation) => void;
};

const FLEET_POLL_MS = readIntervalMs('FARMSLOT_MONITOR_FLEET_POLL_MS', 30_000);
const DECISION_POLL_MS = readIntervalMs('FARMSLOT_MONITOR_DECISION_POLL_MS', 30_000);
const ACTIVE_CONTEXT_FRESH_MS = readIntervalMs(
  'FARMSLOT_MONITOR_ACTIVE_CONTEXT_FRESH_MS',
  5 * 60_000,
);

let fleetTimer: ReturnType<typeof setInterval> | null = null;
let decisionTimer: ReturnType<typeof setInterval> | null = null;
let persistTimer: ReturnType<typeof setInterval> | null = null;
let fleetPollInFlight = false;
let decisionPollInFlight = false;
let knownDecisions = new Set<string>();
let knownDecisionFiles = new Map<string, string>();
let decisionScanFailure: string | undefined;
let handler: MonitorEventHandler | null = null;

interface FileDecision {
  path: string;
  decision: PendingDecision;
  signature: string;
}

const decisionsKey = { family: 'decisions', scope: 'farm' } as const;

function readIntervalMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : fallback;
}

// ─── State persistence ───

async function loadMonitorState(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(MONITOR_STATE_FILE, 'utf-8'));
    if (Array.isArray(raw.knownDecisions)) {
      knownDecisions = new Set(raw.knownDecisions);
    }
    if (Array.isArray(raw.notifiedSlots)) {
      for (const s of raw.notifiedSlots) {
        if (typeof s !== 'string') continue;
        notifiedSlots.add(s.includes(':') ? s : violationKey(s, 'stuck'));
      }
    }
  } catch {
    /* no persisted state yet */
  }
}

async function saveMonitorState(): Promise<void> {
  try {
    await writeFile(
      MONITOR_STATE_FILE,
      JSON.stringify({
        lastScan: new Date().toISOString(),
        knownDecisions: [...knownDecisions],
        notifiedSlots: [...notifiedSlots],
      }),
      'utf-8',
    );
  } catch {
    /* best effort */
  }
}

export function startMonitor(eventHandler: MonitorEventHandler): void {
  handler = eventHandler;

  // Restore persisted state before starting loops
  loadMonitorState();

  // Fleet refresh loop
  fleetTimer = setInterval(async () => {
    if (fleetPollInFlight) return;
    fleetPollInFlight = true;
    try {
      const { fleet } = await fleetStatus();
      handler?.onFleetUpdated(fleet);
      checkForViolations(fleet);
    } catch {
      /* ignore refresh errors */
    } finally {
      fleetPollInFlight = false;
    }
  }, FLEET_POLL_MS);
  fleetTimer.unref();

  // Decision scan loop. A scan that fails (an unreadable projects dir) is logged and retried on
  // the next tick; it must never become an unhandled rejection, which would stop the gateway.
  const guardedScan = async () => {
    if (decisionPollInFlight) return;
    decisionPollInFlight = true;
    try {
      await scanDecisions();
    } catch (err) {
      console.warn(
        `[fleet-monitor] decision scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      decisionPollInFlight = false;
    }
  };
  decisionTimer = setInterval(() => void guardedScan(), DECISION_POLL_MS);
  decisionTimer.unref();

  // Initial scan
  void guardedScan();

  // Persist state every 30s
  persistTimer = setInterval(() => saveMonitorState(), 30_000);
  persistTimer.unref();
}

export function stopMonitor(): void {
  if (fleetTimer) {
    clearInterval(fleetTimer);
    fleetTimer = null;
  }
  if (decisionTimer) {
    clearInterval(decisionTimer);
    decisionTimer = null;
  }
  if (persistTimer) {
    clearInterval(persistTimer);
    persistTimer = null;
  }
  saveMonitorState();
}

// ─── Decision scanning ───

export async function scanDecisions(): Promise<void> {
  let files: FileDecision[];
  try {
    files = await loadFileDecisions();
  } catch (error) {
    const failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    // Invalidate once so readers retain stale facts with the real read error.
    if (decisionScanFailure !== failure) resourceRevisions.advance(decisionsKey);
    decisionScanFailure = failure;
    throw error;
  }
  const currentFiles = new Map(files.map((file) => [file.path, file.signature]));
  const changed =
    decisionScanFailure !== undefined ||
    currentFiles.size !== knownDecisionFiles.size ||
    [...currentFiles].some(([file, signature]) => knownDecisionFiles.get(file) !== signature);
  decisionScanFailure = undefined;
  knownDecisionFiles = currentFiles;
  // Compare committed file bytes, not the fallback display timestamp generated by a read.
  // Legacy decision ids can be paths, so only the safe collection key goes on the wire.
  if (changed) resourceRevisions.advance(decisionsKey);
  const decisions = files.map((file) => file.decision);
  for (const d of decisions) {
    if (!knownDecisions.has(d.id)) {
      knownDecisions.add(d.id);
      handler?.onDecisionNew(d);
    }
  }
  // Clean up resolved decisions
  const currentIds = new Set(decisions.map((d) => d.id));
  for (const id of knownDecisions) {
    if (!currentIds.has(id)) knownDecisions.delete(id);
  }
}

// Decision files sit one or two directories below a task root (<root>/<task>/ or
// <root>/<kind>/<task>/). Walking every artifact tree of every historical task made
// each decisions.list read ~50k entries and starved the gateway's file I/O.
const DECISION_SCAN_MAX_DEPTH = 3;
let listingFileDecisions: Promise<FileDecision[]> | null = null;

export async function loadPendingDecisions(): Promise<PendingDecision[]> {
  // Concurrent list calls share one scan instead of stacking walks.
  listingFileDecisions ??= loadFileDecisions().finally(() => {
    listingFileDecisions = null;
  });
  return (await listingFileDecisions).map((file) => file.decision);
}

async function loadFileDecisions(): Promise<FileDecision[]> {
  const decisions: FileDecision[] = [];

  // Scan all project task directories for .pending_decision.json files
  for (const { root } of await projectTaskRoots()) {
    await scanDirForDecisions(root, decisions, 0);
  }

  return decisions;
}

/** Resolve through the owning reader so explicit ids delete their actual source file. */
export async function resolveFileDecision(decisionId: string, actionId: string): Promise<void> {
  const file = (await loadFileDecisions()).find((entry) => entry.decision.id === decisionId);
  if (!file) throw new Error(`Decision not found: ${decisionId}`);
  if (!file.decision.actions.some((action) => action.id === actionId))
    throw new Error(`Action not found: ${actionId}`);
  try {
    await unlink(file.path);
  } catch (error) {
    // Another resolver may have removed the same decision after this read.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  knownDecisionFiles.delete(file.path);
  resourceRevisions.advance(decisionsKey);
}

async function scanDirForDecisions(
  dir: string,
  results: FileDecision[],
  depth: number,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // A project can have no task folder yet, or remove one between scans.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < DECISION_SCAN_MAX_DEPTH) await scanDirForDecisions(fullPath, results, depth + 1);
    } else if (entry.name === '.pending_decision.json') {
      let content: string;
      try {
        content = await readFile(fullPath, 'utf-8');
      } catch (error) {
        // A resolved decision may disappear after the directory listing.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const raw = JSON.parse(content);
      const decision: PendingDecision = {
        id: raw.id || fullPath,
        type: raw.type || 'blocked_alert',
        slotId: raw.slot_id || null,
        title: raw.title || 'Unknown',
        description: raw.description || '',
        context: raw.context || {},
        actions: (raw.actions || []).map((a: any) => ({
          id: a.id,
          label: a.label,
          style: a.style || 'primary',
          ...(typeof a.description === 'string' ? { description: a.description } : {}),
        })),
        createdAt: raw.created_at || new Date().toISOString(),
        ...(raw.payload ? { payload: raw.payload } : {}),
      };
      results.push({
        path: fullPath,
        decision,
        signature: createHash('sha256').update(content).digest('hex'),
      });
    }
  }
}

// ─── Violation detection ───

// Track notified slot/type pairs to avoid spamming the same violation every poll.
const notifiedSlots = new Set<string>();

function violationKey(slotId: string, type: MonitorViolation['type']): string {
  return `${slotId}:${type}`;
}

function maybeRecordViolation(
  notified: Set<string>,
  violations: MonitorViolation[],
  slot: SlotStatus,
  type: MonitorViolation['type'],
  message: string,
  timestamp: string,
): void {
  const key = violationKey(slot.slot, type);
  if (notified.has(key)) return;
  notified.add(key);
  violations.push({
    slotId: slot.slot,
    type,
    message,
    nudgeSent: null,
    timestamp,
  });
}

export function detectFleetMonitorViolations(
  fleet: FleetStatus,
  notified: Set<string> = notifiedSlots,
  now: () => string = () => new Date().toISOString(),
): MonitorViolation[] {
  const violations: MonitorViolation[] = [];
  for (const slot of fleet.slots) {
    const observedAt = now();
    const observedAtMs = Date.parse(observedAt);
    // Preparing/dispatching recreate tmux; review-gate and releasing may have
    // none. "tmux gone" only means a worker vanished after we expected one.
    const stuckActive =
      slot.lifecycle === 'busy' && slot.phase === 'working' && slot.agent === 'no-tmux';
    if (stuckActive) {
      maybeRecordViolation(
        notified,
        violations,
        slot,
        'stuck',
        `Slot ${slot.slot} worker finished (tmux gone) — needs review or release`,
        observedAt,
      );
    } else {
      notified.delete(violationKey(slot.slot, 'stuck'));
    }

    // Preparing and dispatching slots legitimately have no runner process yet;
    // review gates legitimately have no active worker. Only the working phase
    // promises that an agent should be running.
    const structuredAgentWorking = slot.agentContexts?.some((context) => {
      if (!slot.currentRunId || context.runId !== slot.currentRunId) return false;
      if (context.status !== 'launching' && context.status !== 'working') return false;
      const contextActivityAt = Date.parse(context.lastSignalAt ?? context.updatedAt ?? '');
      return (
        Number.isFinite(observedAtMs) &&
        Number.isFinite(contextActivityAt) &&
        observedAtMs - contextActivityAt <= ACTIVE_CONTEXT_FRESH_MS
      );
    });
    const idleActive =
      slot.lifecycle === 'busy' &&
      slot.phase === 'working' &&
      slot.agent === 'idle' &&
      !structuredAgentWorking;
    if (idleActive) {
      maybeRecordViolation(
        notified,
        violations,
        slot,
        'idle',
        `Slot ${slot.slot} is "working" but agent is idle — may need attention`,
        observedAt,
      );
    } else {
      notified.delete(violationKey(slot.slot, 'idle'));
    }
  }
  return violations;
}

function checkForViolations(fleet: FleetStatus): void {
  for (const violation of detectFleetMonitorViolations(fleet)) {
    handler?.onViolation(violation);
  }
}
