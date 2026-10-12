import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  Run,
  SourceConfiguration,
  SourceLock,
  SourceMaterialization,
  SourceNodeStatus,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';
import {
  configureProjectSources,
  currentProjectSources,
  loadSlotVars,
  type ProjectSourceContext,
  withLegacyProjectSources,
  withProjectSources,
} from '@farmslot/slot-config';
import {
  assertSourceAttestation,
  sourceDigest,
  SourceMaterializer,
} from '@farmslot/slot-config/sources';

import { getNode } from '../fleet/machine-registry.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';
import { getRun, updateRun } from '../runs/store.js';

import { SourceAuthority } from './authority.js';

let authority: SourceAuthority | undefined;
let gateway: SourceMaterializer | undefined;
let stopReconciliation: (() => void) | undefined;

export class SourceAdmissionRefusal extends Error {
  readonly code = 'SOURCE_ADMISSION_REFUSED';
}

export function sourceAuthority(): SourceAuthority | undefined {
  return authority;
}

export async function gatewaySourceStatus(): Promise<SourceNodeStatus | undefined> {
  return gateway?.status();
}

/** The private farm declaration file is outside every pack it bootstraps. */
export async function initializeSources(): Promise<void> {
  const home = farmslotHome();
  const configFile = process.env.FARMSLOT_SOURCES_CONFIG ?? path.join(home, 'sources.json');
  let configuration: SourceConfiguration;
  try {
    configuration = JSON.parse(await readFile(configFile, 'utf8'));
  } catch (error) {
    // Before staged cut-over, legacy runs remain on their original inputs. Explicit opt-in
    // or prior authority state can never fall back when the declaration file disappears.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || process.env.FARMSLOT_SOURCES_CONFIG)
      throw error;
    try {
      await readFile(path.join(home, 'sources', 'authority.json'));
    } catch (stateError) {
      if ((stateError as NodeJS.ErrnoException).code !== 'ENOENT') throw stateError;
      return;
    }
    throw new Error('Source declarations disappeared after cut-over');
  }
  authority = await SourceAuthority.open(configuration, path.join(home, 'sources'));
  gateway = new SourceMaterializer('gateway', path.join(home, 'sources', 'gateway'));
  // Configure fail-closed reads immediately; each closure becomes available as
  // its own sources finish, without waiting for an unrelated repository.
  configureProjectSources(projectContext, () => Object.keys(configuration.packs));
  stopReconciliation = authority.startReconciliation((id, error) => {
    console.error(`[sources] ${id} persistence failed; admission must reconcile:`, error);
  });
}

export function stopSourceReconciliation(): void {
  stopReconciliation?.();
  stopReconciliation = undefined;
}

export async function projectContext(project: string): Promise<ProjectSourceContext> {
  if (!authority || !gateway) throw new Error('Source authority is unavailable');
  const lock = await authority.lock({ project });
  const materialization = await gateway.materialize(lock);
  return {
    project,
    pack: authority.configuration.packs[project],
    materialization,
    packs: lock.packBindings,
  };
}

export async function withSourcePlanning<T>(
  project: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!authority) return operation();
  let selected: ProjectSourceContext;
  try {
    selected = await projectContext(project);
  } catch (error) {
    throw new SourceAdmissionRefusal((error as Error).message, { cause: error });
  }
  return withProjectSources(selected, operation);
}

async function nodeMaterialization(
  nodeId: string,
  lock: SourceLock,
): Promise<SourceMaterialization> {
  const node = getNode(nodeId);
  if (!node) throw new Error(`Source execution node is disconnected: ${nodeId}`);
  const result = (await sendNodeRequest(
    node,
    'sources.materialize',
    { lock },
    { timeout: 120_000, requireSameConnection: true },
  )) as SourceMaterialization;
  assertSourceAttestation(lock, nodeId, result);
  return result;
}

