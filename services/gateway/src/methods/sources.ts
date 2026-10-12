import path from 'node:path';

import type {
  SourceMaterialization,
  SourceNodeStatus,
  SourcesStatusParams,
  SourcesStatusResult,
  SourcesSyncParams,
  SourcesSyncResult,
} from '@farmslot/protocol';
import { assertSourceAttestation } from '@farmslot/slot-config/sources';

import { getAllNodes, getNode } from '../fleet/machine-registry.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';
import { getRun } from '../runs/store.js';
import { gatewaySourceStatus, projectContext, sourceAuthority } from '../sources/runtime.js';
import { SourceSyncOperations } from '../sources/sync-operations.js';

let operations: SourceSyncOperations | undefined;

/** Status never fetches, materializes, repairs or acknowledges source state. */
export async function sourcesStatus(params: SourcesStatusParams): Promise<SourcesStatusResult> {
  if (params.runId && params.nodeId) throw new Error('Select a run or node, not both');
  const authority = sourceAuthority();
  if (!authority)
    return {
      configured: false,
      declarations: [],
      resolutions: [],
      locks: [],
      nodes: [],
      errors: [],
    };
  const run = params.runId ? getRun(params.runId) : undefined;
  if (params.runId && !run) throw new Error(`Run not found: ${params.runId}`);
  if (
    params.sourceId &&
    !authority.configuration.sources.some((source) => source.id === params.sourceId)
  )
    throw new Error(`Undeclared source: ${params.sourceId}`);
  const selected = (id: string) => !params.sourceId || params.sourceId === id;
  const nodes: SourceNodeStatus[] = [];
  const gatewayStatus = await gatewaySourceStatus();
  if (gatewayStatus) nodes.push(gatewayStatus);
  const errors: SourcesStatusResult['errors'] = [];
  const nodeIds = params.nodeId ? [params.nodeId] : getAllNodes().map((node) => node.machine);
  for (const nodeId of nodeIds) {
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
      nodes.push(status);
    } catch (error) {
      // Preserve per-node refusal facts without disguising the other nodes' status.
      errors.push({ nodeId, reason: (error as Error).message });
    }
  }
  return {
    configured: true,
    ...(run
      ? {
          runSource: {
            runId: run.id,
            state: run.sourceProvenance ? ('locked' as const) : ('unknown-legacy' as const),
            lockDigest: run.sourceProvenance?.lock.digest,
            attemptId: run.sourceProvenance?.attemptId,
          },
        }
      : {}),
    declarationRevision: authority.configuration.revision,
    declarations: authority.configuration.sources.filter((source) => selected(source.id)),
    resolutions: authority.resolutions().filter((entry) => selected(entry.sourceId)),
    locks: run ? (run.sourceProvenance ? [run.sourceProvenance.lock] : []) : authority.locks(),
    nodes,
    errors,
  };
}

/** The same authority backs polling and explicit reconciliation. No service/slot actions. */
export async function sourcesSync(params: SourcesSyncParams): Promise<SourcesSyncResult> {
  const authority = sourceAuthority();
  if (!authority) throw new Error('Sources are not configured');
  if (
    !params.operationId ||
    params.expectedDeclarationRevision !== authority.configuration.revision
  )
    throw new Error('Stale source declaration revision or missing operation identity');
  operations ??= new SourceSyncOperations(path.join(authority.root, 'operations'));
  return operations.execute(
    params,
    async () => {
      await authority.reconcile(params.sourceId ? [params.sourceId] : undefined);
      const locks = [];
      const errors: SourcesSyncResult['errors'] = [];
      for (const project of authority.affectedProjects(params.sourceId)) {
        try {
          const context = await projectContext(project);
          locks.push(context.materialization.lock);
        } catch (error) {
          errors.push({ project, sourceId: params.sourceId, reason: (error as Error).message });
        }
      }
      return {
        locks,
        nodeIds: params.nodeId ? [params.nodeId] : getAllNodes().map((node) => node.machine),
        errors,
      };
    },
    async (plan) => {
      const errors = [...(plan.errors ?? [])];
      for (const lock of plan.locks)
        for (const nodeId of plan.nodeIds) {
          const node = getNode(nodeId);
          try {
            if (!node) throw new Error(`Source node is disconnected: ${nodeId}`);
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
      const status = await sourcesStatus({ nodeId: params.nodeId });
      return {
        ...status,
        errors: [...errors, ...status.errors],
        operationId: params.operationId,
      };
    },
  );
}
