// After a run with a task dir, the recipe's proof targets become verdicts in the
// task's acceptance ledger (artifacts/acceptance-status.json, ADR-060), written by
// the same code `farmslot-agent ac` uses, so a Farmslot run and a skill run record
// the same file. A target is `proven` when every node proving it passed, `missing`
// when one failed or did not run. When the run's recording was interrupted, a
// `proven` target is recorded `weak` instead: its evidence is incomplete, with the
// partial video as evidence. A target no node proves, and a criterion no target
// names, stay unrecorded: the run says nothing about them.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  CAPTURE_EVIDENCE_INCOMPLETE,
  type RecipeRunCaptureInterruption,
} from '@farmslot/recipe-runner';

import { isRecord } from './parse-args.js';

interface AcceptanceLedgerModule {
  AcceptanceRefusal: new (message: string) => Error;
  handoffAcceptanceCriteria(taskDir: string): Array<{ id: string; text: string }>;
  setAcceptanceVerdict(
    taskDir: string,
    input: {
      id: string;
      verdict: string;
      evidence: string[];
      recipeNodes: string[];
      note?: string;
    },
  ): unknown;
}

const require = createRequire(import.meta.url);
const ledger =
  require('@farmslot/agent-runtime/scripts/acceptance-ledger.cjs') as AcceptanceLedgerModule;

export interface RecipeAcceptanceVerdict {
  id: string;
  verdict: 'proven' | 'weak' | 'missing';
  recipeNodes: string[];
  evidence: string[];
  note?: string;
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
  result: {
    recipePath: string;
    tracePath: string;
    captureInterruption?: RecipeRunCaptureInterruption;
  },
): RecipeAcceptanceRecord {
  const record: RecipeAcceptanceRecord = { recorded: [], refused: [] };
  if (ledger.handoffAcceptanceCriteria(taskDir).length === 0) return record;
  const recipe = readJson(result.recipePath);
  const trace = readJson(result.tracePath);
  // The protocol allows a bare array of entries or `{ entries }`.
  const entries: unknown[] = Array.isArray(trace)
    ? trace
    : isRecord(trace) && Array.isArray(trace.entries)
      ? trace.entries
      : [];
  // The last entry per node is its outcome (a retried node may appear twice).
  const outcome = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (isRecord(entry) && typeof entry.nodeId === 'string') outcome.set(entry.nodeId, entry);
  }
  const workflow = isRecord(recipe) && isRecord(recipe.workflow) ? recipe.workflow : {};
  const nodes = isRecord(workflow.nodes) ? workflow.nodes : {};
  // AC1 and AC-1 name the same criterion: its provers are the nodes proving either.
  const provers = new Map<string, string[]>();
  for (const proofTarget of proofTargetIds(recipe)) {
    const id = acceptanceIdForProofTarget(proofTarget);
    if (!id) continue;
    const ids = new Set(provers.get(id));
    for (const [nodeId, node] of Object.entries(nodes)) {
      if (isRecord(node) && Array.isArray(node.proves) && node.proves.includes(proofTarget)) {
        ids.add(nodeId);
      }
    }
    provers.set(id, [...ids]);
  }
  const artifactsDir = path.dirname(result.tracePath);
  const realTaskDir = fs.realpathSync(taskDir);
  for (const [id, recipeNodes] of provers) {
    if (recipeNodes.length === 0) continue;
    const passed = recipeNodes.every((nodeId) => outcome.get(nodeId)?.ok === true);
    const interruption = result.captureInterruption;
    const verdict = !passed ? 'missing' : interruption ? 'weak' : 'proven';
    const note =
      passed && interruption
        ? `${CAPTURE_EVIDENCE_INCOMPLETE}: ${interruption.message}`
        : undefined;
    const evidence = [
      ...new Set(
        [
          result.tracePath,
          ...recipeNodes.flatMap((nodeId) =>
            nodeArtifactPaths(outcome.get(nodeId), artifactsDir, target),
          ),
          ...(interruption ? [path.resolve(artifactsDir, interruption.videoPath)] : []),
        ]
          .map((file) => taskRelative(realTaskDir, file))
          .filter((file): file is string => file !== null),
      ),
    ];
    try {
      ledger.setAcceptanceVerdict(taskDir, {
        id,
        verdict,
        evidence,
        recipeNodes,
        ...(note ? { note } : {}),
      });
      record.recorded.push({ id, verdict, evidence, recipeNodes, ...(note ? { note } : {}) });
    } catch (error) {
      if (!(error instanceof ledger.AcceptanceRefusal)) throw error;
      record.refused.push(`${id}: ${error.message}`);
    }
  }
  return record;
}

// Proof targets are `{ id, claim }` objects (the recipe contract rejects any other shape).
function proofTargetIds(recipe: unknown): string[] {
  const targets = isRecord(recipe) && Array.isArray(recipe.proofTargets) ? recipe.proofTargets : [];
  return targets
    .map((target) => (isRecord(target) ? target.id : null))
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

// The ledger keeps task-dir relative paths only. Both sides are resolved first, so a
// symlink can't carry evidence from outside the task dir in, nor a symlinked checkout
// path drop evidence that is inside.
function taskRelative(realTaskDir: string, file: string): string | null {
  // A file the run didn't leave isn't evidence; any other error reaches the run's warning.
  if (!fs.existsSync(file)) return null;
  const real = fs.realpathSync(file);
  const relative = path.relative(realTaskDir, real);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.split(path.sep).join('/');
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
