import type {
  RunSourceStatus,
  SourceDeclaration,
  SourceLock,
  SourceNodeStatus,
  SourceResolution,
} from '../sources/contracts.js';

export interface SourcesStatusParams {
  sourceId?: string;
  runId?: string;
  nodeId?: string;
}

export interface SourcesStatusResult {
  runSource?: RunSourceStatus;
  configured: boolean;
  declarationRevision?: number;
  declarations: SourceDeclaration[];
  resolutions: SourceResolution[];
  locks: SourceLock[];
  nodes: SourceNodeStatus[];
  errors: Array<{ nodeId?: string; sourceId?: string; project?: string; reason: string }>;
}

export interface SourcesSyncParams {
  sourceId?: string;
  nodeId?: string;
  operationId: string;
  expectedDeclarationRevision: number;
}

export interface SourcesSyncResult extends SourcesStatusResult {
  operationId: string;
}
