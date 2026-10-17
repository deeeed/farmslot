import type { SourcesStatusParams, SourcesStatusResult } from '../rpc/sources.js';

import { sourceStatusParamsForTarget } from './client.js';
import type {
  SourceDeclaration,
  SourceLock,
  SourceLockEntry,
  SourceResolution,
} from './contracts.js';
import {
  type SourceEffectiveSelection,
  type SourcePinTarget,
  type SourceSelection,
  validateSourceSelection,
  validateSourceSelections,
} from './pins.js';

export type SourceViewAction = 'sync' | 'pin' | 'unpin';
export const SOURCE_VIEW_ACTION_LABELS: Record<SourceViewAction, string> = {
  sync: 'Sync',
  pin: 'Pin branch',
  unpin: 'Return to main',
};

/** Callers select presentation and actions; the gateway remains the mutation authority. */
export interface SourceStatusViewContext {
  /** Opaque authenticated transport identity supplied by existing host connection authority. */
  connectionKey?: string;
  params?: SourcesStatusParams;
  target?: SourcePinTarget;
  actions: readonly SourceViewAction[];
  selections?: readonly SourceSelection[];
}

export interface SourceStatusRowView {
  /** This source's part of the view's one line. */
  line: string;
  summary: string;
  details: string[];
  declaration: SourceDeclaration;
  effective?: SourceEffectiveSelection;
  resolution?: SourceResolution;
  recordedLocks: Array<{ digest: string; context: SourceLock['context']; entry: SourceLockEntry }>;
  materializations: Array<{
    nodeId: string;
    lockDigest: string;
    commit: string;
    verifiedAt?: string;
    drift: string[];
  }>;
  selection?: SourceSelection;
  selectionErrors: string[];
  canPin: boolean;
}

export interface SourceStatusViewModel {
  configured: boolean;
  /** Render nothing: no declared sources, pins or recorded run inputs in this context. */
  hidden: boolean;
  /** One line naming each source's effective ref, with branch and scope for pins. */
  line: string;
  declarationRevision?: number;
  pinRevision?: number;
  target?: SourcePinTarget;
  actions: SourceViewAction[];
  editable: boolean;
  draft: boolean;
  runSource: SourcesStatusResult['runSource'];
  rows: SourceStatusRowView[];
  selectionErrors: string[];
  errors: SourcesStatusResult['errors'];
}

