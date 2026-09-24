import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  digestRecipeDocument,
  normalizeRecipeRef,
  type QaResult,
  type Run,
  validateRecipeArtifactPackage,
  validateRecipeSuitePackage,
} from '@farmslot/protocol';

import {
  getOrchestratorTaskRoot,
  loadProjectVars,
  loadSlotVars,
  resolveProjectTaskDirName,
  resolveTaskRelDir,
} from '../core/config.js';
import { execArgvOnSlot } from '../core/exec.js';
import { slotFileExists, slotReadFile, slotRealpath, slotStat } from '../core/slot-io.js';
import { BlockedRunError } from '../run-engine/errors.js';
import { getRun } from '../runs/store.js';

const assertions = new Set(['assert_json', 'assert_output', 'ui.wait_for']);
const controls = new Set([
  'end',
  'wait',
  'manual',
  'switch',
  'call',
  'index_artifacts',
  'assert_exit_code',
  'assert_file',
]);
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
function requireProof(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new BlockedRunError(`QA evidence incomplete: ${message}`, 'qa-runtime-evidence');
}
function relative(value: unknown): asserts value is string {
  requireProof(
    typeof value === 'string' &&
      value.length > 0 &&
      !path.posix.isAbsolute(value) &&
      !value.includes('\\') &&
      value.split('/').every((part) => part !== '..' && part !== '.' && part !== ''),
    'package and artifact paths must be confined relative paths',
  );
}

export function parseQaResult(value: unknown, run: Run, headSha: string): QaResult {
  requireProof(
    record(value) && value.version === 1,
    'artifacts/qa-result.json is missing or invalid',
  );
  requireProof(
    value.runId === run.id && run.qa && isDeepStrictEqual(value.qa, run.qa),
    'result belongs to another run, preset or input snapshot',
  );
  requireProof(
    record(value.source) &&
      typeof value.source.headSha === 'string' &&
      typeof value.source.baseSha === 'string' &&
      /^[a-f0-9]{40}$/.test(value.source.headSha) &&
      /^[a-f0-9]{40}$/.test(value.source.baseSha),
    'source must identify full base/head commits',
  );
  requireProof(
    value.source.headSha === headSha,
    'executed source does not match the prepared checkout HEAD',
  );
  if (run.qaSource)
    requireProof(
      value.source.headSha === run.qaSource.headSha,
      'executed source differs from the frozen QA target',
    );
  if (run.prWork)
    requireProof(
      value.source.headSha === run.prWork.headSha,
      'PR head differs from the admitted target',
    );
  relative(value.suitePath);
  requireProof(record(value.scope), 'resolved change scope binding is missing');
  relative(value.scope.path);
  requireProof(
    typeof value.scope.digest === 'string' &&
      typeof value.scope.suiteDigest === 'string' &&
      /^sha256:[a-f0-9]{64}$/.test(value.scope.digest) &&
      /^sha256:[a-f0-9]{64}$/.test(value.scope.suiteDigest),
    'resolved scope and suite require canonical JSON digests',
  );
  requireProof(record(value.packages), 'recipe package locations are missing');
  const packages: Record<string, string> = {};
  for (const [id, packagePath] of Object.entries(value.packages)) {
    relative(packagePath);
    packages[id] = packagePath;
  }
  requireProof(
    record(value.smoke) &&
      typeof value.smoke.caseId === 'string' &&
      value.smoke.caseId.trim() &&
      typeof value.smoke.proofTarget === 'string' &&
      value.smoke.proofTarget.trim(),
    'no farm smoke case/proof was identified',
  );
  return {
    version: 1,
    runId: run.id,
    qa: structuredClone(run.qa),
    source: { baseSha: value.source.baseSha, headSha: value.source.headSha },
    scope: {
      path: value.scope.path,
      digest: value.scope.digest,
      suiteDigest: value.scope.suiteDigest,
    },
    suitePath: value.suitePath,
    packages,
    smoke: { caseId: value.smoke.caseId, proofTarget: value.smoke.proofTarget },
  };
}

