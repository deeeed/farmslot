/** ADR-008 Amendment 3. Infrastructure identity is independent of runner transport. */
export const NODE_LINK_LIMITS = {
  frameBytes: 1024 * 1024,
  chunkBytes: 64 * 1024,
  queuedBytes: 8 * 1024 * 1024,
  inFlight: 32,
  reservedControl: 8,
  streamBytes: 256 * 1024,
} as const;

export interface NodeLinkCapabilities {
  commands?: 1;
  operations?: import('./node-link-operations.js').NodeLinkOperation[];
  streams?: 1;
}

export interface NodeLinkPrincipal {
  principalId: string;
  generation: number;
}

export interface NodeLinkLease {
  runId: string;
  contextId: string;
  leaseId: string;
  generation: string;
}

export interface NodeLinkAuthority {
  requester: NodeLinkPrincipal | { kind: 'system' };
  executor: NodeLinkPrincipal;
  grantId: string;
  approvalId: string;
  approval: 'ask' | 'bypass' | 'framework';
  lease?: NodeLinkLease;
}

/** A resource reference is resolved by its adapter, never by a runner-name branch. */
export interface NodeLinkTarget {
  nodeId: string;
  resourceId: string;
}

export interface NodeLinkCommand<Input = unknown> {
  commandId: string;
  operation: string;
  target: NodeLinkTarget;
  authority: NodeLinkAuthority;
  expiresAt: number;
  input: Input;
}

export type NodeLinkCommandState =
  | 'admitted'
  | 'running'
  | 'cancel-requested'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface NodeLinkError {
  code: string;
  message: string;
}

/** Audit metadata contains identifiers/digests only. Protected result payloads stay separate. */
export interface NodeLinkReceipt<Result = unknown> {
  commandId: string;
  digest: string;
  target: NodeLinkTarget;
  authority: NodeLinkAuthority;
  operation: string;
  expiresAt: number;
  admittedAt: number;
  state: NodeLinkCommandState;
  closeoutConfirmed: boolean;
  settledAt?: number;
  result?: Result;
  error?: NodeLinkError;
}

export interface NodeLinkCursor {
  streamId: string;
  incarnation: string;
  offset: number;
}

export interface NodeLinkStreamFrame<Payload = unknown> extends NodeLinkCursor {
  authority: NodeLinkAuthority;
  target: NodeLinkTarget;
  payload: Payload;
}

export type NodeLinkResumeResult<Payload = unknown> =
  | { kind: 'replay'; frames: NodeLinkStreamFrame<Payload>[]; cursor: NodeLinkCursor }
  | {
      kind: 'reset';
      reason: 'expired' | 'gap' | 'source-replaced';
      snapshot: Payload;
      cursor: NodeLinkCursor;
    };

export class NodeLinkFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: { admitted: false },
  ) {
    super(message);
    this.name = 'NodeLinkFailure';
  }
}

export function isNodeLinkTerminal(state: NodeLinkCommandState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export function isNodeLinkPrincipal(value: unknown): value is NodeLinkPrincipal {
  return (
    record(value) &&
    identity(value.principalId) &&
    Number.isSafeInteger(value.generation) &&
    typeof value.generation === 'number' &&
    value.generation >= 0
  );
}

export function isNodeLinkAuthority(value: unknown): value is NodeLinkAuthority {
  if (
    !record(value) ||
    !isNodeLinkPrincipal(value.executor) ||
    !identity(value.grantId) ||
    !identity(value.approvalId) ||
    !['ask', 'bypass', 'framework'].includes(String(value.approval))
  )
    return false;
  if (
    !isNodeLinkPrincipal(value.requester) &&
    !(record(value.requester) && value.requester.kind === 'system')
  )
    return false;
  const lease = value.lease;
  return (
    lease === undefined ||
    (record(lease) &&
      ['runId', 'contextId', 'leaseId', 'generation'].every((field) => identity(lease[field])))
  );
}

export function isNodeLinkTarget(value: unknown): value is NodeLinkTarget {
  return record(value) && identity(value.nodeId) && identity(value.resourceId);
}

export function isNodeLinkCommand(value: unknown): value is NodeLinkCommand {
  return (
    record(value) &&
    identity(value.commandId) &&
    identity(value.operation) &&
    isNodeLinkTarget(value.target) &&
    isNodeLinkAuthority(value.authority) &&
    finite(value.expiresAt) &&
    Object.hasOwn(value, 'input') &&
    Object.keys(value).every((key) =>
      ['commandId', 'operation', 'target', 'authority', 'expiresAt', 'input'].includes(key),
    )
  );
}

export function isNodeLinkReceipt(value: unknown): value is NodeLinkReceipt {
  return (
    record(value) &&
    identity(value.commandId) &&
    typeof value.digest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.digest) &&
    identity(value.operation) &&
    isNodeLinkTarget(value.target) &&
    isNodeLinkAuthority(value.authority) &&
    finite(value.expiresAt) &&
    finite(value.admittedAt) &&
    [
      'admitted',
      'running',
      'cancel-requested',
      'completed',
      'failed',
      'cancelled',
      'unknown',
    ].includes(String(value.state)) &&
    typeof value.closeoutConfirmed === 'boolean' &&
    (value.settledAt === undefined || finite(value.settledAt)) &&
    (value.error === undefined ||
      (record(value.error) &&
        identity(value.error.code) &&
        typeof value.error.message === 'string'))
  );
}
