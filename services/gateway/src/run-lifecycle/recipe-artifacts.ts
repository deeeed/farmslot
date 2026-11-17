import path from 'node:path';

import {
  isCompletionPrerequisiteFailure,
  isGateParkInFlightOrFreed,
  isHeldForResultDecision,
  isTerminalRunStatus,
  type Run,
} from '@farmslot/protocol';

import { loadProjectVars, loadSlotVars, resolveProjectTaskDirName } from '../core/index.js';
import { archiveSlotScaffolding } from '../fleet/slot-scaffolding.js';
import { workerTaskDirectory } from '../run-engine/worker-task-dir.js';
import { getRunWithArchived, runSessionArchiveDir } from '../runs/store.js';

export function canCollectRecipeArtifacts(run: Run | undefined): run is Run {
  return (
    !!run &&
    isTerminalRunStatus(run.status) &&
    !isHeldForResultDecision(run) &&
    !isCompletionPrerequisiteFailure(run) &&
    !isGateParkInFlightOrFreed(run)
  );
}

/** A metadata-only teardown must retain owned recipe output before it frees the checkout. */
export async function archiveRunRecipeArtifacts(
  run: Run,
  beforeRemove: () => Promise<void>,
): Promise<void> {
  const owner = await getRunWithArchived(run.id);
  if (!run.slotId || !canCollectRecipeArtifacts(owner) || !owner.taskFile) return;
  await beforeRemove();
  const vars = await loadSlotVars(run.slotId);
  const project = await loadProjectVars(run.project);
  // Use the task-transfer mapper, not a legacy task_file cache that early teardown may lack.
  const taskDirName = resolveProjectTaskDirName(project.projectJson);
  const taskRelativeDir = path.posix.relative(
    path.posix.join(vars.remoteRepo, taskDirName),
    workerTaskDirectory(owner.taskFile, vars.remoteRepo, taskDirName),
  );
  await archiveSlotScaffolding(vars, project.projectJson, {
    destination: path.join(runSessionArchiveDir(run.id), 'slot-scaffolding'),
    taskRelativeDir,
    recipeOwnerRunId: run.id,
    recipeArtifactsOnly: true,
    beforeRemove: async () => {
      await beforeRemove();
      if (!canCollectRecipeArtifacts(await getRunWithArchived(run.id)))
        throw new Error('Recipe artifact owner became protected during release');
    },
  });
}
