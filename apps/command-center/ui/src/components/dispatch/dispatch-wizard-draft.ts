import type {
  DevInteractiveProfile,
  FlowType,
  TaskTemplateSelection,
  WorkerTemplateOption,
} from '@farmslot/protocol';
import {
  interactiveWorkerTemplateOption,
  modeForFlow as sharedModeForFlow,
  selectedTemplateMode as sharedSelectedTemplateMode,
  selectQaProfile,
} from '@farmslot/protocol';

import type { EffortLevel } from '../../utils/runner-options.js';

export interface DispatchDraftState {
  flowType: FlowType | null;
  ticketId: string;
  project: string;
  model: string;
  runner: string;
  effort: EffortLevel;
  mode: 'interactive' | 'autonomous';
  devInteractiveProfile: DevInteractiveProfile;
  reviewTier: '' | 'light' | 'standard' | 'full';
  skipPrepare: boolean;
  reviewSequence: import('@farmslot/protocol').ReviewSequence;
}

export function selectedTaskTemplate(
  options: ReadonlyArray<WorkerTemplateOption>,
  selectedFileName: string,
): TaskTemplateSelection | undefined {
  const selected = options.find((option) => option.fileName === selectedFileName);
  if (!selected || selected.isDefault) return undefined;
  return { fileName: selected.fileName, variant: selected.variant ?? null };
}

export function interactiveTemplateOption(
  options: ReadonlyArray<WorkerTemplateOption>,
): WorkerTemplateOption | undefined {
  return interactiveWorkerTemplateOption(options);
}

export function modeForFlow(flowType: FlowType) {
  return flowType === 'review-pr' || flowType === 'qa' ? 'autonomous' : sharedModeForFlow(flowType);
}

export function selectedTemplateMode(...args: Parameters<typeof sharedSelectedTemplateMode>) {
  return args[0] === 'review-pr' || args[0] === 'qa'
    ? 'autonomous'
    : sharedSelectedTemplateMode(...args);
}

export function projectApps(
  configs: ReadonlyArray<{ name: string; apps?: string[] }>,
  projectName: string,
): string[] {
  return configs.find((project) => project.name === projectName)?.apps ?? [];
}

export interface PrepareProfileOption {
  name: string;
  label: string;
  description?: string;
  isDefault: boolean;
}

export function projectPrepareProfiles(
  configs: ReadonlyArray<{
    name: string;
    prepare?: import('@farmslot/protocol').ProjectPrepareConfig;
  }>,
  projectName: string,
): PrepareProfileOption[] {
  const prepare = configs.find((project) => project.name === projectName)?.prepare;
  if (!prepare) return [];
  const profiles = prepare.profiles ?? {};
  // Mirrors gateway resolvePrepareProfile: core wins for implicit selection;
  // legacy projects retain prepare.default / "full" fallback behavior.
  const defaultName = prepare.core
    ? 'core'
    : (prepare.default ?? ('full' in profiles ? 'full' : ''));
  const entries = [
    ...(prepare.core ? ([['core', prepare.core]] as const) : []),
    ...Object.entries(profiles),
  ];
  return entries.map(([name, profile]) => ({
    name,
    label: profile.label || name,
    ...(profile.description ? { description: profile.description } : {}),
    isDefault: name === defaultName,
  }));
}

export function syncSelectedAppForProject(apps: ReadonlyArray<string>, currentApp: string): string {
  if (apps.length <= 1) return '';
  return apps.includes(currentApp) ? currentApp : (apps[0] ?? '');
}

export function selectedDispatchApp(
  apps: ReadonlyArray<string>,
  currentApp: string,
): string | undefined {
  if (apps.length <= 1) return undefined;
  return currentApp || apps[0];
}

export function appLabel(app: string): string {
  const parts = app.split('/').filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? app) : app;
}

export function publicationReviewsEnabled(
  flowType: FlowType | null,
  mode?: 'interactive' | 'autonomous',
): boolean {
  if (flowType === 'fix-bug') return true;
  return flowType === 'dev' && mode === 'autonomous';
}

/** Inputs stay skill-owned; only the selected farm profile and JSON shape are interpreted here. */
export function qaDispatchFields(
  config: import('@farmslot/protocol').ProjectQaConfig | undefined,
  profileId: string,
  rawInputs: string,
) {
  const inputs = parseQaInputOverrides(rawInputs);
  const selected = selectQaProfile(config, profileId || undefined, inputs);
  return { qaProfileId: selected.profile.id, qaInputs: selected.inputs };
}

export function parseQaInputOverrides(
  rawInputs: string,
): Record<string, import('@farmslot/protocol').QaInput> {
  let inputs: unknown = {};
  if (rawInputs.trim()) {
    try {
      inputs = JSON.parse(rawInputs);
    } catch (error) {
      throw new Error(`QA inputs must be a JSON object: ${(error as Error).message}`);
    }
  }
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs))
    throw new Error('QA inputs must be a JSON object');
  return inputs as Record<string, import('@farmslot/protocol').QaInput>;
}
