// chat/copilot-observer.ts — Always-on fleet observer.
// Taps every gateway event, maintains a rolling log, and broadcasts typed
// observer notifications for warn/error events without writing chat history.
// The UI session is separate — this is the "OS layer" awareness.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type CopilotObserverNotificationPayload,
  Events,
  type MonitorViolation,
  type ObserverAttentionRecommendation,
  type ObserverEvidenceEvent,
  type ObserverEvidenceFilters,
  type ObserverEvidenceQuery,
  type ObserverEvidenceResult,
  type Run,
} from '@farmslot/protocol';

import { getCopilotDir } from './chat-memory.js';

export interface ObservedEvent {
  id: string;
  ts: string;
  type: string;
  severity: 'info' | 'warn' | 'error';
  summary: string;
  slotId?: string;
  runId?: string;
}

type ObserverNotificationEvent = ObservedEvent & { severity: 'warn' | 'error' };
type TimestampedObservedEvent = ObservedEvent & { timestampMs: number };

const MAX_LOG = 200;
const DEFAULT_OBSERVER_EVIDENCE_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_OBSERVER_EVIDENCE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OBSERVER_EVIDENCE_LIMIT = 20;
const MAX_OBSERVER_EVIDENCE_LIMIT = 50;
const MAX_OBSERVER_EVIDENCE_SUMMARY_CHARS = 500;
const MAX_OBSERVER_EVIDENCE_FILTER_CHARS = 200;

const eventLog: ObservedEvent[] = [];
// Track last-seen run status to detect transitions (e.g. running → failed)
const lastRunStatus = new Map<string, string>();
// Track which decisions we've already notified about (prevent spam).
// Persisted under the copilot dir so a gateway restart (especially
// frequent during dev with tsx-watch) doesn't re-notify every blocked-run
// decision that recoverActiveRuns() re-broadcasts.
//
// Stored as `${runId}:${decisionId} → notifiedAt(ms)`. The timestamp lets
// us prune entries for decisions on cancelled / force-completed / deleted
// runs that never emit RUN_DECISION_RESOLVED — without it the persisted
// file grows unbounded forever.
const notifiedDecisions = new Map<string, number>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 1000;
const NOTIFIED_DECISION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const NOTIFIED_DECISION_MAX_ENTRIES = 500;

function notifiedDecisionsPath(): string {
  return path.join(getCopilotDir(), 'notified-decisions.json');
}

async function loadNotifiedDecisions(): Promise<void> {
  const filePath = notifiedDecisionsPath();
  if (!existsSync(filePath)) return;
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const now = Date.now();
    let loaded = 0;
    let expired = 0;
    if (Array.isArray(parsed)) {
      // Legacy shape: bare string[] from earlier persisted versions. Treat
      // every entry as "just notified" so it still dedups — they'll age out
      // naturally on the next prune.
      for (const id of parsed) {
        if (typeof id === 'string') {
          notifiedDecisions.set(id, now);
          loaded++;
        }
      }
    } else if (parsed && typeof parsed === 'object') {
      for (const [id, ts] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof ts !== 'number') continue;
        if (now - ts > NOTIFIED_DECISION_TTL_MS) {
          expired++;
          continue;
        }
        notifiedDecisions.set(id, ts);
        loaded++;
      }
    }
    pruneNotifiedDecisions();
    console.log(`[copilot-observer] loaded ${loaded} notified-decision keys (${expired} expired)`);
  } catch (err) {
    console.warn(`[copilot-observer] notified-decisions load failed: ${(err as Error).message}`);
  }
}

/**
 * Drop entries older than the TTL, then evict oldest until we're under the
 * size cap. Cheap (linear in size) and only runs on persist + load.
 */
function pruneNotifiedDecisions(): void {
  const now = Date.now();
  for (const [id, ts] of notifiedDecisions) {
    if (now - ts > NOTIFIED_DECISION_TTL_MS) notifiedDecisions.delete(id);
  }
  if (notifiedDecisions.size <= NOTIFIED_DECISION_MAX_ENTRIES) return;
  const sorted = [...notifiedDecisions.entries()].sort((a, b) => a[1] - b[1]);
  const dropCount = notifiedDecisions.size - NOTIFIED_DECISION_MAX_ENTRIES;
  for (let i = 0; i < dropCount; i++) notifiedDecisions.delete(sorted[i][0]);
}

function scheduleNotifiedDecisionsPersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    pruneNotifiedDecisions();
    const filePath = notifiedDecisionsPath();
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify(Object.fromEntries(notifiedDecisions), null, 2),
        'utf-8',
      );
    } catch (err) {
      console.warn(
        `[copilot-observer] notified-decisions persist failed: ${(err as Error).message}`,
      );
    }
  }, PERSIST_DEBOUNCE_MS);
}

type BroadcastFn = (event: string, payload: unknown) => void;
let _broadcast: BroadcastFn | null = null;

