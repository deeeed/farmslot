// Task transport only. The engine derives verdicts; the task ledger has no reducer.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  ACCEPTANCE_CRITERION_ID_PATTERN,
  normalizeRecipeClaimId,
  type RecipeClaimDeclaration,
  type RecipeClaimEvidence,
  type RecipeClaimLedger,
} from '@farmslot/protocol';

interface AcceptanceLedgerModule {
  handoffAcceptanceCriteria(taskDir: string): Array<{ id: string; text: string }>;
  setDerivedClaims(taskDir: string, claims: RecipeClaimLedger): unknown;
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
  const relative = path.relative(path.resolve(target), task);
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
  result: { tracePath: string; recipePath: string; claimsPath?: string },
): RecipeAcceptanceRecord {
  if (!result.claimsPath) throw new Error('The engine returned no derived claim package.');
  const claims = JSON.parse(fs.readFileSync(result.claimsPath, 'utf8')) as RecipeClaimLedger;
  const root = path.dirname(result.claimsPath);
  const realTask = fs.realpathSync(taskDir);
  const criteria = claims.criteria.map((claim) => ({
    ...claim,
    evidence: [
      ...new Set([result.tracePath, ...claim.evidence.map((file) => path.resolve(root, file))]),
    ]
      .map((file) => taskRelative(realTask, file))
      .filter((file): file is string => file !== null),
  }));
  ledger.setDerivedClaims(taskDir, { ...claims, criteria });
  return { recorded: criteria, refused: [] };
}

function taskRelative(realTask: string, file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const relative = path.relative(realTask, fs.realpathSync(file));
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return null;
  return relative.split(path.sep).join('/');
}
