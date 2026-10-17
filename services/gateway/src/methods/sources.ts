import path from 'node:path';

import type {
  SourceLock,
  SourceMaterialization,
  SourceNodeStatus,
  SourcesPinParams,
  SourcesPinResult,
  SourcesStatusParams,
  SourcesStatusResult,
  SourcesSyncParams,
  SourcesSyncResult,
  SourcesUnpinParams,
} from '@farmslot/protocol';
import { assertSourceAttestation } from '@farmslot/slot-config/sources';

import { getNode } from '../fleet/machine-registry.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';
import { loadPoolConfigs } from '../fleet/state.js';
import { getRun } from '../runs/store.js';
import { advanceSourceRevision } from '../sources/change-signal.js';
import { assertSourcePinTarget } from '../sources/pin-target.js';
import {
  gatewaySourceStatus,
  mutateSourcePin,
  projectContext,
  sourceAuthority,
} from '../sources/runtime.js';
import { SourceSyncOperations } from '../sources/sync-operations.js';

let operations: SourceSyncOperations | undefined;

export interface SourceMutationCaller {
  principalId: string;
  authorize: () => void;
}

export const sourcesPin = (
  params: SourcesPinParams,
  caller: SourceMutationCaller,
): Promise<SourcesPinResult> =>
  mutateSourcePin(params, caller.principalId, 'branch', caller.authorize);

export const sourcesUnpin = (
  params: SourcesUnpinParams,
  caller: SourceMutationCaller,
): Promise<SourcesPinResult> =>
  mutateSourcePin(params, caller.principalId, 'main', caller.authorize);

/** Status never fetches, materializes, repairs or acknowledges source state. */
export async function sourcesStatus(params: SourcesStatusParams): Promise<SourcesStatusResult> {
  if (params.runId && params.nodeId) throw new Error('Select a run or node, not both');
  const run = params.runId ? getRun(params.runId) : undefined;
  if (params.runId && !run) throw new Error(`Run not found: ${params.runId}`);
  const recordedLock = run?.sourceProvenance?.lock ?? run?.sourcePlan?.lock;
  const authority = sourceAuthority();
  let runSelection: Pick<
    NonNullable<SourcesStatusResult['runSource']>,
    'canSelectSources' | 'selectionRefusal'
  > = {};
  if (run) {
    try {
      if (!authority) throw new Error('Sources are not configured; retained inputs are read-only.');
      assertSourcePinTarget(
        { scope: 'run', targetId: run.id },
        {
          knownNodes: [],
          activatedAt: authority.activatedAt(),
          run,
        },
      );
      runSelection = { canSelectSources: true };
    } catch (error) {
      // Read-only targets stay visible with the authoritative reason for refusing edits.
      runSelection = { canSelectSources: false, selectionRefusal: (error as Error).message };
    }
  }
  const runSource: SourcesStatusResult['runSource'] = run
    ? {
        ...runSelection,
        runId: run.id,
        state: run.sourceProvenance ? 'locked' : run.sourcePlan ? 'planned' : 'unknown-legacy',
        lockDigest: recordedLock?.digest,
        attemptId: run.sourceProvenance?.attemptId,
      }
    : undefined;
  if (!authority)
    return {
      configured: false,
      ...(runSource ? { runSource } : {}),
      declarations: [],
      resolutions: [],
      locks: recordedLock ? [recordedLock] : [],
      nodes: [],
      errors: [],
    };
  if (
    params.sourceId &&
    !authority.configuration.sources.some((source) => source.id === params.sourceId) &&
    !recordedLock?.entries.some((entry) => entry.sourceId === params.sourceId)
  )
    throw new Error(`Undeclared source: ${params.sourceId}`);
  const selected = (id: string) => !params.sourceId || params.sourceId === id;
  const nodes: SourceNodeStatus[] = [];
  const gatewayStatus = await gatewaySourceStatus();
  if (gatewayStatus) nodes.push(gatewayStatus);
  const errors: SourcesStatusResult['errors'] = [];
  for (const pin of authority.pins()) {
    if (selected(pin.sourceId) && pin.declarationRevision !== authority.configuration.revision)
      errors.push({
        sourceId: pin.sourceId,
        reason: 'Source pin belongs to a prior declaration; select the branch or main again.',
      });
  }
  let effectiveNodeId =
    params.nodeId ??
    run?.sourceProvenance?.lock.context.nodeId ??
    run?.sourcePlan?.lock.context.nodeId ??
    run?.reviewWorkspaceTarget?.machine;
  if (!effectiveNodeId && run?.slotId) {
    try {
      const pool = (await loadPoolConfigs()).find((pool) =>
        pool.slots.some((slot) => slot.id === run.slotId),
      );
      if (!pool) throw new Error('The retained slot has no configured execution node');
      effectiveNodeId = pool.machine;
    } catch (error) {
      // Retained run provenance stays readable when its former slot no longer exists.
      errors.push({
        project: run.project,
        reason: `Run source node is unknown: ${(error as Error).message}`,
      });
    }
  }
  const nodeIds = effectiveNodeId
    ? [effectiveNodeId]
    : (await loadPoolConfigs()).map((pool) => pool.machine);
  const reports = await Promise.all(
    nodeIds.map(async (nodeId) => {
      const node = getNode(nodeId);
      try {
        if (!node) throw new Error('Execution node is disconnected');
        const status = (await sendNodeRequest(
          node,
          'sources.status',
          {},
          { timeout: 15_000, requireSameConnection: true },
        )) as SourceNodeStatus;
        if (status.nodeId !== nodeId)
          throw new Error('Source status belongs to another execution node');
        return { node: status };
      } catch (error) {
        // Preserve each node's refusal while independent reports finish concurrently.
        return { error: { nodeId, reason: (error as Error).message } };
      }
    }),
  );
  for (const report of reports) {
    if (report.node) nodes.push(report.node);
    else errors.push(report.error);
  }

  return {
    configured: true,
    ...(runSource ? { runSource } : {}),
    declarationRevision: authority.configuration.revision,
    pinRevision: authority.pinRevision(),
    pins: authority.pins().filter((pin) => selected(pin.sourceId)),
    effectiveSelections:
      run?.slotId && !effectiveNodeId
        ? []
        : authority
            .effectiveSelections({ runId: run?.id, nodeId: effectiveNodeId })
            .filter((entry) => selected(entry.sourceId)),
    declarations: authority.configuration.sources.filter((source) => selected(source.id)),
    resolutions: authority.resolutions().filter((entry) => selected(entry.sourceId)),
    locks: run
      ? run.sourceProvenance
        ? [run.sourceProvenance.lock]
        : run.sourcePlan
          ? [run.sourcePlan.lock]
          : []
      : authority.locks().filter((lock) => !params.nodeId || lock.context.nodeId === params.nodeId),
    nodes,
    errors,
  };
}