export function initCopilotObserver(broadcastFn: BroadcastFn): void {
  _broadcast = broadcastFn;
  // Don't block startup; surface any failure rather than swallowing it.
  loadNotifiedDecisions().catch((err) => {
    console.warn(`[copilot-observer] notified-decisions init failed: ${(err as Error).message}`);
  });
  console.log('[copilot-observer] initialized — observing all gateway events');
}

// ─── Called by the observedBroadcast wrapper in index.ts ───

export function routeEventToObserver(type: string, payload: unknown): void {
  try {
    dispatch(type, payload);
  } catch (err) {
    // Observer must never throw — it's a passive tap
    console.error(`[copilot-observer] dispatch error: ${(err as Error).message}`);
  }
}

// ─── Event routing ───

function dispatch(type: string, payload: unknown): void {
  const p = payload as Record<string, unknown>;

  switch (type) {
    case Events.RUN_CREATED: {
      const run = p.run as Run;
      observe(
        'run.created',
        'info',
        `Run ${short(run.id)} dispatched — ${run.flowType} for ${run.ticketOrPr}${run.slotId ? ` on ${run.slotId}` : ''}`,
        { runId: run.id, slotId: run.slotId ?? undefined },
      );
      lastRunStatus.set(run.id, run.status);
      break;
    }

    case Events.RUN_UPDATED: {
      const run = p.run as Run;
      const prev = lastRunStatus.get(run.id);
      lastRunStatus.set(run.id, run.status);

      if (run.status === 'failed' && prev !== 'failed') {
        observe(
          'run.failed',
          'error',
          `Run ${short(run.id)} failed (${run.ticketOrPr}${run.slotId ? `, ${run.slotId}` : ''}): ${run.error ?? 'unknown error'}`,
          { runId: run.id, slotId: run.slotId ?? undefined },
        );
      } else if (run.status === 'cancelled' && prev !== 'cancelled') {
        observe('run.cancelled', 'info', `Run ${short(run.id)} cancelled (${run.ticketOrPr})`, {
          runId: run.id,
          slotId: run.slotId ?? undefined,
        });
      }
      break;
    }

    case Events.RUN_COMPLETED: {
      const run = p.run as Run;
      lastRunStatus.set(run.id, 'done');
      observe(
        'run.completed',
        'info',
        `Run ${short(run.id)} completed — ${run.flowType} for ${run.ticketOrPr}${run.slotId ? ` on ${run.slotId}` : ''}`,
        { runId: run.id, slotId: run.slotId ?? undefined },
      );
      break;
    }

    case Events.RUN_DECISION_NEW: {
      const { runId, decision } = p as {
        runId: string;
        decision: { id: string; description: string };
      };
      const decisionKey = `${runId}:${decision.id}`;
      if (notifiedDecisions.has(decisionKey)) break; // already notified (this lifetime or persisted)
      notifiedDecisions.set(decisionKey, Date.now());
      scheduleNotifiedDecisionsPersist();
      observe(
        'decision.pending',
        'warn',
        `Run ${short(runId)} waiting on decision: "${decision.description.slice(0, 100)}"`,
        { runId },
      );
      break;
    }

    case Events.RUN_DECISION_RESOLVED: {
      const { runId, decisionId } = p as { runId: string; decisionId: string };
      if (notifiedDecisions.delete(`${runId}:${decisionId}`)) {
        scheduleNotifiedDecisionsPersist();
      }
      break;
    }

    case Events.MONITOR_VIOLATION: {
      const v = p.violation as MonitorViolation;
      observe('monitor.violation', 'warn', `${v.slotId}: ${v.message}`, { slotId: v.slotId });
      break;
    }

    // Intentionally ignored (too noisy):
    // FLEET_UPDATED, TASK_PROGRESS_UPDATED, TERMINAL_*, STREAM_*, RUN_STEP_COMPLETED, etc.
  }
}

// ─── Core log + notify ───

function observe(
  type: string,
  severity: ObservedEvent['severity'],
  summary: string,
  meta?: { slotId?: string; runId?: string },
): void {
  const event: ObservedEvent = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    type,
    severity,
    summary,
    ...meta,
  };

  eventLog.push(event);
  if (eventLog.length > MAX_LOG) eventLog.shift();

  console.log(`[copilot-observer] ${severity.toUpperCase()} ${type}: ${summary}`);

  if (severity !== 'info' && _broadcast) {
    pushObserverNotification({ ...event, severity }, _broadcast);
  }
}

