import type { TmuxWorkerRef } from '@farmslot/protocol';
import type { CompanionViewLocation } from '@farmslot/protocol/surfaces/view-links';

export function quickVoiceWorkerKey(worker: TmuxWorkerRef): string {
  return JSON.stringify([worker.nodeId, worker.session, worker.target, worker.paneId ?? null]);
}

export function quickVoiceInstruction(context: string, instruction: string): string {
  if (!instruction.trim()) return '';
  return context.trim() ? `${context.trim()}\n\n${instruction.trim()}` : instruction.trim();
}

export interface QuickVoiceBinding {
  key: string;
  scope: string;
}

export interface QuickVoiceTarget extends QuickVoiceBinding {
  ready: boolean;
}

interface QuickVoiceStartInput {
  intent: QuickVoiceBinding;
  target: QuickVoiceTarget | null;
  currentScope: string;
  currentWorkerKey: string;
}

export function quickVoiceMayStart({
  intent,
  target,
  currentScope,
  currentWorkerKey,
}: QuickVoiceStartInput): boolean {
  return Boolean(
    target?.ready &&
    intent.scope === currentScope &&
    target.scope === currentScope &&
    intent.key === target.key &&
    intent.key === currentWorkerKey,
  );
}

/** Sharing overrides selection fields; Voice also retains the source route's context. */
export function quickVoiceLocation(
  route: CompanionViewLocation,
  displayed: CompanionViewLocation,
): CompanionViewLocation {
  return { ...displayed, params: { ...route.params, ...displayed.params } };
}
