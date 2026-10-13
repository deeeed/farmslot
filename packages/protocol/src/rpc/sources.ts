import type {
  RunSourceStatus,
  SourceDeclaration,
  SourceLock,
  SourceNodeStatus,
  SourcePin,
  SourceResolution,
} from '../sources/contracts.js';
import type { SourceEffectiveSelection, SourcePinTarget } from '../sources/pins.js';

export interface SourcesStatusParams {
  sourceId?: string;
  runId?: string;
  nodeId?: string;
}

export interface SourcesStatusResult {
  runSource?: RunSourceStatus;
  configured: boolean;
  declarationRevision?: number;
  pinRevision?: number;
  pins?: SourcePin[];
  effectiveSelections?: SourceEffectiveSelection[];
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

export interface SourcesPinParams extends SourcePinTarget {
  sourceId: string;
  ref: string;
  operationId: string;
  expectedDeclarationRevision: number;
  expectedPinRevision: number;
}

export type SourcesUnpinParams = Omit<SourcesPinParams, 'ref'>;

export interface SourcesPinResult {
  operationId: string;
  declarationRevision: number;
  pinRevision: number;
  pin: SourcePin;
}

export type SourcesUnpinResult = SourcesPinResult;
