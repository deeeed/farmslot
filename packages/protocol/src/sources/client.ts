import { Methods } from '../rpc/registry.js';
import type {
  SourcesPinParams,
  SourcesPinResult,
  SourcesStatusParams,
  SourcesStatusResult,
  SourcesSyncParams,
  SourcesSyncResult,
  SourcesUnpinParams,
} from '../rpc/sources.js';

import { type SourcePinTarget, validateSourceSelection } from './pins.js';

export type SourceRpcRequest = <T>(method: string, params: unknown) => Promise<T>;
export type SourcePinInput = Omit<
  SourcesPinParams,
  'operationId' | 'expectedDeclarationRevision' | 'expectedPinRevision'
>;
export type SourceUnpinInput = Omit<SourcePinInput, 'ref'>;
export type SourceSyncInput = Omit<
  SourcesSyncParams,
  'operationId' | 'expectedDeclarationRevision'
>;

export type PreparedSourceCommand =
  | { method: typeof Methods.SOURCES_PIN; params: SourcesPinParams }
  | { method: typeof Methods.SOURCES_UNPIN; params: SourcesUnpinParams }
  | { method: typeof Methods.SOURCES_SYNC; params: SourcesSyncParams };

interface SourceCommandResults {
  [Methods.SOURCES_PIN]: SourcesPinResult;
  [Methods.SOURCES_UNPIN]: SourcesPinResult;
  [Methods.SOURCES_SYNC]: SourcesSyncResult;
}
export type SourceCommandResult<Command extends PreparedSourceCommand> =
  SourceCommandResults[Command['method']];

function pinRevisions(
  status: SourcesStatusResult,
): Pick<SourcesPinParams, 'expectedDeclarationRevision' | 'expectedPinRevision'> {
  return {
    expectedDeclarationRevision: status.declarationRevision!,
    expectedPinRevision: status.pinRevision!,
  };
}

/** One target mapping serves SDK commands and every source status/picker context. */
export function sourceStatusParamsForTarget(
  sourceId?: string,
  target?: SourcePinTarget,
): SourcesStatusParams {
  const params: SourcesStatusParams = { ...(sourceId ? { sourceId } : {}) };
  if (!target) return params;
  if (
    !['farm', 'node', 'run'].includes(target.scope) ||
    !target.targetId ||
    (target.scope === 'farm' && target.targetId !== 'farm')
  )
    throw new Error('Select one source scope and its target.');
  if (target.scope === 'node') params.nodeId = target.targetId;
  if (target.scope === 'run') params.runId = target.targetId;
  return params;
}

function newOperationId(): string {
  return `sources-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Existing authenticated transports own connectivity. This client never resolves refs. */
export class SourceCommandClient {
  constructor(private readonly request: SourceRpcRequest) {}

  status(params: SourcesStatusParams = {}): Promise<SourcesStatusResult> {
    return this.request(Methods.SOURCES_STATUS, params);
  }

  private async revisions(
    sourceId?: string,
    target?: SourcePinTarget,
  ): Promise<SourcesStatusResult> {
    const status = await this.status(sourceStatusParamsForTarget(sourceId, target));
    if (!status.configured || !Number.isInteger(status.declarationRevision))
      throw new Error('Source authority is unavailable or unsupported.');
    if (target && !Number.isInteger(status.pinRevision))
      throw new Error('This gateway does not support scoped source pins.');
    if (target?.scope === 'run' && status.runSource?.canSelectSources !== true)
      throw new Error(
        status.runSource?.selectionRefusal ?? 'Create another run to change source inputs.',
      );
    return status;
  }

  async preparePin(
    input: SourcePinInput,
    operationId = newOperationId(),
  ): Promise<Extract<PreparedSourceCommand, { method: typeof Methods.SOURCES_PIN }>> {
    const status = await this.revisions(input.sourceId, input);
    const errors = validateSourceSelection(
      { sourceId: input.sourceId, selection: 'branch', ref: input.ref },
      status.declarations,
    );
    if (errors.length) throw new Error(errors.join(' '));
    return {
      method: Methods.SOURCES_PIN,
      params: { ...input, operationId, ...pinRevisions(status) },
    };
  }

  async prepareUnpin(
    input: SourceUnpinInput,
    operationId = newOperationId(),
  ): Promise<Extract<PreparedSourceCommand, { method: typeof Methods.SOURCES_UNPIN }>> {
    const status = await this.revisions(input.sourceId, input);
    const errors = validateSourceSelection(
      { sourceId: input.sourceId, selection: 'main' },
      status.declarations,
    );
    if (errors.length) throw new Error(errors.join(' '));
    return {
      method: Methods.SOURCES_UNPIN,
      params: { ...input, operationId, ...pinRevisions(status) },
    };
  }

  async prepareSync(
    input: SourceSyncInput = {},
    operationId = newOperationId(),
  ): Promise<Extract<PreparedSourceCommand, { method: typeof Methods.SOURCES_SYNC }>> {
    const status = await this.revisions(
      input.sourceId,
      input.nodeId ? { scope: 'node', targetId: input.nodeId } : undefined,
    );
    return {
      method: Methods.SOURCES_SYNC,
      params: { ...input, operationId, expectedDeclarationRevision: status.declarationRevision! },
    };
  }

  /** Retry this exact command after a lost response. Never recapture revisions or mint another ID. */
  async execute<Command extends PreparedSourceCommand>(
    command: Command,
  ): Promise<SourceCommandResult<Command>> {
    const result = await this.request<SourceCommandResult<Command>>(command.method, command.params);
    if (result.operationId !== command.params.operationId)
      throw new Error('Source acknowledgement belongs to a different operation.');
    return result;
  }
}

export function createSourceCommandClient(request: SourceRpcRequest): SourceCommandClient {
  return new SourceCommandClient(request);
}
