import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  isRecipeQualityArtifact,
  RECIPE_QUALITY_ARTIFACT_VERSION,
  type RecipeQualityArtifact,
  type RecipeQualityArtifactSource,
  type RecipeQualityCompactProjection,
  type RecipeQualitySignal,
  type RecipeQualityVerdict,
  type Run,
} from '@farmslot/protocol';

const RECIPE_QUALITY_FILENAME = 'recipe-quality.json';
const RECIPE_QUALITY_MARKER = `artifacts/${RECIPE_QUALITY_FILENAME}`;

export interface RecipeQualityEvaluation {
  artifact: RecipeQualityArtifact;
  signal: RecipeQualitySignal;
}

interface RecipeQualityEvaluationInput {
  run: Pick<Run, 'id' | 'flowType' | 'project' | 'taskFile' | 'slotId'>;
  workerReport?: string | null;
  recipeJson?: string | null;
  recipeCoverage?: string | null;
  /**
   * Artifacts directory to read recipe-quality.json from. Defaults to the run's
   * own task-dir artifacts; callers serving a different artifact root (worker,
   * inherited, promoted) pass it so the SAME structural-merged signal is computed
   * for that root — the per-run badge and family leaderboard never diverge.
   */
  artifactDir?: string | null;
}

interface StructuralRecipeEvaluation {
  verdict: RecipeQualityVerdict;
  dimensions: RecipeQualityArtifact['dimensions'];
  structural_findings: RecipeQualityArtifact['structural_findings'];
  suggested_recipe_delta: string[];
  proof_mode: RecipeQualityArtifact['training_fields']['proof_mode'];
}

function verdictToCompact(
  verdict: RecipeQualityVerdict,
): RecipeQualityCompactProjection['verdict'] {
  switch (verdict) {
    case 'pass':
      return 'PASS';
    case 'warn':
      return 'WARN';
    case 'fail':
    default:
      return 'FAIL';
  }
}

function verdictToSemantic(verdict: RecipeQualityVerdict): RecipeQualitySignal['semantic'] {
  switch (verdict) {
    case 'pass':
      return 'good';
    case 'warn':
      return 'ok';
    case 'fail':
    default:
      return 'bad';
  }
}

function inferFarm(project: string): string {
  return project.replace(/-farm$/, '');
}

function hasRatio(text: string | null | undefined): boolean {
  return Boolean(text && /(\d+)\s*\/\s*(\d+)/.test(text));
}

function worstVerdict(a: RecipeQualityVerdict, b: RecipeQualityVerdict): RecipeQualityVerdict {
  const order: Record<RecipeQualityVerdict, number> = { pass: 0, warn: 1, fail: 2 };
  return order[a] >= order[b] ? a : b;
}

