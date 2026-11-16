import type {
  PRExecutionModel,
  ReviewMode,
  ReviewSelection,
  ReviewSequence,
} from '@farmslot/protocol';

import {
  DEFAULT_REVIEW_DISPATCH_CATALOG,
  defaultEffortForRunner,
  defaultModelForRunner,
  resolveReviewMode,
} from './catalog.js';
import type {
  ResolvedReviewDispatchExecutionModel,
  ReviewDispatchCatalog,
  ReviewDispatchExecutionResources,
} from './types.js';
import { parseReviewSelection, parseReviewSequence } from './validation.js';

/** Resolve explicit defaults at the execution boundary, preserving the review mode. */
export function executionModelFromSelection(
  selection: ReviewSelection,
  catalog: ReviewDispatchCatalog = DEFAULT_REVIEW_DISPATCH_CATALOG,
): ResolvedReviewDispatchExecutionModel {
  const row = parseReviewSelection(
    {
      runner: selection.runner,
      model: selection.model,
      effort: selection.effort,
      mode: selection.mode,
    },
    { catalog },
  );
  const model = row.model ?? defaultModelForRunner(row.runner, catalog);
  if (!model) throw new Error(`Select an explicit execution model for ${row.runner}`);
  const effort = row.effort ?? defaultEffortForRunner(row.runner, model, catalog);
  return { runner: row.runner, model, effort, mode: row.mode };
}

export function executionModelsFromReviewSequence(
  sequence: ReviewSequence,
  resources: readonly ReviewDispatchExecutionResources[] = [],
  catalog: ReviewDispatchCatalog = DEFAULT_REVIEW_DISPATCH_CATALOG,
): PRExecutionModel[] {
  return parseReviewSequence(sequence, { catalog, sequenceRole: 'execution-alternatives' }).map(
    (selection, index) => ({
      ...selection,
      ...copyExecutionResources(resources[index]),
    }),
  );
}

export function reviewSequenceForExecution(
  models: readonly PRExecutionModel[],
  mode: ReviewMode = resolveReviewMode(),
  catalog: ReviewDispatchCatalog = DEFAULT_REVIEW_DISPATCH_CATALOG,
): ReviewSequence {
  return parseReviewSequence(
    models.map((model) => ({
      runner: model.runner,
      model: model.model,
      effort: model.effort ?? null,
      mode: resolveReviewMode({ explicitMode: model.mode, defaultMode: mode }),
    })),
    { catalog, sequenceRole: 'execution-alternatives' },
  );
}

export function defaultReviewDispatchExecutionModels(
  catalog: ReviewDispatchCatalog = DEFAULT_REVIEW_DISPATCH_CATALOG,
): PRExecutionModel[] {
  return [
    executionModelFromSelection(
      {
        runner:
          catalog.runners.find((runner) => runner.id === 'codex')?.id ??
          catalog.runners[0]?.id ??
          '',
        model: null,
        effort: null,
        mode: resolveReviewMode(),
      },
      catalog,
    ),
  ];
}

/** Host resource rows never overwrite the selection's four dimensions. */
export function copyExecutionResources(
  resources?: ReviewDispatchExecutionResources,
): ReviewDispatchExecutionResources {
  return {
    ...(resources?.allowedSlots ? { allowedSlots: [...resources.allowedSlots] } : {}),
    ...(resources?.allowedMachines ? { allowedMachines: [...resources.allowedMachines] } : {}),
  };
}
