import type { BacklogCreateParams, FlowType } from '@farmslot/protocol';

export const BACKLOG_CREATE_DEFAULT_FLOW: FlowType = 'dev';
export const BACKLOG_CREATE_DEFAULT_SOURCE_KIND = 'manual' as const;

export interface ResolveBacklogProjectInput {
  explicitProject?: string | null;
  selectedProjects?: string[];
  availableProjects?: string[];
}

/**
 * Prefer an explicit project, then a single selected filter project,
 * then a single available project. Multi-select requires explicit choice.
 */
export function resolveBacklogProject(input: ResolveBacklogProjectInput): string | null {
  const explicit = input.explicitProject?.trim();
  if (explicit) return explicit;

  const selected = (input.selectedProjects ?? []).map((p) => p.trim()).filter(Boolean);
  if (selected.length === 1) return selected[0]!;
  if (selected.length > 1) return null;

  const available = (input.availableProjects ?? []).map((p) => p.trim()).filter(Boolean);
  if (available.length === 1) return available[0]!;
  return null;
}

export interface BuildBacklogCreateInput {
  project: string;
  title: string;
  notes?: string;
  flowType?: FlowType;
  tags?: string[];
}

export function normalizeBacklogTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ');
}

export function buildBacklogCreateParams(input: BuildBacklogCreateInput): BacklogCreateParams {
  const project = input.project.trim();
  if (!project) {
    throw new Error('Select a project before creating a backlog item.');
  }
  const title = normalizeBacklogTitle(input.title);
  if (!title) {
    throw new Error('Add a title before creating a backlog item.');
  }
  const notes = input.notes?.trim();
  return {
    project,
    title,
    sourceKind: BACKLOG_CREATE_DEFAULT_SOURCE_KIND,
    flowType: input.flowType ?? BACKLOG_CREATE_DEFAULT_FLOW,
    notes: notes || undefined,
    tags: input.tags?.length ? input.tags : undefined,
    autoDispatch: false,
    status: 'candidate',
  };
}

/** Primary pressable min size used by Companion default-path UX (44pt). */
export const COMPANION_PRIMARY_TOUCH_MIN = 44;