function taskDirFromRun(run: Pick<Run, 'taskFile'>): string | null {
  return run.taskFile ? path.dirname(run.taskFile) : null;
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function buildSignal(runId: string, artifact: RecipeQualityArtifact): RecipeQualitySignal {
  const fallbackSource = artifact.meta.fallback_source;
  const source: RecipeQualitySignal['source'] =
    fallbackSource === 'fallback:recipe-coverage'
      ? 'recipe-coverage'
      : fallbackSource === 'fallback:recipe-json'
        ? 'recipe-json'
        : fallbackSource === 'fallback:report'
          ? 'report'
          : fallbackSource === 'fallback:missing'
            ? 'missing'
            : 'recipe-quality';
  return {
    runId,
    semantic: verdictToSemantic(artifact.verdict),
    score: artifact.verdict === 'pass' ? 100 : artifact.verdict === 'warn' ? 60 : 20,
    source,
    reasoning: artifact.compact.reasons.join(' ') || 'Recipe quality artifact present.',
  };
}

function buildArtifact(params: {
  verdict: RecipeQualityVerdict;
  reasons: string[];
  betterVersionGuidance?: string[];
  producer: RecipeQualityArtifactSource;
  legacyTask: boolean;
  artifactRequired: boolean;
  sourceSignals: string[];
  fallbackSource?: Exclude<RecipeQualityArtifactSource, 'worker' | 'gateway'>;
  run: Pick<Run, 'project' | 'flowType'>;
  dimensions?: RecipeQualityArtifact['dimensions'];
  structuralFindings?: RecipeQualityArtifact['structural_findings'];
  contextualFindings?: RecipeQualityArtifact['contextual_findings'];
  suggestedRecipeDelta?: string[];
  proofMode?: RecipeQualityArtifact['training_fields']['proof_mode'];
}): RecipeQualityArtifact {
  const {
    verdict,
    reasons,
    betterVersionGuidance = [],
    producer,
    legacyTask,
    artifactRequired,
    sourceSignals,
    fallbackSource,
    run,
    dimensions = {},
    structuralFindings = [],
    contextualFindings = [],
    suggestedRecipeDelta = [],
    proofMode = 'unknown',
  } = params;

  return {
    version: RECIPE_QUALITY_ARTIFACT_VERSION,
    verdict,
    compact: {
      verdict: verdictToCompact(verdict),
      reasons,
      better_version_guidance: betterVersionGuidance,
    },
    dimensions,
    structural_findings: structuralFindings,
    contextual_findings: contextualFindings,
    suggested_recipe_delta: suggestedRecipeDelta,
    training_fields: {
      farm: inferFarm(run.project),
      project: run.project,
      flow_type: run.flowType,
      task_type: run.flowType,
      proof_mode: proofMode,
      anti_patterns: [],
      good_patterns: [],
    },
    meta: {
      producer,
      fallback_used: producer !== 'worker',
      fallback_source: fallbackSource,
      legacy_task: legacyTask,
      artifact_required: artifactRequired,
      source_signals: sourceSignals,
    },
  };
}

function evaluateRecipeStructure(
  recipeJson: string | null | undefined,
): StructuralRecipeEvaluation {
  if (!recipeJson) {
    return {
      verdict: 'warn',
      dimensions: {},
      structural_findings: [],
      suggested_recipe_delta: [],
      proof_mode: 'unknown',
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(recipeJson);
  } catch {
    return {
      verdict: 'fail',
      dimensions: {
        graph_integrity: {
          status: 'fail',
          reason: 'recipe.json is not valid JSON.',
          evidence: ['recipe.json'],
        },
      },
      structural_findings: [
        {
          code: 'invalid-recipe-json',
          message: 'recipe.json could not be parsed as JSON.',
          evidence: ['recipe.json'],
        },
      ],
      suggested_recipe_delta: [
        'Regenerate recipe.json as valid JSON before relying on recipe quality.',
      ],
      proof_mode: 'unknown',
    };
  }

  const workflow =
    parsed?.validate?.workflow ??
    parsed?.workflow ??
    (parsed &&
    typeof parsed === 'object' &&
    typeof parsed.entry === 'string' &&
    parsed.nodes &&
    typeof parsed.nodes === 'object'
      ? parsed
      : null);
  const findings: RecipeQualityArtifact['structural_findings'] = [];
  const dimensions: RecipeQualityArtifact['dimensions'] = {};
  const suggestions = new Set<string>();
  let verdict: RecipeQualityVerdict = 'pass';
  let proofMode: StructuralRecipeEvaluation['proof_mode'] = 'unknown';

  if (
    workflow &&
    typeof workflow === 'object' &&
    typeof workflow.entry === 'string' &&
    workflow.nodes &&
    typeof workflow.nodes === 'object'
  ) {
    proofMode = 'mixed';
    const nodes = workflow.nodes as Record<string, Record<string, unknown>>;
    if (!nodes[workflow.entry]) {
      verdict = worstVerdict(verdict, 'fail');
      findings.push({
        code: 'missing-entry-node',
        message: `Workflow entry "${workflow.entry}" is not present in nodes.`,
        evidence: ['recipe.json'],
      });
    }

    const referenced = new Set<string>();
    for (const [nodeId, node] of Object.entries(nodes)) {
      if (typeof node.action !== 'string' || node.action.length === 0) {
        verdict = worstVerdict(verdict, 'fail');
        findings.push({
          code: 'missing-node-action',
          message: `Node "${nodeId}" is missing a string action.`,
          evidence: ['recipe.json'],
        });
      }
      if (node.action === 'manual') {
        verdict = worstVerdict(verdict, 'fail');
        findings.push({
          code: 'manual-action',
          message: `Node "${nodeId}" uses manual action, which violates shared recipe-quality rules.`,
          evidence: ['recipe.json'],
        });
        suggestions.add(
          'Replace manual steps with executable actions or explicit UNTESTABLE rationale.',
        );
      }
      if (typeof node.next === 'string') referenced.add(node.next);
      if (typeof node.default === 'string') referenced.add(node.default);
      if (Array.isArray(node.cases)) {
        for (const entry of node.cases) {
          if (entry && typeof entry === 'object' && typeof entry.next === 'string')
            referenced.add(entry.next);
        }
      }
    }

    for (const target of referenced) {
      if (!nodes[target] && target !== 'end') {
        verdict = worstVerdict(verdict, 'fail');
        findings.push({
          code: 'missing-next-target',
          message: `Workflow references missing target "${target}".`,
          evidence: ['recipe.json'],
        });
      }
    }

    const reachable = new Set<string>();
    const queue = [workflow.entry];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || reachable.has(current) || !nodes[current]) continue;
      reachable.add(current);
      const node = nodes[current];
      if (typeof node.next === 'string') queue.push(node.next);
      if (typeof node.default === 'string') queue.push(node.default);
      if (Array.isArray(node.cases)) {
        for (const entry of node.cases) {
          if (entry && typeof entry === 'object' && typeof entry.next === 'string')
            queue.push(entry.next);
        }
      }
    }

    const unreachable = Object.keys(nodes).filter((nodeId) => !reachable.has(nodeId));
    if (unreachable.length > 0) {
      verdict = worstVerdict(verdict, 'warn');
      findings.push({
        code: 'unreachable-nodes',
        message: `Workflow contains unreachable nodes: ${unreachable.join(', ')}`,
        evidence: ['recipe.json'],
      });
      suggestions.add('Remove unreachable nodes or reconnect them from the active workflow graph.');
    }

    dimensions.graph_integrity = {
      status: verdict === 'fail' ? 'fail' : unreachable.length > 0 ? 'warn' : 'pass',
      reason:
        verdict === 'fail'
          ? 'Workflow graph has missing entry, missing targets, or invalid node actions.'
          : unreachable.length > 0
            ? 'Workflow graph is valid but contains unreachable nodes.'
            : 'Workflow graph is structurally valid.',
      evidence: ['recipe.json'],
    };
    dimensions.action_contract = {
      status: findings.some(
        (finding) => finding.code === 'manual-action' || finding.code === 'missing-node-action',
      )
        ? 'fail'
        : 'pass',
      reason: findings.some((finding) => finding.code === 'manual-action')
        ? 'Recipe contains manual or malformed actions.'
        : 'All graph nodes expose executable action strings.',
      evidence: ['recipe.json'],
    };
  } else if (Array.isArray(parsed?.steps)) {
    proofMode = 'unknown';
    const badStep = parsed.steps.find(
      (step: unknown) =>
        !step ||
        typeof step !== 'object' ||
        typeof (step as Record<string, unknown>).action !== 'string',
    );
    if (badStep) {
      verdict = 'fail';
      findings.push({
        code: 'invalid-step-shape',
        message: 'Legacy step recipe contains an entry without a string action.',
        evidence: ['recipe.json'],
      });
    }
    dimensions.graph_integrity = {
      status: verdict === 'fail' ? 'fail' : 'pass',
      reason:
        verdict === 'fail'
          ? 'Legacy step recipe has invalid step shape.'
          : 'Legacy step recipe has executable actions.',
      evidence: ['recipe.json'],
    };
    dimensions.action_contract = {
      status: verdict === 'fail' ? 'fail' : 'pass',
      reason:
        verdict === 'fail'
          ? 'At least one step is missing an action.'
          : 'Legacy step recipe steps declare action strings.',
      evidence: ['recipe.json'],
    };
    if (
      parsed.steps.some(
        (step: unknown) =>
          typeof (step as Record<string, unknown>)?.action === 'string' &&
          (step as Record<string, unknown>).action === 'manual',
      )
    ) {
      verdict = 'fail';
      findings.push({
        code: 'manual-step-action',
        message: 'Legacy step recipe contains a manual action.',
        evidence: ['recipe.json'],
      });
      suggestions.add('Replace manual steps with executable actions.');
    }
  } else {
    verdict = 'fail';
    findings.push({
      code: 'unknown-recipe-structure',
      message: 'recipe.json does not expose a recognized workflow or legacy step structure.',
      evidence: ['recipe.json'],
    });
    dimensions.graph_integrity = {
      status: 'fail',
      reason: 'Recipe structure is not recognized by the shared evaluator.',
      evidence: ['recipe.json'],
    };
    suggestions.add(
      'Write recipe.json as a workflow graph or legacy step list with executable actions.',
    );
  }

  return {
    verdict,
    dimensions,
    structural_findings: findings,
    suggested_recipe_delta: [...suggestions],
    proof_mode: proofMode,
  };
}

