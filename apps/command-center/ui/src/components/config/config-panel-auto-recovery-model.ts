import type { FailureCategory, ProjectConfig } from '@farmslot/protocol';

export type AutoRecoveryPreset = 'off' | 'safe-retry' | 'llm-assisted';

export const DEFAULT_AUTO_RECOVERY_LLM_TIMEOUT_MS = 20_000;

export interface AutoRecoveryDraft {
  project: string;
  enabled: boolean;
  maxAttempts: number;
  allowedStepsText: string;
  allowedCategoriesText: string;
  disabledPatternsText: string;
  llmEnabled: boolean;
  llmDailyUsdCap: number;
  llmTimeoutMs: number;
}

export function parseAutoRecoveryList(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function autoRecoveryDraftFromProject(project: ProjectConfig): AutoRecoveryDraft {
  const cfg = project.autoRecovery;
  return {
    project: project.name,
    enabled: cfg?.enabled === true,
    maxAttempts: cfg?.maxAttempts ?? 1,
    allowedStepsText: (cfg?.allowedSteps ?? ['prepare', 'monitor', 'ci-watch']).join(', '),
    allowedCategoriesText: (
      cfg?.allowedCategories ?? ['infra', 'timeout', 'env-drift', 'flake']
    ).join(', '),
    disabledPatternsText: (cfg?.disabledPatterns ?? []).join(', '),
    llmEnabled: cfg?.llm?.enabled === true,
    llmDailyUsdCap: cfg?.llm?.dailyUsdCap ?? 0,
    llmTimeoutMs: cfg?.llm?.timeoutMs ?? DEFAULT_AUTO_RECOVERY_LLM_TIMEOUT_MS,
  };
}

export function autoRecoveryPresetPatch(preset: AutoRecoveryPreset): Partial<AutoRecoveryDraft> {
  if (preset === 'off') {
    return {
      enabled: false,
      maxAttempts: 0,
      llmEnabled: false,
      llmDailyUsdCap: 0,
    };
  }

  const base: Partial<AutoRecoveryDraft> = {
    enabled: true,
    maxAttempts: 1,
    allowedStepsText: 'prepare, monitor, ci-watch',
    allowedCategoriesText: 'infra, timeout, env-drift, flake',
    disabledPatternsText: '',
    llmTimeoutMs: DEFAULT_AUTO_RECOVERY_LLM_TIMEOUT_MS,
  };
  return preset === 'safe-retry'
    ? { ...base, llmEnabled: false, llmDailyUsdCap: 0 }
    : { ...base, llmEnabled: true, llmDailyUsdCap: 0.25 };
}

export function autoRecoveryModeLabel(draft: AutoRecoveryDraft): string {
  if (!draft.enabled) return 'Disabled for this project';
  if (draft.llmEnabled) return 'Gateway Intelligence enabled: replay + bounded LLM refinement';
  return 'Gateway Intelligence enabled: deterministic replay only';
}

export function autoRecoveryModeDetail(draft: AutoRecoveryDraft): string {
  if (!draft.enabled) {
    return 'Gateway Intelligence can still observe this project, but will not auto-dispatch recovery.';
  }
  const steps = parseAutoRecoveryList(draft.allowedStepsText).join(', ') || 'no steps';
  const buckets = parseAutoRecoveryList(draft.allowedCategoriesText).join(', ') || 'no buckets';
  const llm = draft.llmEnabled
    ? `LLM cap $${Number(draft.llmDailyUsdCap).toFixed(2)}/day`
    : 'no LLM calls';
  return `${draft.maxAttempts} attempt(s) per step · steps: ${steps} · buckets: ${buckets} · ${llm}`;
}

export function autoRecoveryUpdateFromDraft(draft: AutoRecoveryDraft) {
  return {
    enabled: draft.enabled,
    maxAttempts: Number(draft.maxAttempts),
    allowedSteps: parseAutoRecoveryList(draft.allowedStepsText),
    allowedCategories: parseAutoRecoveryList(draft.allowedCategoriesText) as FailureCategory[],
    disabledPatterns: parseAutoRecoveryList(draft.disabledPatternsText),
    llm: {
      enabled: draft.llmEnabled,
      dailyUsdCap: Number(draft.llmDailyUsdCap),
      timeoutMs: Number(draft.llmTimeoutMs),
    },
  };
}
