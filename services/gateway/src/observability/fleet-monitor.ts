// monitor.ts — Server-side slot monitoring (replaces session-bound crons)
// Periodic fleet refresh + decision detection

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  FleetStatus,
  MonitorViolation,
  PendingDecision,
  SlotStatus,
} from '@farmslot/protocol';

import { farmslotRoot, loadFleetStatus } from '../fleet/state.js';

import { isWorkerMonitorPhase } from './worker-monitor-phase.js';

const MONITOR_STATE_FILE = path.join(farmslotRoot, '.monitor_state.json');

export type MonitorEventHandler = {
  onFleetUpdated: (fleet: FleetStatus) => void;
  onDecisionNew: (decision: PendingDecision) => void;
  onViolation: (violation: MonitorViolation) => void;
};

const FLEET_POLL_MS = readIntervalMs('FARMSLOT_MONITOR_FLEET_POLL_MS', 30_000);
const DECISION_POLL_MS = readIntervalMs('FARMSLOT_MONITOR_DECISION_POLL_MS', 30_000);

let fleetTimer: ReturnType<typeof setInterval> | null = null;
let decisionTimer: ReturnType<typeof setInterval> | null = null;
let persistTimer: ReturnType<typeof setInterval> | null = null;
let fleetPollInFlight = false;
let decisionPollInFlight = false;
let knownDecisions = new Set<string>();
let handler: MonitorEventHandler | null = null;

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
      const fleet = await loadFleetStatus(true);
      handler?.onFleetUpdated(fleet);
      checkForViolations(fleet);
    } catch {
      /* ignore refresh errors */
    } finally {
      fleetPollInFlight = false;
    }
  }, FLEET_POLL_MS);
  fleetTimer.unref();

  // Decision scan loop
  decisionTimer = setInterval(async () => {
    if (decisionPollInFlight) return;
    decisionPollInFlight = true;
    try {
      await scanDecisions();
    } catch {
      /* ignore scan errors */
    } finally {
      decisionPollInFlight = false;
    }
  }, DECISION_POLL_MS);
  decisionTimer.unref();

  // Initial scan
  scanDecisions();

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

async function scanDecisions(): Promise<void> {
  const decisions = await loadPendingDecisions();
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

export async function loadPendingDecisions(): Promise<PendingDecision[]> {
  const decisions: PendingDecision[] = [];

  // Scan all project task directories for .pending_decision.json files
  const projectsDir = path.join(farmslotRoot, 'projects');
  try {
    const projects = await readdir(projectsDir);
    for (const project of projects) {
      const tasksDir = path.join(projectsDir, project, 'tasks');
      try {
        await scanDirForDecisions(tasksDir, decisions);
      } catch {
        /* no tasks dir */
      }
    }
  } catch {
    /* no projects dir */
  }

  return decisions;
}

async function scanDirForDecisions(dir: string, results: PendingDecision[]): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDirForDecisions(fullPath, results);
      } else if (entry.name === '.pending_decision.json') {
        try {
          const content = await readFile(fullPath, 'utf-8');
          const raw = JSON.parse(content);
          results.push({
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
            })),
            createdAt: raw.created_at || new Date().toISOString(),
          });
        } catch {
          /* invalid json */
        }
      }
    }
  } catch {
    /* dir not readable */
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
    const workerMonitor = isWorkerMonitorPhase(slot);
    const stuckActive = workerMonitor && slot.agent === 'no-tmux';
    if (stuckActive) {
      maybeRecordViolation(
        notified,
        violations,
        slot,
        'stuck',
        `Slot ${slot.slot} worker finished (tmux gone) — needs review or release`,
        now(),
      );
    } else {
      notified.delete(violationKey(slot.slot, 'stuck'));
    }

    const idleActive = workerMonitor && slot.agent === 'idle';
    if (idleActive) {
      maybeRecordViolation(
        notified,
        violations,
        slot,
        'idle',
        `Slot ${slot.slot} monitor phase but agent is idle — may need attention`,
        now(),
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
