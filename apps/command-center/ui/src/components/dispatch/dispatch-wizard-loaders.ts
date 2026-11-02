import type {
  ConfigProjectsResult,
  ConfigTemplateOptionsResult,
  ConfigTemplatePreviewResult,
  DispatchCandidatesResult,
  DispatchPreviewParams,
  DispatchPreviewResult,
  ExecutionTemplateCatalogOption,
  FlowType,
  ProfileFitSuggestion,
  ProjectConfig,
  Run,
  RunListParams,
  RunListResult,
} from '@farmslot/protocol';
import { jiraTicketKey, Methods } from '@farmslot/protocol';
import { type ResourceQuery, resourceQuery } from '@farmslot/protocol/client-cache';

import { readConfiguration } from '../../configuration-resources.js';
import { gateway } from '../../gateway-client.js';
import { getResourceCache, getResourceWorkspaceKey } from '../../resource-cache.js';

import { filterRunsByExactTicket } from './dispatch-wizard-helpers.js';
import {
  buildDispatchCandidatesParams,
  type DispatchCandidatesDraft,
} from './dispatch-wizard-payload.js';

export async function requestProjectConfigs(): Promise<ProjectConfig[]> {
  return (await readConfiguration<ConfigProjectsResult>(Methods.CONFIG_PROJECTS)).projects;
}

export async function requestTemplateOptions(
  project: string,
  flowType: FlowType,
  filters: {
    platform?: string;
    runMode?: 'interactive' | 'autonomous';
    domain?: string;
    executionTemplateId?: string;
  } = {},
): Promise<ConfigTemplateOptionsResult> {
  return readConfiguration<ConfigTemplateOptionsResult>(Methods.CONFIG_TEMPLATE_OPTIONS, {
    project,
    flowType,
    ...filters,
  });
}

export async function requestExecutionTemplatePreview(
  project: string,
  flowType: FlowType,
  option: ExecutionTemplateCatalogOption,
): Promise<ConfigTemplatePreviewResult> {
  return readConfiguration<ConfigTemplatePreviewResult>(Methods.CONFIG_TEMPLATE_PREVIEW, {
    project,
    flowType,
    executionTemplateId: option.id,
    executionTemplateSourceId: option.sourceId,
    executionTemplateSha256: option.sha256,
  });
}

export interface DispatchWizardCandidatesRequest extends DispatchCandidatesDraft {
  mockMode: boolean;
  mockCandidates: DispatchCandidatesResult['candidates'] | null;
}

export async function requestDispatchWizardCandidates(
  input: DispatchWizardCandidatesRequest,
  onCached?: (result: DispatchCandidatesResult) => void,
): Promise<DispatchCandidatesResult> {
  if (input.mockMode) {
    return { candidates: input.mockCandidates ?? [] };
  }
  const params = buildDispatchCandidatesParams(input);
  const { forceRefresh, ...normalParams } = params;
  if (forceRefresh) {
    const scope = dispatchReadScope();
    await readDispatchQuery(
      resourceQuery<DispatchCandidatesResult>(Methods.DISPATCH_CANDIDATES, params),
      undefined,
      true,
    );
    if (!scope.current()) throw new Error('Dispatch owner changed during read');
  }
  return readDispatchQuery(
    resourceQuery<DispatchCandidatesResult>(Methods.DISPATCH_CANDIDATES, normalParams),
    forceRefresh ? undefined : onCached,
    forceRefresh,
  );
}

function dispatchReadScope() {
  const cache = getResourceCache();
  const owner = getResourceWorkspaceKey();
  if (!cache) throw new Error('Dispatch store is unavailable');
  return {
    cache,
    current: () => cache === getResourceCache() && owner === getResourceWorkspaceKey(),
  };
}

