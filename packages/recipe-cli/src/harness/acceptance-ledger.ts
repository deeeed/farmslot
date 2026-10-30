// Task transport only. The engine derives verdicts; the task ledger has no reducer.
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  ACCEPTANCE_CRITERION_ID_PATTERN,
  normalizeRecipeClaimId,
  type RecipeClaimDeclaration,
  type RecipeClaimEvidence,
} from '@farmslot/protocol';

import { harnessContext } from './context-state.js';

interface AcceptanceLedgerModule {
  handoffAcceptanceCriteria(taskDir: string): Array<{ id: string; text: string }>;
  transferEngineClaims(
    taskDir: string,
    claimsPath: string,
    tracePath: string,
    selectedClaims?: RecipeClaimEvidence[],
  ): RecipeClaimEvidence[];
}
const require = createRequire(import.meta.url);
const ledger =
  require('@farmslot/agent-runtime/scripts/acceptance-ledger.cjs') as AcceptanceLedgerModule;

export type RecipeAcceptanceVerdict = RecipeClaimEvidence;
export interface RecipeAcceptanceRecord {
  recorded: RecipeAcceptanceVerdict[];
  refused: string[];
}

export function acceptanceIdForProofTarget(target: string): string | null {
  const id = normalizeRecipeClaimId(target.trim());
  return ACCEPTANCE_CRITERION_ID_PATTERN.test(id) ? id : null;
}

/** Resolve the task once for CLI artifacts and engine registration. */
export function runTaskDir(target: string, ignoreOutside = false): string | null {
  const configured = process.env.RECIPE_TASK_DIR || process.env.FARMSLOT_TASK_DIR;
  if (!configured) return null;
  const task = path.resolve(target, configured);
  const context = harnessContext();
  // App execution and checkout-level task storage have different boundaries.
  const checkoutRoot =
    context?.target.value === path.resolve(target)
      ? (context.project?.checkoutRoot ?? target)
      : target;
  const relative = path.relative(path.resolve(checkoutRoot), task);
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
    if (ignoreOutside) return null;
    throw new Error(`task directory must be inside the target checkout: ${configured}`);
  }
  return task;
}

export function registeredTaskClaims(task: string | null): RecipeClaimDeclaration[] | undefined {
  return task
    ? ledger.handoffAcceptanceCriteria(task).map(({ id, text }) => ({ id, claim: text }))
    : undefined;
}

export function recordRecipeAcceptance(
  taskDir: string,
  _target: string,
  result: {
    tracePath: string;
    recipePath: string;
    claimsPath?: string;
    selectedClaims?: RecipeClaimEvidence[];
  },
): RecipeAcceptanceRecord {
  if (!result.claimsPath) throw new Error('The engine returned no derived claim package.');
  const recorded = ledger.transferEngineClaims(
    taskDir,
    result.claimsPath,
    result.tracePath,
    result.selectedClaims,
  );
  return { recorded, refused: [] };
}
