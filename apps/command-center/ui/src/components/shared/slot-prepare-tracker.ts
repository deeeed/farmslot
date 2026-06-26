import { Events } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

import {
  appendPrepareOutput,
  createPrepareProgressState,
  type PrepareProgressState,
  recordPrepareStep,
} from './prepare-progress-model.js';

type Listener = () => void;

const sessionsBySlot = new Map<string, PrepareProgressState>();
const listeners = new Set<Listener>();
const clearTimersBySlot = new Map<string, number>();

let wired = false;
const requestIds = new Set<string>();

function notify(): void {
  for (const listener of listeners) notifyOne(listener);
}

function notifyOne(listener: Listener): void {
  listener();
}

function setSession(state: PrepareProgressState): void {
  sessionsBySlot.set(state.slotId, state);
  requestIds.add(state.requestId);
  notify();
}

export function subscribeSlotPrepareTracker(listener: Listener): () => void {
  ensureSlotPrepareTrackerWired();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function activeSlotPrepare(slotId: string): PrepareProgressState | null {
  return sessionsBySlot.get(slotId) ?? null;
}

export function beginSlotPrepareSession(args: {
  slotId: string;
  requestId: string;
  label?: string;
}): PrepareProgressState {
  ensureSlotPrepareTrackerWired();
  cancelSlotPrepareSessionClear(args.slotId);
  const state = createPrepareProgressState(args);
  setSession(state);
  return state;
}

export function clearSlotPrepareSession(slotId: string): void {
  cancelSlotPrepareSessionClear(slotId);
  const prev = sessionsBySlot.get(slotId);
  if (prev) requestIds.delete(prev.requestId);
  sessionsBySlot.delete(slotId);
  notify();
}

export function scheduleSlotPrepareSessionClear(slotId: string, delayMs: number): void {
  cancelSlotPrepareSessionClear(slotId);
  const timer = window.setTimeout(() => {
    clearTimersBySlot.delete(slotId);
    clearSlotPrepareSession(slotId);
  }, delayMs);
  clearTimersBySlot.set(slotId, timer);
}

function cancelSlotPrepareSessionClear(slotId: string): void {
  const timer = clearTimersBySlot.get(slotId);
  if (timer) clearTimeout(timer);
  clearTimersBySlot.delete(slotId);
}

function ensureSlotPrepareTrackerWired(): void {
  if (wired) return;
  wired = true;
  gateway.subscribe(Events.SCRIPT_OUTPUT, (payload: unknown) => {
    const data = payload as { requestId?: string; data?: string };
    if (!data.requestId || !requestIds.has(data.requestId) || !data.data) return;
    const session = [...sessionsBySlot.values()].find((s) => s.requestId === data.requestId);
    if (!session) return;
    const lines = data.data.split('\n').filter((line) => line.length > 0);
    let next = session;
    for (const line of lines) {
      next = appendPrepareOutput(next, line);
    }
    setSession(next);
  });
  gateway.subscribe(Events.SCRIPT_COMPLETE, (payload: unknown) => {
    const data = payload as { requestId?: string; exitCode?: number; error?: string };
    if (!data.requestId || !requestIds.has(data.requestId)) return;
    const session = [...sessionsBySlot.values()].find((s) => s.requestId === data.requestId);
    if (!session) return;
    setSession({
      ...session,
      running: false,
      exitCode: data.exitCode ?? 1,
      error: data.error ?? '',
    });
  });
  gateway.subscribe('slot.prepare.step', (payload: unknown) => {
    const data = payload as { requestId?: string; slotId?: string; name?: string; detail?: string };
    if (!data.requestId || !requestIds.has(data.requestId) || !data.name) return;
    const session =
      sessionsBySlot.get(data.slotId ?? '') ??
      [...sessionsBySlot.values()].find((s) => s.requestId === data.requestId);
    if (!session) return;
    setSession(recordPrepareStep(session, data.name, data.detail ?? ''));
  });
}