/** Bind opaque skill scope to the reported commits and exact declared recipe cases. */
export function validateQaScope(result: QaResult, sourceScope: unknown, suiteScope: unknown): void {
  requireProof(
    record(sourceScope) &&
      sourceScope.baseSha === result.source.baseSha &&
      sourceScope.headSha === result.source.headSha,
    'resolved change scope differs from the reported source',
  );
  requireProof(
    digestRecipeDocument(sourceScope) === result.scope.digest,
    'resolved change scope digest differs from the retained artifact',
  );
  requireProof(
    digestRecipeDocument(suiteScope) === result.scope.suiteDigest,
    'recipe suite differs from the bound change scope',
  );
}

/** Reuse the suite's frozen cases and summary digests; no second coverage format. */
export function validateQaSuite(
  scope: unknown,
  result: unknown,
  summaries: Record<string, unknown>,
  smoke: QaResult['smoke'],
) {
  const validation = validateRecipeSuitePackage({ scope, result, summaries });
  requireProof(validation.status === 'valid', validation.findings.map((f) => f.message).join('; '));
  requireProof(
    record(scope) && Array.isArray(scope.cases) && scope.cases.length > 0,
    'dynamic recipe scope is empty',
  );
  requireProof(
    record(result) &&
      Array.isArray(result.resolutions) &&
      result.resolutions.every((entry) => entry.kind === 'verdict' && entry.status === 'pass'),
    'suite has failing, unknown or unexecuted coverage',
  );
  requireProof(
    result.resolutions.some((entry) => entry.id === smoke.caseId),
    'smoke case was not executed',
  );
}

export interface QaPackage {
  recipe: unknown;
  summary: unknown;
  trace: unknown;
  manifest: unknown;
  recipeResolution: unknown;
  resolvedRecipes: Record<string, unknown>;
  artifactPaths: string[];
}

