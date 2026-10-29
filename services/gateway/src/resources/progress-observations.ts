import { isLocal } from '../core/exec.js';
import { GatewayMethodError } from '../core/method-error.js';
import { type ConnectedNode, getNode } from '../fleet/machine-registry.js';

import { resourceRevisions } from './revisions.js';

/** Existing domain producers own these receipts; this registry starts no collector or timer. */
export interface ProgressObservationOwner {
  runId: string;
  contextId: string;
  path?: string;
  current(): boolean;
  check(): void;
}
const owners = new Set<ProgressObservationOwner>();

export function registerProgressObservation(owner: ProgressObservationOwner): () => void {
  for (const previous of owners) {
    if (
      !previous.current() ||
      (previous.runId === owner.runId &&
        previous.contextId === owner.contextId &&
        previous.path === owner.path)
    )
      owners.delete(previous);
  }
  owners.add(owner);
  return () => {
    owners.delete(owner);
  };
}

export function hasProgressObservationOwner(runId: string, file: string): boolean {
  return [...owners].some(
    (owner) => owner.runId === runId && owner.path === file && owner.current(),
  );
}

export function assertProgressOwnerAdmitted(
  runId: string,
  contextId?: string,
  file?: string,
): () => void {
  const owner = [...owners].find(
    (entry) =>
      entry.runId === runId &&
      (!contextId || entry.contextId === contextId) &&
      (!file || entry.path === file) &&
      entry.current(),
  );
  if (!owner)
    throw new GatewayMethodError(
      'RESOURCE_OBSERVATION_UNAVAILABLE',
      'The progress source owner is not observing this file.',
    );
  owner.check();
  const revision = resourceRevisions.revision({ family: 'progress', runId });
  return () => {
    if (
      !owners.has(owner) ||
      !owner.current() ||
      resourceRevisions.revision({ family: 'progress', runId }) !== revision
    )
      throw new GatewayMethodError(
        'RESOURCE_OBSERVATION_CHANGED',
        'The progress source changed during the read.',
      );
    owner.check();
  };
}

/** Existing workspace monitor binds remote observations to the actual capable node connection. */
export function captureProgressProducer(io: { host: string; machine: string }): () => void {
  if (isLocal(io.host, io.machine)) return () => {};
  const node: ConnectedNode | undefined = getNode(io.machine);
  if (!node || node.observationCapabilities?.files !== 1)
    throw new GatewayMethodError(
      'RESOURCE_OBSERVATION_UNSUPPORTED',
      `Node ${io.machine} does not support file observations.`,
    );
  const check = () => {
    if (getNode(io.machine) !== node || node.ws.readyState !== 1 || !node.observationAuthority?.())
      throw new GatewayMethodError(
        'RESOURCE_OBSERVATION_UNAVAILABLE',
        'The progress producer disconnected, lost authority or was replaced.',
      );
  };
  check();
  return check;
}