function mergeStructuralEvaluation(
  artifact: RecipeQualityArtifact,
  structural: StructuralRecipeEvaluation,
): RecipeQualityArtifact {
  const verdict = worstVerdict(artifact.verdict, structural.verdict);
  const reasons = [...artifact.compact.reasons];
  if (structural.verdict === 'fail')
    reasons.push('Shared gateway checks found structural recipe issues.');
  if (structural.verdict === 'warn')
    reasons.push('Shared gateway checks found weak but non-fatal recipe structure.');

  return {
    ...artifact,
    verdict,
    compact: {
      ...artifact.compact,
      verdict: verdictToCompact(verdict),
      reasons: [...new Set(reasons)],
    },
    dimensions: {
      ...artifact.dimensions,
      ...structural.dimensions,
    },
    structural_findings: [...artifact.structural_findings, ...structural.structural_findings],
    suggested_recipe_delta: [
      ...new Set([...artifact.suggested_recipe_delta, ...structural.suggested_recipe_delta]),
    ],
    training_fields: {
      ...artifact.training_fields,
      proof_mode: artifact.training_fields.proof_mode ?? structural.proof_mode,
    },
  };
}

function buildFallbackEvaluation(
  input: RecipeQualityEvaluationInput & {
    legacyTask: boolean;
    artifactRequired: boolean;
  },
): RecipeQualityEvaluation {
  const {
    run,
    workerReport = null,
    recipeJson = null,
    recipeCoverage = null,
    legacyTask,
    artifactRequired,
  } = input;
  const sourceSignals: string[] = [];
  if (recipeCoverage) sourceSignals.push('recipe-coverage.md');
  if (recipeJson) sourceSignals.push('recipe.json');
  if (workerReport) sourceSignals.push('report.md');

  if (hasRatio(recipeCoverage)) {
    const artifact = buildArtifact({
      verdict: 'warn',
      reasons: [
        'Only legacy recipe-coverage.md was available; shared recipe-quality.json was missing.',
      ],
      betterVersionGuidance: [
        'Keep recipe-coverage.md complete; the gateway derives recipe-quality from it.',
      ],
      producer: 'fallback:recipe-coverage',
      fallbackSource: 'fallback:recipe-coverage',
      legacyTask,
      artifactRequired,
      sourceSignals,
      run,
      dimensions: {
        evidence_contract_basics: {
          status: 'warn',
          reason: 'Legacy fallback signal used instead of canonical artifact.',
          evidence: ['recipe-coverage.md'],
        },
      },
      proofMode: 'mixed',
    });
    return { artifact, signal: buildSignal(run.id, artifact) };
  }

  if (recipeJson) {
    // The gateway is the sole producer: recipe quality is derived from the recipe
    // structure. Start at `pass` and let mergeStructuralEvaluation worst-merge the
    // structural verdict in — a structurally valid recipe earns `good`, a weak one
    // `warn`, a broken one `fail`. (Previously hardcoded `warn`, which capped every
    // worker that stopped hand-authoring recipe-quality.json at `ok`.)
    const artifact = buildArtifact({
      verdict: 'pass',
      reasons: ['Recipe quality derived from recipe structure (gateway sole producer).'],
      betterVersionGuidance: [
        'Keep recipe.json + recipe-coverage.md complete so structure fully proves the claim.',
      ],
      producer: 'fallback:recipe-json',
      fallbackSource: 'fallback:recipe-json',
      legacyTask,
      artifactRequired,
      sourceSignals,
      run,
      dimensions: {
        evidence_contract_basics: {
          status: 'pass',
          reason: 'Recipe quality is derived from the recipe structure.',
          evidence: ['recipe.json'],
        },
      },
      proofMode: 'unknown',
    });
    return { artifact, signal: buildSignal(run.id, artifact) };
  }

  if (workerReport) {
    const artifact = buildArtifact({
      verdict: 'warn',
      reasons: [
        'Only report.md was available; no structured recipe-quality artifact or recipe evidence was present.',
      ],
      betterVersionGuidance: [
        'Add recipe.json + recipe-coverage.md so quality derives from real proof, not prose.',
      ],
      producer: 'fallback:report',
      fallbackSource: 'fallback:report',
      legacyTask,
      artifactRequired,
      sourceSignals,
      run,
      dimensions: {
        evidence_contract_basics: {
          status: 'warn',
          reason: 'Recipe quality was inferred from prose only.',
          evidence: ['report.md'],
        },
      },
      proofMode: 'unknown',
    });
    return { artifact, signal: buildSignal(run.id, artifact) };
  }

  const artifact = buildArtifact({
    verdict: 'fail',
    reasons: ['No recipe-quality signal was available for this task.'],
    betterVersionGuidance: [
      'Emit recipe-quality.json during recipe-writing or recipe-review flows.',
      'Do not rely on missing evidence to imply recipe quality.',
    ],
    producer: 'fallback:missing',
    fallbackSource: 'fallback:missing',
    legacyTask,
    artifactRequired,
    sourceSignals,
    run,
    dimensions: {
      evidence_contract_basics: {
        status: 'fail',
        reason: 'No usable quality signal was present.',
        evidence: [],
      },
    },
    structuralFindings: [
      {
        code: 'missing-recipe-quality-signal',
        message:
          'No recipe-quality artifact, coverage file, recipe artifact, or report was available.',
      },
    ],
    proofMode: 'unknown',
  });
  return { artifact, signal: buildSignal(run.id, artifact) };
}

