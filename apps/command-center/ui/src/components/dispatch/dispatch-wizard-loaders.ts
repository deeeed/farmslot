import type {
  ConfigProjectsResult,
  ConfigTemplateOptionsResult,
  ConfigTemplatePreviewResult,
  DispatchCandidatesResult,
  DispatchPreviewResult,
  ExecutionTemplateCatalogOption,
  FlowType,
  ProfileFitSuggestion,
  ProjectConfig,
  Run,
  RunListParams,
  RunListResult,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

import {
  filterRunsByExactTicket,
  filterRunsForComparisonPicker,
} from './dispatch-wizard-helpers.js';
import {
  buildDispatchCandidatesParams,
  type DispatchCandidatesDraft,
} from './dispatch-wizard-payload.js';

export async function requestProjectConfigs(): Promise<ProjectConfig[]> {
  const res = await gateway.request<ConfigProjectsResult>(Methods.CONFIG_PROJECTS, {});
  return res.projects;
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
  return gateway.request<ConfigTemplateOptionsResult>(Methods.CONFIG_TEMPLATE_OPTIONS, {
    project,
    flowType,
    ...filters,
  });
}

export async function requestUnfilteredTemplateOptions(
  project: string,
): Promise<ConfigTemplateOptionsResult> {
  return gateway.request<ConfigTemplateOptionsResult>(Methods.CONFIG_TEMPLATE_OPTIONS, {
    project,
    unfiltered: true,
  });
}

export async function requestExecutionTemplatePreview(
  project: string,
  flowType: FlowType,
  option: ExecutionTemplateCatalogOption,
): Promise<ConfigTemplatePreviewResult> {
  return gateway.request<ConfigTemplatePreviewResult>(Methods.CONFIG_TEMPLATE_PREVIEW, {
    project,
    flowType,
    executionTemplateId: option.id,
    executionTemplateSourceId: option.sourceId,
    executionTemplateSha256: option.sha256,
  });
}

export interface DispatchWizardCandidatesRequest extends DispatchCandidatesDraft {
  candidatesEverLoaded: boolean;
  mockMode: boolean;
  mockCandidates: DispatchCandidatesResult['candidates'] | null;
}

export async function requestDispatchWizardCandidates(
  input: DispatchWizardCandidatesRequest,
): Promise<DispatchCandidatesResult> {
  if (input.mockMode) {
    return { candidates: input.mockCandidates ?? [] };
  }
  return gateway.request<DispatchCandidatesResult>(
    Methods.DISPATCH_CANDIDATES,
    buildDispatchCandidatesParams(input),
    input.candidatesEverLoaded && !input.forceRefresh ? undefined : 60_000,
  );
}

export interface DispatchProjectMatchResult {
  project: string | null;
  repo: string | null;
  normalizedTicket?: string;
  issueType?: string;
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
}): Promise<ProfileFitSuggestion | null> {
  const res = await gateway.request<DispatchPreviewResult>(Methods.DISPATCH_PREVIEW, {
    project: input.project,
    flowType: input.flowType,
    ticketOrPr: input.ticketOrPr,
    slotId: input.slotId,
    mode: input.mode,
    domain: input.domain,
    executionTemplateId: input.executionTemplateId,
    prepareProfile: input.prepareProfile || undefined,
    app: input.app || undefined,
    freshReuse: input.freshReuse,
  });
  return res.preview.profileFit ?? null;
}

export function requestDispatchProjectMatch(
  ticket: string,
  flowType: FlowType | null,
): Promise<DispatchProjectMatchResult> {
  return gateway.request<DispatchProjectMatchResult>(Methods.DISPATCH_MATCH_PROJECT, {
    ticketOrPr: ticket,
    flowType,
  });
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
  const res = await gateway.request<RunListResult>(Methods.RUN_LIST, {
    search: input.search,
    limit: 50,
  } satisfies RunListParams);
  // run.list `search` is substring match against ticketOrPr OR summary — narrow
  // to exact ticketOrPr matches so the banner doesn't surface unrelated families.
  return filterRunsByExactTicket(res.runs, input.search, input.normalizedTicket);
}

export interface ComparisonPickerRunsRequest {
  mockMode: boolean;
  stateRuns: readonly Run[];
  projectFilters: readonly string[];
  machineFilters: readonly string[];
}

export async function lookupRecentRunsForComparisonPicker(
  input: ComparisonPickerRunsRequest,
): Promise<Run[]> {
  const filters = {
    projectFilters: input.projectFilters,
    machineFilters: input.machineFilters,
  };
  if (input.mockMode) {
    return filterRunsForComparisonPicker(input.stateRuns, filters);
  }
  const params: RunListParams = { limit: 50 };
  if (input.projectFilters.length === 1) {
    params.project = input.projectFilters[0];
  }
  const res = await gateway.request<RunListResult>(Methods.RUN_LIST, params);
  return filterRunsForComparisonPicker(res.runs, filters);
}
