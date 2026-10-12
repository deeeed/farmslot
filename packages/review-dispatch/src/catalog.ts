import {
  CODEX_REASONING_EFFORTS,
  codexReasoningEfforts,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_EFFORT,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GROK_EFFORT,
  DEFAULT_GROK_MODEL,
  DEFAULT_PI_MODEL,
  DEFAULT_PI_THINKING,
  DEFAULT_RUNNER,
  type NativeRunnerOption,
  PI_THINKING_LEVELS,
  type ReviewSelection,
  RUNNER_PICKER_MODELS,
  type RunnerModelCatalogResult,
  type RunnerVisibleModelState,
} from '@farmslot/protocol';

import type {
  ReviewDispatchCatalog,
  ReviewDispatchProjectDefaults,
  ReviewDispatchRunnerOption,
} from './types.js';

/** Capability defaults shared by every picker until the host supplies its registry catalog. */
export const DEFAULT_REVIEW_DISPATCH_CATALOG: ReviewDispatchCatalog = {
  runners: [
    {
      id: 'claude',
      allowCustomModels: true,
      defaultModel: DEFAULT_CLAUDE_MODEL,
      defaultEffort: null,
      efforts: [],
      models: RUNNER_PICKER_MODELS.claude.map((id) => ({ id })),
    },
    {
      id: 'codex',
      allowCustomModels: true,
      defaultModel: DEFAULT_CODEX_MODEL,
      defaultEffort: DEFAULT_CODEX_EFFORT,
      efforts: CODEX_REASONING_EFFORTS,
      models: RUNNER_PICKER_MODELS.codex.map((id) => ({
        id,
        efforts: codexReasoningEfforts(id),
      })),
    },
    {
      id: 'cursor',
      allowCustomModels: true,
      defaultModel: DEFAULT_CURSOR_MODEL,
      defaultEffort: null,
      efforts: [],
      models: RUNNER_PICKER_MODELS.cursor.map((id) => ({ id })),
    },
    {
      id: 'grok',
      allowCustomModels: true,
      defaultModel: DEFAULT_GROK_MODEL,
      defaultEffort: DEFAULT_GROK_EFFORT,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      models: RUNNER_PICKER_MODELS.grok.map((id) => ({ id })),
    },
    {
      id: 'pi',
      allowCustomModels: true,
      defaultModel: DEFAULT_PI_MODEL,
      defaultEffort: DEFAULT_PI_THINKING,
      efforts: PI_THINKING_LEVELS,
      models: RUNNER_PICKER_MODELS.pi.map((id) => ({ id })),
    },
    {
      id: 'opencode',
      allowCustomModels: true,
      defaultModel: null,
      defaultEffort: null,
      efforts: [],
      models: [],
    },
  ],
};

export function runnerOption(
  runner: string,
  catalog: ReviewDispatchCatalog = DEFAULT_REVIEW_DISPATCH_CATALOG,
): ReviewDispatchRunnerOption {
  const option = catalog.runners.find((entry) => entry.id === runner);
  if (!option || runner === 'same') throw new Error(`Unsupported review runner: ${runner}`);
  return option;
}

export function defaultModelForRunner(
  runner: string,
  catalog: ReviewDispatchCatalog = DEFAULT_REVIEW_DISPATCH_CATALOG,
): string | null {
  return runnerOption(runner, catalog).defaultModel;
}

export function modelsForRunner(
  runner: string,
  selected?: string | null,
  catalog: ReviewDispatchCatalog = DEFAULT_REVIEW_DISPATCH_CATALOG,
): string[] {
  const option = runnerOption(runner, catalog);
  return [
    ...new Set([
      ...option.models.map((model) => model.id),
      ...(option.defaultModel ? [option.defaultModel] : []),
      ...(selected ? [selected] : []),
    ]),
  ];
}

export function modelForRunnerChange(
  runner: string,
  model: string | null,
  catalog: ReviewDispatchCatalog = DEFAULT_REVIEW_DISPATCH_CATALOG,
): string | null {
  if (model === null) return null;
  const option = runnerOption(runner, catalog);
  return option.models.some((entry) => entry.id === model) ? model : option.defaultModel;
}

export function effortsForRunner(
  runner: string,
  model?: string | null,
  catalog: ReviewDispatchCatalog = DEFAULT_REVIEW_DISPATCH_CATALOG,
): string[] {
  const option = runnerOption(runner, catalog);
  const effectiveModel = model ?? option.defaultModel;
  return [
    ...(option.models.find((entry) => entry.id === effectiveModel)?.efforts ?? option.efforts),
  ];
}

