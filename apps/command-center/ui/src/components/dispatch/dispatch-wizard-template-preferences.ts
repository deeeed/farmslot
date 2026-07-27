import type { FlowType } from '@farmslot/protocol';

import { safeLsGet, safeLsSet } from '../../utils/storage.js';

export type ExecutionTemplateRunMode = 'interactive' | 'autonomous';

interface DispatchTemplatePreference {
  domain: string;
  mode: ExecutionTemplateRunMode;
  templates: Record<string, string>;
}

const STORAGE_PREFIX = 'farmslot.dispatch-template';

function storageKey(project: string, flowType: FlowType): string {
  return `${STORAGE_PREFIX}.${encodeURIComponent(project)}.${flowType}`;
}

function templateContext(domain: string, mode: ExecutionTemplateRunMode): string {
  return `${mode}:${domain}`;
}

export function loadDispatchTemplatePreference(
  project: string,
  flowType: FlowType,
): DispatchTemplatePreference | null {
  const raw = safeLsGet(storageKey(project, flowType));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<DispatchTemplatePreference>;
    if (
      typeof value.domain !== 'string' ||
      (value.mode !== 'interactive' && value.mode !== 'autonomous') ||
      !value.templates ||
      typeof value.templates !== 'object' ||
      Array.isArray(value.templates)
    ) {
      return null;
    }
    const templates = Object.fromEntries(
      Object.entries(value.templates).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === 'string' && typeof entry[1] === 'string',
      ),
    );
    return { domain: value.domain, mode: value.mode, templates };
  } catch {
    return null;
  }
}

export function selectedExecutionTemplatePreference(
  preference: DispatchTemplatePreference | null,
  domain: string,
  mode: ExecutionTemplateRunMode,
): string {
  return preference?.templates[templateContext(domain, mode)] ?? '';
}

export function persistDispatchTemplatePreference(input: {
  project: string;
  flowType: FlowType;
  domain: string;
  mode: ExecutionTemplateRunMode;
  executionTemplateId: string;
}): void {
  const previous = loadDispatchTemplatePreference(input.project, input.flowType);
  const templates = { ...previous?.templates };
  if (input.executionTemplateId) {
    templates[templateContext(input.domain, input.mode)] = input.executionTemplateId;
  }
  safeLsSet(
    storageKey(input.project, input.flowType),
    JSON.stringify({ domain: input.domain, mode: input.mode, templates }),
  );
}
