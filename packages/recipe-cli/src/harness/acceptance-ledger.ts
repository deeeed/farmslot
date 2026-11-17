// Task transport only. The engine derives verdicts; the task ledger has no reducer.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  ACCEPTANCE_CRITERION_ID_PATTERN,
  normalizeRecipeClaimId,
  type RecipeClaimDeclaration,
  type RecipeClaimEvidence,
} from '@farmslot/protocol';

import { harnessContext } from './context-state.js';
import { invokedHostCommand } from './host.js';

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

export type RecipeExecutionCommand = 'run' | 'call';

export class RecipeTaskBindingRequiredError extends Error {
  readonly code = 'RECIPE_TASK_UNBOUND';
  readonly userAction: string;

  constructor(storage: string, command: RecipeExecutionCommand) {
    super(
      `Task storage exists at ${storage}, but no recipe task is bound; set RECIPE_TASK_DIR or FARMSLOT_TASK_DIR in the same shell invocation, or pass --unbound for diagnostics without task acceptance.`,
    );
    this.name = 'RecipeTaskBindingRequiredError';
    const argument = command === 'run' ? '<recipe.json>' : '<action>';
    this.userAction = `RECIPE_TASK_DIR='<task-directory>' ${invokedHostCommand()} ${command} '${argument}'`;
  }
}

export class RecipeTaskBindingConflictError extends Error {
  readonly code = 'RECIPE_TASK_BINDING_CONFLICT';
  readonly userAction: string;

  constructor(command: RecipeExecutionCommand) {
    super(
      'You cannot combine --unbound or FARMSLOT_RECIPE_UNBOUND=1 with RECIPE_TASK_DIR or FARMSLOT_TASK_DIR.',
    );
    this.name = 'RecipeTaskBindingConflictError';
    const argument = command === 'run' ? '<recipe.json>' : '<action>';
    this.userAction = `env -u RECIPE_TASK_DIR -u FARMSLOT_TASK_DIR ${invokedHostCommand()} ${command} '${argument}' --unbound`;
  }
}

function taskProjectBinding(target: string) {
  const context = harnessContext();
  return context?.target.value === path.resolve(target) ? context.project : undefined;
}

/** Explicit diagnostics opt out; task storage is checked without scanning retained tasks. */
export function requireRecipeTaskBinding(
  target: string,
  ignoreOutside: boolean,
  unbound: boolean,
  command: RecipeExecutionCommand,
): string | null {
  if (unbound || process.env.FARMSLOT_RECIPE_UNBOUND === '1') {
    if (process.env.RECIPE_TASK_DIR || process.env.FARMSLOT_TASK_DIR)
      throw new RecipeTaskBindingConflictError(command);
    return null;
  }
  const task = runTaskDir(target, ignoreOutside);
  if (task) return task;
  const project = taskProjectBinding(target);
  const storage = path.resolve(
    project?.checkoutRoot ?? target,
    project?.artifactDir ?? 'temp/tasks',
  );
  if (fs.statSync(storage, { throwIfNoEntry: false }))
    throw new RecipeTaskBindingRequiredError(storage, command);
  return null;
}

export function acceptanceIdForProofTarget(target: string): string | null {
  const id = normalizeRecipeClaimId(target.trim());
  return ACCEPTANCE_CRITERION_ID_PATTERN.test(id) ? id : null;
}

/** Resolve the task once for CLI artifacts and engine registration. */
export function runTaskDir(target: string, ignoreOutside = false): string | null {
  const configured = process.env.RECIPE_TASK_DIR || process.env.FARMSLOT_TASK_DIR;
  if (!configured) return null;
  // App execution and checkout-level task storage have different boundaries.
  const checkoutRoot = taskProjectBinding(target)?.checkoutRoot ?? target;
  const task = path.resolve(checkoutRoot, configured);
  // An explicitly bound task owns its artifacts independently of the app checkout.
  if (path.isAbsolute(configured)) return task;
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