/** Validate runtime traces, not prose, checklist status or an end-only recipe. */
export function validateQaPackage(
  bundle: QaPackage,
  startedAt: string,
  smokeProofTarget?: string,
): string {
  const checked = validateRecipeArtifactPackage(bundle);
  requireProof(
    checked.status === 'valid',
    checked.findings
      .filter((f) => f.severity === 'error')
      .map((f) => f.message)
      .join('; ') || 'invalid recipe package',
  );
  requireProof(record(bundle.summary) && bundle.summary.status === 'pass', 'recipe did not pass');
  requireProof(
    bundle.summary.stopAfterNode === undefined,
    `recipe ran partially (stop-after-node ${String(bundle.summary.stopAfterNode)}); rerun the full graph for proof`,
  );
  requireProof(
    typeof bundle.summary.startedAt === 'string' &&
      typeof bundle.summary.endedAt === 'string' &&
      Number.isFinite(Date.parse(bundle.summary.startedAt)) &&
      Date.parse(bundle.summary.startedAt) >= Date.parse(startedAt) &&
      Date.parse(bundle.summary.endedAt) >= Date.parse(bundle.summary.startedAt),
    'recipe evidence predates this execution or has invalid timestamps',
  );
  const rawTrace = Array.isArray(bundle.trace)
    ? bundle.trace
    : record(bundle.trace)
      ? bundle.trace.entries
      : undefined;
  requireProof(
    Array.isArray(rawTrace) && rawTrace.every((entry) => record(entry) && entry.ok === true),
    'recipe trace contains failed or unknown actions',
  );
  const trace = rawTrace.filter(record);
  requireProof(
    record(bundle.manifest) && Array.isArray(bundle.manifest.artifacts),
    'invalid artifact manifest',
  );
  const artifacts = bundle.manifest.artifacts.filter(record);
  requireProof(
    record(bundle.recipeResolution) && Array.isArray(bundle.recipeResolution.dependencies),
    'invalid recipe resolution',
  );
  requireProof(
    record(bundle.recipe) &&
      Array.isArray(bundle.recipe.proofTargets) &&
      bundle.recipe.proofTargets.length > 0,
    'recipe has no declared behavioral proof targets',
  );
  const documents = new Map(
    bundle.recipeResolution.dependencies.map((d: unknown): [string, unknown] => {
      requireProof(
        record(d) && typeof d.ref === 'string' && typeof d.digest === 'string',
        'invalid recipe dependency',
      );
      return [normalizeRecipeRef(d.ref), bundle.resolvedRecipes[d.digest]];
    }),
  );
  const nodes = new Map<string, Record<string, unknown>>();
  function collect(recipe: unknown, prefix = '', stack = new Set<string>()) {
    if (!record(recipe) || !record(recipe.workflow) || !record(recipe.workflow.nodes)) return;
    for (const [nodeId, raw] of Object.entries(recipe.workflow.nodes)) {
      if (!record(raw)) continue;
      const node = raw;
      const action = node.action;
      nodes.set(prefix + nodeId, node);
      if (action === 'call' && typeof node.ref === 'string') {
        const ref = normalizeRecipeRef(node.ref);
        if (!stack.has(ref))
          collect(documents.get(ref), prefix + nodeId + '/', new Set(stack).add(ref));
      }
    }
  }
  collect(bundle.recipe);
  const passing = new Map<string, Record<string, unknown>>(
    trace.map((entry): [string, Record<string, unknown>] => {
      const id = entry.nodeId ?? entry.id;
      requireProof(typeof id === 'string', 'invalid trace node identity');
      return [id, entry];
    }),
  );
  requireProof(
    trace.some(
      (entry) =>
        entry.action === 'end' &&
        entry.status === 'pass' &&
        !String(entry.nodeId ?? entry.id).includes('/'),
    ),
    'recipe has no executed passing terminal node',
  );
  function assertionProves(nodeId: string): boolean {
    const node = nodes.get(nodeId)!;
    const entry = passing.get(nodeId);
    if (!entry) return false;
    if (node.action === 'call')
      return [...nodes.keys()].some((id) => id.startsWith(nodeId + '/') && assertionProves(id));
    if (typeof node.action !== 'string' || !assertions.has(node.action)) return false;
    if (node.action === 'assert_output') {
      const source = String(node.source ?? node.node ?? '');
      const prefix = nodeId.includes('/') ? nodeId.slice(0, nodeId.lastIndexOf('/') + 1) : '';
      const action = nodes.get(prefix + source)?.action;
      return Boolean(
        typeof action === 'string' &&
        !controls.has(action) &&
        !assertions.has(action) &&
        passing.has(prefix + source) &&
        record(entry.output),
      );
    }
    if (node.action === 'ui.wait_for') {
      const currentIndex = trace.indexOf(entry);
      return (
        trace
          .slice(0, currentIndex)
          .some((step: Record<string, unknown>) =>
            [
              'ui.press',
              'ui.key_press',
              'ui.set_input',
              'ui.swipe',
              'ui.drag',
              'ui.long_press',
            ].includes(String(step.action)),
          ) && record(entry.output)
      );
    }
    // assert_json must retain the inspected runtime state, not just name an external file.
    return (
      typeof node.path === 'string' &&
      artifacts.some((artifact) => artifact.path === node.path && artifact.category === 'proof') &&
      record(entry.output)
    );
  }
  for (const target of bundle.recipe.proofTargets) {
    requireProof(record(target) && typeof target.id === 'string', 'invalid proof target');
    const linked = [...nodes].filter(
      ([, node]) => Array.isArray(node.proves) && node.proves.includes(target.id),
    );
    requireProof(
      linked.length > 0 &&
        linked.every(([id]) => passing.has(id)) &&
        linked.some(([id]) => assertionProves(id)),
      `proof target ${target.id} has no executed runtime assertion`,
    );
  }
  if (smokeProofTarget)
    requireProof(
      bundle.recipe.proofTargets.some(
        (target: unknown) => record(target) && target.id === smokeProofTarget,
      ),
      'smoke proof target is absent from the recipe',
    );
  return digestRecipeDocument(bundle.recipe);
}

