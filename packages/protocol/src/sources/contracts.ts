/** ADR-069 source authority. Paths and credentials never belong in portable records. */
export interface SourceEntryRef {
  sourceId: string;
  entry: string;
}

export interface SourceDeclaration {
  id: string;
  kind: 'pack' | 'recipe-library' | 'helper';
  repo: string;
  ref?: string;
}

export interface SourceConfiguration {
  schemaVersion: 1;
  revision: number;
  pollIntervalMs: number;
  sources: SourceDeclaration[];
  packs: Record<string, SourceEntryRef>;
}

export interface SourcePin {
  sourceId: string;
  selection: 'branch' | 'main';
  ref: string;
  scope: 'run' | 'node' | 'farm';
  targetId: string;
  actor: string;
  declarationRevision: number;
  revision: number;
  baseMainCommit: string;
  createdAt: string;
}

export interface SourceResolution {
  sourceId: string;
  ref: string;
  declarationRevision: number;
  generation: number;
  commit?: string;
  refObject?: string;
  objectFormat?: 'sha1' | 'sha256';
  treeDigest?: string;
  resolvedAt?: string;
  status: 'resolved' | 'stale' | 'failed';
  reason?: string;
  rewrites: Array<{ before: string; after: string; observedAt: string }>;
}

export interface SourceLockEntry {
  sourceId: string;
  kind: SourceDeclaration['kind'];
  repo: string;
  declaredRef: string;
  effectiveRef: string;
  commit: string;
  objectFormat: 'sha1' | 'sha256';
  treeDigest: string;
  resolutionGeneration: number;
  scope: 'run' | 'node' | 'farm';
  pin?: SourcePin;
  dependencies: SourceEntryRef[];
}

export interface SourceLock {
  schemaVersion: 1;
  context: { project: string; nodeId?: string; runId?: string };
  generation: number;
  declarationRevision: number;
  pinRevision: number;
  resolvedAt: string;
  entries: SourceLockEntry[];
  packBindings: Record<string, SourceEntryRef>;
  digest: string;
}

export interface SourceMaterializationReceipt {
  schemaVersion: 1;
  id: string;
  nodeId: string;
  lockDigest: string;
  verifiedAt: string;
  sources: Array<{
    sourceId: string;
    commit: string;
    treeDigest: string;
    protection: 'read-only-volume';
  }>;
}

export interface RunSourceProvenance {
  state: 'locked';
  attemptId: string;
  lock: SourceLock;
  receiptIds: string[];
  bindings: SourceEntryRef[];
  attempts: SourceExecutionAttemptReceipt[];
}

export interface SourceExecutionAttemptReceipt {
  id: string;
  receiptIds: string[];
}

/** An execution-local attestation adds paths only inside the authenticated node boundary. */
export interface SourceMaterialization {
  lock: SourceLock;
  receipt: SourceMaterializationReceipt;
  roots: Record<string, string>;
  receiptPath: string;
}

export interface SourceNodeStatus {
  nodeId: string;
  materializations: Array<{
    lockDigest: string;
    sources: SourceMaterializationReceipt['sources'];
    verifiedAt?: string;
    drift: string[];
  }>;
}

export interface RunSourceStatus {
  runId: string;
  state: 'locked' | 'unknown-legacy';
  lockDigest?: string;
  attemptId?: string;
}
