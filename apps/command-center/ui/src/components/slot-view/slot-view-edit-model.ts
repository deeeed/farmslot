import type { Draft, DraftState } from '@farmslot/local-store/drafts';
import {
  type FsConflictDetails,
  FsErrorCodes,
  type NodeInfo,
  openHumanGateDecision,
  type Run,
  type SlotStatus,
} from '@farmslot/protocol';
import { verifyResourceContent } from '@farmslot/protocol/client-cache';

/** The one host check (ADR-009 Amendment 1): the gateway checks local slots, the node remote ones. */
export function slotConditionalWrites(
  slot: Pick<SlotStatus, 'machine' | 'health'> | null | undefined,
  nodes: readonly Pick<NodeInfo, 'machine' | 'conditionalWrites'>[] | undefined,
): boolean {
  if (!slot) return false;
  if (slot.health.ssh === 'LOCAL') return true;
  return Boolean(
    nodes?.some((node) => node.machine === slot.machine && node.conditionalWrites === true),
  );
}

/** Why the editor is read-only; the proof reads it from `data-reason`. */
export type SlotViewReadOnlyReason =
  | 'offline'
  | 'capability'
  | 'host'
  | 'hash'
  | 'encoding'
  | 'stale-run';

/**
 * Decision 4: editable only with the capability, a host that checks hashes, and a current read
 * whose hash is the SHA-256 of the received text as UTF-8. A read without a hash, a non-UTF-8 file
 * whose text does not round-trip, and a workspace shown for a run the slot no longer serves stay
 * read-only. Undefined means editable.
 */
export function slotViewReadOnlyReason(input: {
  connected: boolean;
  capability: boolean;
  host: boolean;
  ready: boolean;
  content: string | undefined;
  hash: string | undefined;
  staleRun?: boolean;
}): SlotViewReadOnlyReason | undefined {
  if (!input.connected) return 'offline';
  if (!input.capability) return 'capability';
  if (!input.host) return 'host';
  if (input.staleRun) return 'stale-run';
  if (!input.ready || input.content === undefined || !input.hash) return 'hash';
  // The artifact identity is the SHA-256 of the raw bytes, the hash `fs.read` reports.
  const matches = verifyResourceContent(
    { kind: 'artifact', id: input.hash },
    new TextEncoder().encode(input.content),
  );
  return matches ? undefined : 'encoding';
}

/** Autosave runs only on a slot record ready on the current connection that is not `busy`. */
export function slotViewAutosaveAllowed(input: {
  fleetCurrent: boolean;
  slot: Pick<SlotStatus, 'lifecycle'> | null | undefined;
  /** A draft restored after a reload or reconnect waits for its first explicit save. */
  armed: boolean;
}): boolean {
  return (
    input.armed && input.fleetCurrent && Boolean(input.slot) && input.slot?.lifecycle !== 'busy'
  );
}

/** At a pending gate a save changes the reviewed package, which then needs a new review. */
export function slotViewGateWarning(
  run: Pick<Run, 'decisions'> | null | undefined,
  slot: Pick<SlotStatus, 'phase'> | null | undefined,
): boolean {
  return Boolean(openHumanGateDecision(run)) || slot?.phase === 'review-gate';
}

/**
 * Drafts rules 3 and 4: hidden while the slot cannot be read, read-only once its run is no longer
 * the slot's. Without a ready fleet record the state stays as it was, unless a read was refused.
 */
export function slotViewDraftState(
  draft: Pick<Draft, 'slotId' | 'runId'>,
  fleet: {
    ready: boolean;
    slots: readonly Pick<SlotStatus, 'slot' | 'currentRunId'>[];
  },
  refused: ReadonlySet<string>,
): DraftState | undefined {
  if (refused.has(draft.slotId)) return 'hidden';
  if (!fleet.ready) return undefined;
  const slot = fleet.slots.find((candidate) => candidate.slot === draft.slotId);
  if (!slot) return 'hidden';
  return (slot.currentRunId ?? null) === draft.runId ? 'current' : 'stale-run';
}

export type SlotViewSaveRefusal =
  | { kind: 'hash'; currentHash: string | null }
  | { kind: 'run'; currentRunId: string | null }
  | { kind: 'destination-exists' }
  | { kind: 'unsupported' };

function isFsConflictDetails(value: unknown): value is FsConflictDetails {
  if (!value || typeof value !== 'object') return false;
  const reason = Reflect.get(value, 'reason');
  return reason === 'hash' || reason === 'run' || reason === 'destination-exists';
}

/**
 * The refusals a conditional write can return (ADR-009 Amendment 1): the file changed, the slot
 * serves another run, a guarded rename's destination exists, or the host checks no hashes.
 */
export function slotViewSaveRefusal(error: unknown): SlotViewSaveRefusal | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = Reflect.get(error, 'code');
  if (code === FsErrorCodes.preconditionUnsupported) return { kind: 'unsupported' };
  if (code !== FsErrorCodes.conflict) return undefined;
  const details = Reflect.get(error, 'details');
  if (!isFsConflictDetails(details)) return { kind: 'hash', currentHash: null };
  if (details.reason === 'run') return { kind: 'run', currentRunId: details.currentRunId ?? null };
  if (details.reason === 'destination-exists') return { kind: 'destination-exists' };
  return { kind: 'hash', currentHash: details.currentHash ?? null };
}

/** A read refused for the user's access hides the slot's drafts (decision 6). */
export function slotViewReadRefused(error: unknown): boolean {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  return code === 'AUTH_FORBIDDEN' || code === 'AUTH_REQUIRED';
}