/** Every step retains its run's generation; new main commits can never replace these inputs. */
export async function withRunSources<T>(run: Run, operation: () => Promise<T>): Promise<T> {
  const provenance = run.sourceProvenance;
  if (!provenance) {
    if (authority && Date.parse(run.createdAt) >= Date.parse(authority.activatedAt()))
      throw new SourceAdmissionRefusal('New run has no admitted source lock');
    return withLegacyProjectSources(run.project, operation);
  }
  if (!authority || !gateway)
    throw new SourceAdmissionRefusal('Locked run cannot execute without the source authority');
  let materialization: SourceMaterialization;
  let execution: SourceMaterialization | undefined;
  let workerExecution: SourceMaterialization;
  let nodeId = run.reviewWorkspaceTarget?.machine;
  try {
    if (
      sourceDigest(provenance.lock.entries) !== sourceDigest(provenance.workerLock.entries) ||
      sourceDigest(provenance.lock.packBindings) !==
        sourceDigest(provenance.workerLock.packBindings)
    )
      throw new Error('Worker inputs do not match the admitted run lock');
    materialization = await gateway.materialize(provenance.lock);
    if (run.slotId) nodeId = (await loadSlotVars(run.slotId)).machine;
    execution = nodeId ? await nodeMaterialization(nodeId, provenance.lock) : undefined;
    workerExecution = nodeId
      ? await nodeMaterialization(nodeId, provenance.workerLock)
      : await gateway.materialize(provenance.workerLock);
  } catch (error) {
    throw new SourceAdmissionRefusal((error as Error).message, { cause: error });
  }
  if (
    execution &&
    (execution.lock.digest !== provenance.lock.digest ||
      execution.receipt.lockDigest !== provenance.lock.digest ||
      execution.receipt.nodeId !== nodeId)
  )
    throw new SourceAdmissionRefusal('Execution node attested a different source lock');
  const receiptIds = [
    ...new Set([
      ...provenance.receiptIds,
      materialization.receipt.id,
      ...(execution ? [execution.receipt.id] : []),
      workerExecution.receipt.id,
    ]),
  ];
  const attemptId = run.recoveryAttempts?.at(-1)?.id ?? `${run.id}:1`;
  const attempts = [...provenance.attempts];
  const existingAttempt = attempts.findIndex((attempt) => attempt.id === attemptId);
  const currentAttempt = {
    id: attemptId,
    receiptIds: [
      ...new Set([
        ...(attempts[existingAttempt]?.receiptIds ?? []),
        materialization.receipt.id,
        ...(execution ? [execution.receipt.id] : []),
        workerExecution.receipt.id,
      ]),
    ],
  };
  if (existingAttempt === -1) attempts.push(currentAttempt);
  else attempts[existingAttempt] = currentAttempt;
  if (receiptIds.length !== provenance.receiptIds.length || provenance.attemptId !== attemptId)
    updateRun(run.id, { sourceProvenance: { ...provenance, attemptId, attempts, receiptIds } });
  return withProjectSources(
    {
      project: run.project,
      pack: provenance.bindings[0],
      materialization,
      execution,
      workerExecution,
      packs: provenance.lock.packBindings,
    },
    operation,
  );
}

/** A live retained process cannot adopt another run's changed or unknown source inputs. */
export function assertRetainedSourceInputs(
  prior: Pick<Run, 'sourceProvenance'> | null | undefined,
  next: Pick<Run, 'sourceProvenance'>,
): void {
  const before = prior?.sourceProvenance;
  const after = next.sourceProvenance;
  if (!before && !after) return;
  if (!before || !after || before.workerLock.digest !== after.workerLock.digest)
    throw new SourceAdmissionRefusal('Retained worker source inputs changed or are unknown');
}

export async function verifyExecutionSources(
  nodeId: string,
  materialization: SourceMaterialization,
): Promise<void> {
  try {
    if (materialization.receipt.nodeId === 'gateway') {
      if (!gateway) throw new Error('Gateway source authority is unavailable');
      await gateway.verify(materialization.lock);
      return;
    }
    const node = getNode(nodeId);
    if (!node || materialization.receipt.nodeId !== nodeId)
      throw new Error('Source execution ownership changed');
    await sendNodeRequest(
      node,
      'sources.verify',
      { lock: materialization.lock },
      { timeout: 30_000, requireSameConnection: true },
    );
  } catch (error) {
    throw new SourceAdmissionRefusal((error as Error).message, { cause: error });
  }
}

/** Slot actions share admission with runs; the target node attests before hooks expand. */
export async function withSlotSources<T>(slotId: string, operation: () => Promise<T>): Promise<T> {
  if (!authority) return operation();
  const slot = await loadSlotVars(slotId);
  const { readSlotField } = await import('../core/state.js');
  const currentRunId = await readSlotField(slotId, 'current_run_id');
  const owner = typeof currentRunId === 'string' ? getRun(currentRunId) : undefined;
  if (owner?.slotId === slotId) return withRunSources(owner, operation);
  const current = currentProjectSources();
  if (current?.execution?.receipt.nodeId === slot.machine) return operation();
  const sources =
    current?.project === slot.projectName ? current : await projectContext(slot.projectName);
  const execution = await nodeMaterialization(slot.machine, sources.materialization.lock);
  if (
    execution.receipt.nodeId !== slot.machine ||
    execution.receipt.lockDigest !== sources.materialization.lock.digest
  )
    throw new SourceAdmissionRefusal('Slot node attested a different source lock');
  return withProjectSources({ ...sources, execution }, operation);
}