function pushObserverNotification(
  event: ObserverNotificationEvent,
  broadcastFn: BroadcastFn,
): void {
  const payload: CopilotObserverNotificationPayload = {
    id: event.id,
    ts: event.ts,
    type: event.type,
    severity: event.severity,
    summary: event.summary,
    ...(event.slotId ? { slotId: event.slotId } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
  };
  broadcastFn(Events.COPILOT_OBSERVER_NOTIFICATION, payload);
}

// ─── Query interface (used by chat-context.ts) ───

export function getRecentEvents(windowMs = 2 * 60 * 60 * 1000): ObservedEvent[] {
  const cutoff = Date.now() - windowMs;
  return eventLog.filter((e) => new Date(e.ts).getTime() > cutoff);
}

export function resetCopilotObserverForTests(): void {
  eventLog.length = 0;
  lastRunStatus.clear();
  _broadcast = null;
}

export function readObserverEvidence(params: ObserverEvidenceQuery = {}): ObserverEvidenceResult {
  const generatedAt = new Date().toISOString();
  const windowMs = clampNumber(
    params.windowMs,
    DEFAULT_OBSERVER_EVIDENCE_WINDOW_MS,
    1_000,
    MAX_OBSERVER_EVIDENCE_WINDOW_MS,
  );
  const limit = clampNumber(
    params.limit,
    DEFAULT_OBSERVER_EVIDENCE_LIMIT,
    1,
    MAX_OBSERVER_EVIDENCE_LIMIT,
  );
  const { filters, truncated: filterTruncated } = normalizeObserverFilters(params);
  const cutoff = Date.now() - windowMs;
  const filterMatched = timestampedEvents(eventLog).filter((event) =>
    matchesObserverFilters(event, filters),
  );
  const matched = filterMatched
    .filter((event) => event.timestampMs > cutoff)
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  const events = matched.slice(0, limit).map(toObserverEvidenceEvent);
  const uncertainty = new Set<ObserverEvidenceResult['uncertainty'][number]>();
  if (matched.length === 0) uncertainty.add('empty');
  if (hasObserverFilters(filters)) uncertainty.add('filtered');
  if (filterTruncated) uncertainty.add('filter-truncated');
  if (matched.length > events.length) uncertainty.add('truncated');
  if (filterMatched.some((event) => event.timestampMs <= cutoff))
    uncertainty.add('events-dropped-by-window');
  if (uncertainty.size === 0) uncertainty.add('none');

  return {
    generatedAt,
    windowMs,
    limit,
    truncated: matched.length > events.length,
    filters,
    events,
    attention: buildAttentionRecommendations(events),
    provenance: ['copilot-observer:event-log'],
    freshness: events.length === 0 ? 'empty' : 'fresh',
    uncertainty: [...uncertainty],
  };
}

function short(id: string): string {
  return id.slice(0, 8);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeObserverFilters(params: ObserverEvidenceQuery): {
  filters: ObserverEvidenceFilters;
  truncated: boolean;
} {
  const filters: ObserverEvidenceFilters = {};
  let truncated = false;
  if (params.severity === 'info' || params.severity === 'warn' || params.severity === 'error') {
    filters.severity = params.severity;
  }
  const type = boundedFilter(params.type);
  if (type) filters.type = type;
  const runId = boundedFilter(params.runId);
  if (runId) filters.runId = runId;
  const slotId = boundedFilter(params.slotId);
  if (slotId) filters.slotId = slotId;
  for (const value of [params.type, params.runId, params.slotId]) {
    if (typeof value === 'string' && value.trim().length > MAX_OBSERVER_EVIDENCE_FILTER_CHARS)
      truncated = true;
  }
  return { filters, truncated };
}

function boundedFilter(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_OBSERVER_EVIDENCE_FILTER_CHARS);
}

function hasObserverFilters(filters: ObserverEvidenceFilters): boolean {
  return Boolean(filters.severity || filters.type || filters.runId || filters.slotId);
}

function timestampedEvents(events: ObservedEvent[]): TimestampedObservedEvent[] {
  return events.flatMap((event) => {
    const timestampMs = new Date(event.ts).getTime();
    return Number.isFinite(timestampMs) ? [{ ...event, timestampMs }] : [];
  });
}

function matchesObserverFilters(event: ObservedEvent, filters: ObserverEvidenceFilters): boolean {
  if (filters.severity && event.severity !== filters.severity) return false;
  if (filters.type && event.type !== filters.type) return false;
  if (filters.runId && event.runId !== filters.runId) return false;
  if (filters.slotId && event.slotId !== filters.slotId) return false;
  return true;
}

function toObserverEvidenceEvent(event: ObservedEvent): ObserverEvidenceEvent {
  return {
    id: event.id,
    ts: event.ts,
    type: event.type,
    severity: event.severity,
    summary: event.summary.slice(0, MAX_OBSERVER_EVIDENCE_SUMMARY_CHARS),
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.slotId ? { slotId: event.slotId } : {}),
  };
}

function buildAttentionRecommendations(
  events: ObserverEvidenceEvent[],
): ObserverAttentionRecommendation[] {
  return events
    .filter(
      (event): event is ObserverEvidenceEvent & { severity: 'warn' | 'error' } =>
        event.severity === 'warn' || event.severity === 'error',
    )
    .slice(0, 3)
    .map((event) => ({
      id: `observer-${event.type}-${event.id.slice(0, 8)}`,
      severity: event.severity,
      summary: event.summary,
      ...(event.runId ? { runId: event.runId } : {}),
      ...(event.slotId ? { slotId: event.slotId } : {}),
      sourceEventIds: [event.id],
    }));
}