/** The same authority backs polling and explicit reconciliation. No service/slot actions. */
export async function sourcesSync(
  params: SourcesSyncParams,
  caller: SourceMutationCaller,
): Promise<SourcesSyncResult> {
  caller.authorize();
  const authority = sourceAuthority();
  if (!authority) throw new Error('Sources are not configured');
  operations ??= new SourceSyncOperations(path.join(authority.root, 'operations'));
  const result = await operations.execute(
    params,
    async () => {
      caller.authorize();
      if (
        !params.operationId ||
        params.expectedDeclarationRevision !== authority.configuration.revision
      )
        throw new Error('Stale source declaration revision or missing operation identity');
      const configuredNodes = (await loadPoolConfigs()).map((pool) => pool.machine);
      if (params.nodeId && !configuredNodes.includes(params.nodeId))
        throw new Error(`Unknown source node target: ${params.nodeId}`);
      await authority.reconcile(params.sourceId ? [params.sourceId] : undefined);
      const locks: SourceLock[] = [];
      const errors: SourcesSyncResult['errors'] = [];
      const nodeIds = params.nodeId ? [params.nodeId] : configuredNodes;
      for (const nodeId of nodeIds) {
        for (const project of authority.affectedProjects(params.sourceId, { nodeId })) {
          try {
            const context = await projectContext(project, { nodeId });
            locks.push(context.materialization.lock);
          } catch (error) {
            errors.push({
              nodeId,
              project,
              sourceId: params.sourceId,
              reason: (error as Error).message,
            });
          }
        }
      }
      return {
        locks,
        nodeIds,
        errors,
      };
    },
    async (plan) => {
      caller.authorize();
      const errors = [...(plan.errors ?? [])];
      for (const lock of plan.locks)
        for (const nodeId of plan.nodeIds.filter(
          (id) => !lock.context.nodeId || lock.context.nodeId === id,
        )) {
          const node = getNode(nodeId);
          try {
            if (!node) throw new Error(`Source node is disconnected: ${nodeId}`);
            caller.authorize();
            const result = (await sendNodeRequest(
              node,
              'sources.materialize',
              { lock },
              { timeout: 120_000, requireSameConnection: true },
            )) as SourceMaterialization;
            assertSourceAttestation(lock, nodeId, result);
          } catch (error) {
            errors.push({
              nodeId,
              project: lock.context.project,
              reason: (error as Error).message,
            });
          }
        }
      caller.authorize();
      const status = await sourcesStatus({ nodeId: params.nodeId });
      return {
        ...status,
        errors: [...errors, ...status.errors],
        operationId: params.operationId,
      };
    },
  );
  // Node receipts and locks from this sync are readable now; open panels reread.
  advanceSourceRevision();
  caller.authorize();
  return result;
}