/** Project reported facts only. Retained generations are never inferred to be drift. */
export function deriveSourceStatusView(
  status: SourcesStatusResult,
  context: SourceStatusViewContext,
): SourceStatusViewModel {
  const params = context.params ?? sourceStatusParamsForTarget(undefined, context.target);
  const canSelect =
    context.target?.scope !== 'run' ||
    (status.runSource?.runId === context.target.targetId &&
      status.runSource.canSelectSources === true);
  const declared = new Map(status.declarations.map((source) => [source.id, source]));
  if (params.runId)
    for (const lock of status.locks) {
      if (lock.context.runId !== params.runId) continue;
      for (const entry of lock.entries)
        if (!declared.has(entry.sourceId))
          declared.set(entry.sourceId, {
            id: entry.sourceId,
            kind: entry.kind,
            repo: entry.repo,
            ref: entry.declaredRef,
          });
    }
  const declarations = [...declared.values()].filter(
    (source) => !params.sourceId || source.id === params.sourceId,
  );
  const hasRevisions =
    Number.isInteger(status.declarationRevision) && Number.isInteger(status.pinRevision);
  const draft = context.selections !== undefined && context.target === undefined;
  const view: SourceStatusViewModel = structuredClone({
    configured: status.configured,
    hidden: false,
    line: '',
    declarationRevision: status.declarationRevision,
    pinRevision: status.pinRevision,
    target: context.target,
    actions: context.actions.filter(
      (action) =>
        status.configured &&
        canSelect &&
        !(action === 'sync' && context.target?.scope === 'run') &&
        (action === 'sync'
          ? Number.isInteger(status.declarationRevision)
          : hasRevisions && Boolean(context.target)),
    ),
    editable:
      status.configured &&
      hasRevisions &&
      canSelect &&
      (context.selections !== undefined || context.actions.includes('pin')),
    draft,
    runSource: status.runSource,
    selectionErrors: validateSourceSelections(context.selections ?? [], status.declarations),
    rows: declarations.map((declaration) => {
      const effective = status.effectiveSelections?.find(
        (selected) => selected.sourceId === declaration.id,
      );
      const selection = context.selections?.find(
        (selected) => selected.sourceId === declaration.id,
      );
      const selectionErrors = selection
        ? validateSourceSelection(selection, status.declarations)
        : [];
      // An empty branch input is not a selection yet.
      const draftRef =
        draft && selection
          ? selection.selection === 'main'
            ? 'main'
            : selection.ref || undefined
          : undefined;
      const draftResolution = draftRef
        ? status.resolutions.find(
            (resolution) =>
              resolution.sourceId === declaration.id &&
              resolution.ref === draftRef &&
              resolution.declarationRevision === status.declarationRevision,
          )
        : undefined;
      const mainResolution = status.resolutions.find(
        (resolution) =>
          resolution.sourceId === declaration.id &&
          resolution.ref === 'main' &&
          resolution.declarationRevision === status.declarationRevision,
      );
      const row: SourceStatusRowFacts = {
        declaration,
        effective,
        resolution: effective
          ? status.resolutions.find(
              (resolution) =>
                resolution.sourceId === declaration.id &&
                resolution.ref === effective.effectiveRef &&
                resolution.declarationRevision === status.declarationRevision,
            )
          : undefined,
        recordedLocks: status.locks
          .filter((lock) => !params.runId || lock.context.runId === params.runId)
          .filter((lock) => !params.nodeId || lock.context.nodeId === params.nodeId)
          .flatMap((lock) =>
            lock.entries
              .filter((entry) => entry.sourceId === declaration.id)
              .map((entry) => ({ digest: lock.digest, context: lock.context, entry })),
          ),
        materializations: status.nodes
          .filter((node) => !params.nodeId || node.nodeId === params.nodeId)
          .flatMap((node) =>
            node.materializations.flatMap((materialization) =>
              materialization.sources
                .filter((source) => source.sourceId === declaration.id)
                .map((source) => ({
                  nodeId: node.nodeId,
                  lockDigest: materialization.lockDigest,
                  commit: source.commit,
                  verifiedAt: materialization.verifiedAt,
                  drift: materialization.drift,
                })),
            ),
          ),
        selection,
        selectionErrors,
        canPin: selection?.selection === 'branch' && selectionErrors.length === 0,
      };
      const locked = status.runSource?.state === 'locked';
      const recorded = locked ? row.recordedLocks[0]?.entry : undefined;
      const visiblePin = locked ? recorded?.pin : row.effective?.pin;
      const ref =
        recorded?.effectiveRef ?? row.effective?.effectiveRef ?? declaration.ref ?? 'main';
      const pinSummary = visiblePin
        ? `; ${visiblePin.selection === 'branch' ? 'pinned' : 'main override'} ${visiblePin.scope}, base main ${visiblePin.baseMainCommit}`
        : '';
      const summary =
        draftRef !== undefined
          ? `${declaration.id} run selection ${draftRef} ${draftResolution?.commit ?? 'unresolved'} ${draftResolution?.status ?? 'unknown'}, reported main base ${mainResolution?.commit ?? 'unresolved'}`
          : recorded
            ? `${declaration.id} run input ${recorded.effectiveRef} ${recorded.commit}${pinSummary}`
            : `${declaration.id} reported ${ref} ${row.resolution?.commit ?? 'unresolved'} ${row.resolution?.status ?? 'unknown'}${pinSummary}`;
      return {
        ...row,
        // A draft names the run selection being prepared, not the farm's current ref.
        line:
          draftRef !== undefined
            ? `${declaration.id} ${draftRef} (run selection)`
            : !visiblePin
              ? `${declaration.id} ${ref}`
              : visiblePin.selection === 'branch'
                ? `${declaration.id} ${ref} (${visiblePin.scope} pin)`
                : `${declaration.id} main (${visiblePin.scope} override)`,
        summary,
        details: [
          ...(draftRef !== undefined
            ? [
                `Draft main base ${mainResolution?.commit ?? 'unresolved'}; creation resolves and captures the selected branch and main again.`,
              ]
            : []),
          ...sourceRowFacts(row),
        ],
      };
    }),
    errors: status.errors,
  });
  view.hidden = view.rows.length === 0 && !status.pins?.length;
  view.line = view.rows.map((row) => row.line).join(' · ');
  return view;
}

type SourceStatusRowFacts = Omit<SourceStatusRowView, 'line' | 'summary' | 'details'>;

/** All renderers describe the same reported locks, pin audit and receipt facts. */
function sourceRowFacts(row: SourceStatusRowFacts): string[] {
  const lines: string[] = [];
  if (row.resolution?.resolvedAt) lines.push(`Ref resolved at ${row.resolution.resolvedAt}`);
  if (row.effective?.pin)
    lines.push(
      `Reported pin ${row.effective.pin.scope} ${row.effective.pin.targetId} ${row.effective.pin.selection}, base main ${row.effective.pin.baseMainCommit}, by ${row.effective.pin.actor} at ${row.effective.pin.createdAt}`,
    );
  for (const pin of row.effective?.shadowedPins ?? [])
    lines.push(`Shadowed ${pin.scope} ${pin.targetId} ${pin.ref}, base main ${pin.baseMainCommit}`);
  for (const recorded of row.recordedLocks)
    lines.push(
      `Recorded lock ${recorded.context.runId ?? recorded.context.nodeId ?? 'farm'} ${recorded.entry.effectiveRef} ${recorded.entry.commit}, scope ${recorded.entry.scope}${recorded.entry.pin ? `, base main ${recorded.entry.pin.baseMainCommit}, by ${recorded.entry.pin.actor} at ${recorded.entry.pin.createdAt}` : ''}, ${recorded.digest}`,
    );
  for (const materialization of row.materializations)
    lines.push(
      `Node receipt ${materialization.nodeId} ${materialization.commit} ${materialization.lockDigest}: ${materialization.drift.length ? materialization.drift.join('; ') : materialization.verifiedAt ? `verified ${materialization.verifiedAt}` : 'unverified'}`,
    );
  return lines;
}