/** Paint a held answer before refreshing it; dispatch commands still validate live state. */
async function readDispatchQuery<T>(
  query: ResourceQuery<T>,
  onCached?: (result: T) => void,
  refresh = false,
): Promise<T> {
  const { cache, current } = dispatchReadScope();
  const previousReceipt = cache.read(query).resourceState;
  let shown: T | undefined;
  const stop = cache.observe(query, (state) => {
    if (current() && state.status !== 'ready' && state.data !== undefined && state.data !== shown) {
      shown = state.data;
      onCached?.(state.data);
    }
  });
  try {
    let state = cache.read(query);
    if (refresh || state.status !== 'ready') state = await cache.retry(query);
    if (!current()) throw new Error('Dispatch owner changed during read');
    // A busy farm can advance a dependency during a successful read. Its new receipt
    // still proves a reply completed; an offline return keeps the previous receipt.
    const completed = state.resourceState !== undefined && state.resourceState !== previousReceipt;
    if (state.data === undefined || state.error || (state.status !== 'ready' && !completed))
      throw new Error(state.error?.message ?? 'Dispatch data could not refresh');
    return state.data;
  } finally {
    stop();
  }
}

export interface DispatchProjectMatchResult {
  project: string | null;
  repo: string | null;
  normalizedTicket?: string;
  issueType?: string;
}

export async function requestDispatchPreview(
  input: DispatchPreviewParams,
): Promise<DispatchPreviewResult> {
  return gateway.request<DispatchPreviewResult>(Methods.DISPATCH_PREVIEW, input, 150_000);
}

export async function requestDispatchProfileFit(input: {
  project: string;
  flowType: FlowType;
  ticketOrPr: string;
  slotId?: string;
  mode?: 'interactive' | 'autonomous';
  domain?: string;
  executionTemplateId?: string;
  prepareProfile?: string;
  app?: string;
  freshReuse?: boolean;
  skipPrepare?: boolean;
}): Promise<ProfileFitSuggestion | null> {
  const res = await requestDispatchPreview(input);
  return res.preview.profileFit ?? null;
}

export function requestDispatchProjectMatch(
  ticket: string,
  flowType: FlowType | null,
  onCached?: (result: DispatchProjectMatchResult) => void,
): Promise<DispatchProjectMatchResult> {
  return readDispatchQuery(
    resourceQuery<DispatchProjectMatchResult>(Methods.DISPATCH_MATCH_PROJECT, {
      ticketOrPr: ticket,
      flowType,
    }),
    onCached,
    !jiraTicketKey(ticket),
  );
}

export interface PriorRunsLookupRequest {
  mockMode: boolean;
  stateRuns: readonly Run[];
  search: string;
  normalizedTicket: string;
}

export async function lookupPriorRunsForDispatchWizard(
  input: PriorRunsLookupRequest,
): Promise<Run[]> {
  if (input.mockMode) {
    return filterRunsByExactTicket(input.stateRuns, input.search, input.normalizedTicket);
  }
  const cache = getResourceCache();
  const owner = getResourceWorkspaceKey();
  const connection = gateway.resourceConnectionId;
  if (!cache || gateway.connectionState !== 'connected' || gateway.workspaceAccess !== 'farm')
    throw new Error('Wait for current runs before looking up prior work');
  const query = resourceQuery<RunListResult>(Methods.RUN_LIST, {
    search: input.search,
    limit: 50,
  } satisfies RunListParams);
  let state = cache.read(query);
  if (state.status !== 'ready') state = await cache.retry(query);
  if (
    cache !== getResourceCache() ||
    owner !== getResourceWorkspaceKey() ||
    connection !== gateway.resourceConnectionId ||
    gateway.connectionState !== 'connected' ||
    gateway.workspaceAccess !== 'farm'
  )
    throw new Error('Run lookup owner changed during read');
  if (state.status !== 'ready' || !state.data)
    throw new Error(state.error?.message ?? 'Wait for current runs before looking up prior work');
  const res = state.data;
  // run.list `search` is substring match against ticketOrPr OR summary — narrow
  // to exact ticketOrPr matches so the banner doesn't surface unrelated families.
  return filterRunsByExactTicket(res.runs, input.search, input.normalizedTicket);
}