export function defaultEffortForRunner(
  runner: string,
  model?: string | null,
  catalog: ReviewDispatchCatalog = DEFAULT_REVIEW_DISPATCH_CATALOG,
): string | null {
  const option = runnerOption(runner, catalog);
  const levels = effortsForRunner(runner, model, catalog);
  return option.defaultEffort && levels.includes(option.defaultEffort)
    ? option.defaultEffort
    : null;
}

export function catalogWithVisibleModels(
  catalog: ReviewDispatchCatalog,
  visible: readonly RunnerVisibleModelState[],
): ReviewDispatchCatalog {
  return {
    runners: catalog.runners.map((option) => {
      const state = visible.find((entry) => entry.runner === option.id);
      if (!state) return option;
      return {
        ...option,
        defaultModel: state.defaultModel || null,
        models: state.pickerModels.map(
          (id) => option.models.find((model) => model.id === id) ?? { id },
        ),
      };
    }),
  };
}

export function catalogWithRunnerModels(
  catalog: ReviewDispatchCatalog,
  result: RunnerModelCatalogResult,
): ReviewDispatchCatalog {
  if (result.status !== 'ready') return catalog;
  return {
    runners: catalog.runners.map((option) =>
      option.id !== result.runner
        ? option
        : {
            ...option,
            models: result.models.map((model) => ({
              id: model.id,
              label: model.label,
              efforts: model.reasoningModes.length
                ? option.efforts.filter((level) => model.reasoningModes.includes(level))
                : option.models.find((entry) => entry.id === model.id)?.efforts,
            })),
          },
    ),
  };
}

export function catalogForNativeRunners(
  runners: readonly NativeRunnerOption[],
  catalog: ReviewDispatchCatalog = DEFAULT_REVIEW_DISPATCH_CATALOG,
): ReviewDispatchCatalog {
  return {
    runners: runners.map((native) => {
      const option = catalog.runners.find((entry) => entry.id === native.runner);
      return {
        id: native.runner,
        allowCustomModels: option?.allowCustomModels ?? true,
        defaultModel: native.defaultModel || null,
        defaultEffort: option?.defaultEffort ?? null,
        efforts: option?.efforts ?? [],
        models: native.models.map(
          (id) => option?.models.find((entry) => entry.id === id) ?? { id },
        ),
      };
    }),
  };
}

/** Project flow defaults are absolute selections, never relative to a worker's runner. */
export function defaultsForFlow(
  flow: string,
  projects: readonly ReviewDispatchProjectDefaults[],
  project: string,
  fallback: Partial<ReviewSelection> = {},
): Partial<ReviewSelection> {
  const config = projects.find((entry) => entry.name === project);
  const selected = config?.defaults?.[flow];
  return {
    runner: DEFAULT_RUNNER,
    model: null,
    effort: null,
    mode: 'cold',
    ...fallback,
    ...(selected?.runner ? { runner: selected.runner } : {}),
    ...(selected?.model ? { model: selected.model } : {}),
    ...(selected?.effort ? { effort: selected.effort } : {}),
    ...(flow === 'review-pr' && config?.review
      ? Object.fromEntries(
          Object.entries(config.review).filter(([key]) =>
            ['runner', 'model', 'effort', 'mode'].includes(key),
          ),
        )
      : {}),
  };
}

export interface CreateReviewDispatchCatalogOptions {
  runnerIds?: readonly string[];
  visibleModels?: readonly RunnerVisibleModelState[];
  runnerModels?: readonly RunnerModelCatalogResult[];
  nativeRunners?: readonly NativeRunnerOption[];
  runners?: readonly ReviewDispatchRunnerOption[];
}
export function createReviewDispatchCatalog(
  options: CreateReviewDispatchCatalogOptions = {},
): ReviewDispatchCatalog {
  let catalog = options.runners ? { runners: options.runners } : DEFAULT_REVIEW_DISPATCH_CATALOG;
  if (options.runnerIds)
    catalog = {
      runners: options.runnerIds.map(
        (id) =>
          catalog.runners.find((runner) => runner.id === id) ?? {
            id,
            defaultModel: null,
            defaultEffort: null,
            efforts: [],
            models: [],
            allowCustomModels: true,
          },
      ),
    };
  if (options.nativeRunners) catalog = catalogForNativeRunners(options.nativeRunners, catalog);
  for (const result of options.runnerModels ?? [])
    catalog = catalogWithRunnerModels(catalog, result);
  if (options.visibleModels) catalog = catalogWithVisibleModels(catalog, options.visibleModels);
  return catalog;
}

export function resolveReviewDispatchDefaults(
  project: ReviewDispatchProjectDefaults | undefined,
  flow: string,
  fallback: Partial<ReviewSelection> = {},
  overrides: Partial<ReviewSelection> = {},
): Partial<ReviewSelection> {
  return {
    ...defaultsForFlow(flow, project ? [project] : [], project?.name ?? '', fallback),
    ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
  };
}
