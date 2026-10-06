// After a run with a task dir, the recipe's proof targets become verdicts in the
// task's acceptance ledger (artifacts/acceptance-status.json, ADR-060), written by
// the same code `farmslot-agent ac` uses, so a Farmslot run and a skill run record
// the same file. A target is `proven` when every node proving it passed, `missing`
// when one failed or did not run. A target no node proves, and a criterion no
// target names, stay unrecorded: the run says nothing about them.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { isRecord } from './parse-args.js';

interface AcceptanceLedgerModule {
  AcceptanceRefusal: new (message: string) => Error;
  handoffAcceptanceCriteria(taskDir: string): Array<{ id: string; text: string }>;
  setAcceptanceVerdict(
    taskDir: string,
    input: { id: string; verdict: string; evidence: string[]; recipeNodes: string[] },
  ): unknown;
}

const require = createRequire(import.meta.url);
const ledger =
  require('@farmslot/agent-runtime/scripts/acceptance-ledger.cjs') as AcceptanceLedgerModule;

export interface RecipeAcceptanceVerdict {
  id: string;
  verdict: 'proven' | 'missing';
  recipeNodes: string[];
  evidence: string[];
}

export interface RecipeAcceptanceRecord {
  recorded: RecipeAcceptanceVerdict[];
  /** Targets the ledger refused (e.g. no such criterion in the handoff), with why. */
  refused: string[];
}

/** `AC1` and `AC-1` both name the handoff's first criterion; anything else is not an AC. */
export function acceptanceIdForProofTarget(target: string): string | null {
  const match = /^AC-?([1-9][0-9]*)$/iu.exec(target.trim());
  return match ? `AC-${match[1]}` : null;
}

export function recordRecipeAcceptance(
  taskDir: string,
  target: string,
  result: { recipePath: string; tracePath: string },
): RecipeAcceptanceRecord {
  const record: RecipeAcceptanceRecord = { recorded: [], refused: [] };
  if (ledger.handoffAcceptanceCriteria(taskDir).length === 0) return record;
  const recipe = readJson(result.recipePath);
  const trace = readJson(result.tracePath);
  const entries: unknown[] = Array.isArray(trace.entries) ? trace.entries : [];
  // The last entry per node is its outcome (a retried node may appear twice).
  const outcome = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (isRecord(entry) && typeof entry.nodeId === 'string') outcome.set(entry.nodeId, entry);
  }
  const nodes =
    isRecord(recipe.workflow) && isRecord(recipe.workflow.nodes) ? recipe.workflow.nodes : {};
  const artifactsDir = path.dirname(result.tracePath);
  for (const proofTarget of proofTargetIds(recipe)) {
    const id = acceptanceIdForProofTarget(proofTarget);
    if (!id) continue;
    const provers = Object.entries(nodes)
      .filter(
        ([, node]) =>
          isRecord(node) && Array.isArray(node.proves) && node.proves.includes(proofTarget),
      )
      .map(([nodeId]) => nodeId);
    if (provers.length === 0) continue;
    const verdict = provers.every((nodeId) => outcome.get(nodeId)?.ok === true)
      ? 'proven'
      : 'missing';
    const evidence = [
      ...new Set(
        [
          result.tracePath,
          ...provers.flatMap((nodeId) =>
            nodeArtifactPaths(outcome.get(nodeId), artifactsDir, target),
          ),
        ]
          .map((file) => taskRelative(taskDir, file))
          .filter((file): file is string => file !== null),
      ),
    ];
    try {
      ledger.setAcceptanceVerdict(taskDir, { id, verdict, evidence, recipeNodes: provers });
      record.recorded.push({ id, verdict, evidence, recipeNodes: provers });
    } catch (error) {
      if (!(error instanceof ledger.AcceptanceRefusal)) throw error;
      record.refused.push(`${proofTarget}: ${error.message}`);
    }
  }
  return record;
}

function proofTargetIds(recipe: Record<string, unknown>): string[] {
  const targets = Array.isArray(recipe.proofTargets) ? recipe.proofTargets : [];
  return targets
    .map((target) => (typeof target === 'string' ? target : isRecord(target) ? target.id : null))
    .filter((id): id is string => typeof id === 'string');
}

// A node's artifact paths are relative to the run's artifacts dir or to the checkout;
// the first that exists is the file.
function nodeArtifactPaths(
  entry: Record<string, unknown> | undefined,
  artifactsDir: string,
  target: string,
): string[] {
  const artifacts = Array.isArray(entry?.artifacts) ? entry.artifacts : [];
  return artifacts
    .map((artifact) =>
      isRecord(artifact) && typeof artifact.path === 'string' ? artifact.path : null,
    )
    .filter((file): file is string => file !== null)
    .map((file) =>
      path.isAbsolute(file)
        ? file
        : [path.resolve(artifactsDir, file), path.resolve(target, file)].find((candidate) =>
            fs.existsSync(candidate),
          ),
    )
    .filter((file): file is string => typeof file === 'string');
}

// The ledger keeps task-dir relative paths only; a file outside the task dir is not evidence it can hold.
function taskRelative(taskDir: string, file: string): string | null {
  const relative = path.relative(taskDir, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return fs.existsSync(file) ? relative.split(path.sep).join('/') : null;
}

function readJson(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  return isRecord(value) ? value : {};
}