/** Read only from the current worker task and verify its source before completion releases the slot. */
async function readQaCompletion(
  run: Run,
): Promise<{ packages: Array<{ path: string; digest: string }>; headSha: string }> {
  requireProof(
    run.flowType === 'qa' && run.slotId && run.taskFile && run.qa,
    'QA run has no admitted preset, task or slot',
  );
  const generation = run.engineState?.generation ?? 0;
  const vars = await loadSlotVars(run.slotId);
  const project = await loadProjectVars(run.project);
  const taskRelative = resolveTaskRelDir(
    run.taskFile,
    getOrchestratorTaskRoot(run.project, project.projectJson),
  );
  requireProof(taskRelative, 'QA task directory cannot be resolved');
  const root = path.join(
    vars.remoteRepo,
    resolveProjectTaskDirName(project.projectJson),
    taskRelative,
    'artifacts',
  );
  requireProof(await slotFileExists(vars, root), 'worker artifact directory is missing');
  const canonicalRoot = await slotRealpath(vars, root);
  requireProof(
    canonicalRoot === path.join(await slotRealpath(vars, path.dirname(root)), 'artifacts'),
    'worker artifact root is redirected',
  );
  async function file(relativePath: string, nonempty = true): Promise<string> {
    relative(relativePath);
    const full = path.join(root, relativePath);
    requireProof(await slotFileExists(vars, full), `missing ${relativePath}`);
    const canonical = await slotRealpath(vars, full);
    requireProof(
      canonical.startsWith(canonicalRoot + path.sep),
      `artifact escapes the task: ${relativePath}`,
    );
    const stat = await slotStat(vars, full);
    requireProof(
      stat.isFile && (!nonempty || stat.size > 0),
      `artifact is empty or not a file: ${relativePath}`,
    );
    return full;
  }
  const read = async (name: string): Promise<unknown> =>
    JSON.parse(await slotReadFile(vars, await file(name)));
  const head = await execArgvOnSlot(vars, ['git', 'rev-parse', 'HEAD']);
  requireProof(head.exitCode === 0, 'prepared checkout HEAD is unavailable');
  let result: QaResult;
  try {
    result = parseQaResult(await read('qa-result.json'), run, head.stdout.trim());
  } catch (error) {
    if (error instanceof BlockedRunError) throw error;
    throw new BlockedRunError(`QA evidence incomplete: ${String(error)}`, 'qa-runtime-evidence');
  }
  const base = await execArgvOnSlot(vars, ['git', 'cat-file', '-t', result.source.baseSha]);
  requireProof(
    base.exitCode === 0 && base.stdout.trim() === 'commit',
    'resolved base commit is unavailable',
  );
  const packages: Array<{ path: string; digest: string }> = [];
  const scope = await read(`${result.suitePath}/suite-scope.json`);
  const suiteResult = await read(`${result.suitePath}/suite-result.json`);
  validateQaScope(result, await read(result.scope.path), scope);
  requireProof(
    record(scope) &&
      Array.isArray(scope.cases) &&
      scope.cases.length > 0 &&
      record(suiteResult) &&
      Array.isArray(suiteResult.resolutions),
    'dynamic recipe scope is empty or malformed',
  );
  const summaries: Record<string, unknown> = {};
  const selections: Array<{ path: string; summary: unknown; smokeProofTarget?: string }> = [];
  requireProof(
    Object.keys(result.packages).length === suiteResult.resolutions.length,
    'recipe package locations do not match the suite cases',
  );
  for (const resolution of suiteResult.resolutions) {
    requireProof(
      record(resolution) &&
        typeof resolution.id === 'string' &&
        resolution.kind === 'verdict' &&
        resolution.status === 'pass',
      'suite has failing, unknown or unexecuted coverage',
    );
    relative(resolution.summary_path);
    const packagePath = Object.hasOwn(result.packages, resolution.id)
      ? result.packages[resolution.id]
      : undefined;
    relative(packagePath);
    summaries[resolution.summary_path] = await read(
      `${result.suitePath}/${resolution.summary_path}`,
    );
    selections.push({
      path: packagePath,
      summary: summaries[resolution.summary_path],
      ...(resolution.id === result.smoke.caseId
        ? { smokeProofTarget: result.smoke.proofTarget }
        : {}),
    });
  }
  validateQaSuite(scope, suiteResult, summaries, result.smoke);
  for (const item of selections) {
    const get = (name: string) => read(`${item.path}/${name}`);
    const [recipe, summary, trace, manifest, recipeResolution] = await Promise.all(
      [
        'recipe.json',
        'summary.json',
        'trace.json',
        'artifact-manifest.json',
        'recipe-resolution.json',
      ].map(get),
    );
    requireProof(
      isDeepStrictEqual(summary, item.summary),
      'recipe package summary differs from the suite evidence',
    );
    requireProof(
      record(manifest) &&
        Array.isArray(manifest.artifacts) &&
        record(recipeResolution) &&
        Array.isArray(recipeResolution.dependencies),
      'malformed recipe manifest or resolution',
    );
    const resolvedRecipes: Record<string, unknown> = {};
    const artifactPaths = new Set([
      'recipe.json',
      'summary.json',
      'trace.json',
      'artifact-manifest.json',
      'recipe-resolution.json',
    ]);
    for (const dependency of recipeResolution.dependencies) {
      requireProof(
        record(dependency) && typeof dependency.digest === 'string',
        'invalid recipe dependency',
      );
      relative(dependency.artifact);
      resolvedRecipes[dependency.digest] = await get(dependency.artifact);
      artifactPaths.add(dependency.artifact);
    }
    for (const artifact of manifest.artifacts) {
      requireProof(record(artifact), 'invalid artifact entry');
      relative(artifact.path);
      await file(
        `${item.path}/${artifact.path}`,
        artifact.category === 'proof' || ['screenshot', 'video'].includes(String(artifact.type)),
      );
      artifactPaths.add(artifact.path);
    }
    const digest = validateQaPackage(
      {
        recipe,
        summary,
        trace,
        manifest,
        recipeResolution,
        resolvedRecipes,
        artifactPaths: [...artifactPaths],
      },
      run.steps.find((s) => s.name === 'dispatch')?.startedAt ?? run.startedAt ?? run.createdAt,
      item.smokeProofTarget,
    );
    packages.push({ path: item.path, digest });
  }
  const after = await execArgvOnSlot(vars, ['git', 'rev-parse', 'HEAD']);
  requireProof(
    after.exitCode === 0 && after.stdout.trim() === result.source.headSha,
    'checkout changed during validation',
  );
  const latest = getRun(run.id);
  requireProof(
    latest &&
      latest.slotId === run.slotId &&
      (latest.engineState?.generation ?? 0) === generation &&
      !['cancelled', 'failed', 'paused'].includes(latest.status),
    'run ownership changed during validation',
  );
  return { packages, headSha: result.source.headSha };
}

export async function assertQaCompletion(run: Run) {
  try {
    return await readQaCompletion(run);
  } catch (error) {
    if (error instanceof BlockedRunError) throw error;
    throw new BlockedRunError(
      `QA evidence incomplete: ${error instanceof Error ? error.message : String(error)}`,
      'qa-runtime-evidence',
    );
  }
}