export async function loadRecipeQualityEvaluation(
  input: RecipeQualityEvaluationInput,
): Promise<RecipeQualityEvaluation> {
  const { run } = input;
  const taskDir = taskDirFromRun(run);
  const taskText = run.taskFile ? await readTextIfExists(run.taskFile) : null;
  const legacyTask = !taskText?.includes(RECIPE_QUALITY_MARKER);
  const artifactsDir = input.artifactDir ?? (taskDir ? path.join(taskDir, 'artifacts') : null);
  const artifactText = artifactsDir
    ? await readTextIfExists(path.join(artifactsDir, RECIPE_QUALITY_FILENAME))
    : null;
  const structural = evaluateRecipeStructure(input.recipeJson);

  // The gateway is the sole producer of recipe-quality.json (ADR/roadmap:
  // run-metrics consolidation). A previously-generated, schema-valid artifact is
  // reused for idempotency; anything else (absent, unparseable, or non-conformant)
  // is regenerated from the recipe structure — never salvaged or fabricated into a
  // misleading fail. Workers no longer hand-author this file.
  if (artifactText) {
    try {
      const parsed = JSON.parse(artifactText);
      if (isRecipeQualityArtifact(parsed)) {
        const artifact = mergeStructuralEvaluation(parsed as RecipeQualityArtifact, structural);
        return { artifact, signal: buildSignal(run.id, artifact) };
      }
      console.warn(
        `[recipe-quality] ${RECIPE_QUALITY_FILENAME} did not match the shared schema; regenerating from recipe structure.`,
      );
    } catch (error) {
      console.warn(
        `[recipe-quality] failed to parse ${RECIPE_QUALITY_FILENAME}; regenerating from recipe structure: ${(error as Error).message}`,
      );
    }
  }

  const evaluation = buildFallbackEvaluation({
    ...input,
    legacyTask,
    // The gateway is the sole producer: recipe-quality.json is never "required"
    // from the worker, so a missing file is regenerated from structure, not failed.
    artifactRequired: false,
  });
  const artifact = mergeStructuralEvaluation(evaluation.artifact, structural);
  return { artifact, signal: buildSignal(run.id, artifact) };
}
