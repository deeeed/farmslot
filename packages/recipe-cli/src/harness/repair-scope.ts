import fs from 'node:fs';
import path from 'node:path';

import {
  isRecipeRepairScope,
  isRecord,
  RECIPE_REPAIR_SCOPE_TASK_PATH,
  validateRecipeRepairScope,
} from '@farmslot/protocol';
import type { RecipeRunRepairScope } from '@farmslot/recipe-runner';

export type TaskRepairScopeResolution =
  | { repairScope?: RecipeRunRepairScope }
  | { refusal: string };

/**
 * The gateway-written scope activates only for its own separate repair recipe.
 * The main task recipe ignores it; the gateway still owns the authoritative digest.
 */
export function resolveTaskRepairScope(
  taskDir: string | null,
  recipeFile: string,
): TaskRepairScopeResolution {
  if (!taskDir) return {};
  const scopeFile = path.join(taskDir, RECIPE_REPAIR_SCOPE_TASK_PATH);
  if (!fs.existsSync(scopeFile)) return {};
  const scope: unknown = JSON.parse(fs.readFileSync(scopeFile, 'utf8'));
  if (!isRecord(scope) || typeof scope.repairRecipe !== 'string') return {};
  const repairRecipe = path.resolve(taskDir, scope.repairRecipe);
  if (
    !fs.existsSync(repairRecipe) ||
    fs.realpathSync(repairRecipe) !== fs.realpathSync(path.resolve(recipeFile))
  )
    return {};
  if (!isRecipeRepairScope(scope))
    return {
      refusal: `The task repair scope is invalid: ${validateRecipeRepairScope(scope)
        .findings.map((finding) => finding.message)
        .join(' ')}`,
    };
  const artifacts = fs.realpathSync(path.join(taskDir, 'artifacts'));
  const sourceRoots: Record<string, string> = {};
  for (const source of scope.sources) {
    const candidate = path.resolve(taskDir, source.artifactRoot);
    if (!fs.existsSync(candidate))
      return { refusal: `Repair source ${source.artifactRoot} is not retained in this task.` };
    const root = fs.realpathSync(candidate);
    const relative = path.relative(artifacts, root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      return { refusal: `Repair source ${source.artifactRoot} escapes the task artifacts.` };
    sourceRoots[source.recipeRunId] = root;
  }
  return { repairScope: { scope, sourceRoots } };
}
