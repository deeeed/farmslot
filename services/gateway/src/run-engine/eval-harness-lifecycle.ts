import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_TASK_DIR,
  type EvalHarnessLifecycle,
  type EvalPackageAxisRef,
  type ResultPackageManifest,
  type Run,
} from '@farmslot/protocol';

import {
  getProjectField,
  loadProjectVars,
  loadSlotVars,
  type RawProjectJson,
} from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { expandHook } from '../core/hooks.js';
import { shellQuote } from '../core/tmux.js';
import { readResultPackageManifest, writeResultPackageManifest } from '../evals/package-store.js';
import { harnessRoot } from '../projects/harness-root.js';

export type EvalHarnessLifecyclePhase = 'install' | 'verify' | 'cleanup';

const STATUS_KEYS: Record<
  EvalHarnessLifecyclePhase,
  'installStatus' | 'verifyStatus' | 'cleanupStatus'
> = {
  install: 'installStatus',
  verify: 'verifyStatus',
  cleanup: 'cleanupStatus',
};

const LOG_KEYS: Record<
  EvalHarnessLifecyclePhase,
  'installLogPath' | 'verifyLogPath' | 'cleanupLogPath'
> = {
  install: 'installLogPath',
  verify: 'verifyLogPath',
  cleanup: 'cleanupLogPath',
};

function statusKey(
  phase: EvalHarnessLifecyclePhase,
): 'installStatus' | 'verifyStatus' | 'cleanupStatus' {
  return STATUS_KEYS[phase];
}

function logKey(
  phase: EvalHarnessLifecyclePhase,
): 'installLogPath' | 'verifyLogPath' | 'cleanupLogPath' {
  return LOG_KEYS[phase];
}

function hookName(phase: EvalHarnessLifecyclePhase): string {
  return `recipe_harness_${phase}`;
}

function inferHarnessAdapter(project: string, axis: EvalPackageAxisRef): string | undefined {
  const fromAxis = axis.version?.trim() || axis.name?.trim();
  if (fromAxis === 'mobile' || fromAxis === 'extension') return fromAxis;
  if (project.includes('mobile')) return 'mobile';
  if (project.includes('extension')) return 'extension';
  return fromAxis || undefined;
}

interface EvalHarnessCatalogEntry {
  repo_url?: string;
  path?: string;
  local_path?: string;
  default_ref?: string;
  source?: string;
}

interface ResolvedHarnessSource {
  source?: string;
  gitUrl?: string;
  relativePath: string;
  localPath?: string;
  ref?: string;
}

function harnessCatalogEntry(
  axis: EvalPackageAxisRef,
  projectJson?: RawProjectJson,
): EvalHarnessCatalogEntry | undefined {
  const requestedName = axis.name?.trim();
  const hasRequestedRef = Boolean(axis.ref?.trim() || axis.hash?.trim());
  let name = requestedName || '';
  if (!name && hasRequestedRef) name = 'recipe-harness';
  if (!name) return undefined;
  return projectJson?.eval_harnesses?.[name];
}

function requestedHarnessRef(
  axis: EvalPackageAxisRef,
  entry?: EvalHarnessCatalogEntry,
): string | undefined {
  const version = axis.version?.trim();
  return (
    axis.ref?.trim() ||
    axis.hash?.trim() ||
    (version && version !== 'mobile' && version !== 'extension' ? version : undefined) ||
    entry?.default_ref?.trim() ||
    undefined
  );
}

function fullSha(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^[0-9a-f]{40}$/i.test(trimmed) ? trimmed : undefined;
}

function requestedHarnessResolvedSha(axis: EvalPackageAxisRef): string | undefined {
  return fullSha(axis.hash) ?? fullSha(axis.ref);
}

export function assertFetchableHarnessRef(axis: EvalPackageAxisRef): void {
  const hash = axis.hash?.trim();
  if (hash && !fullSha(hash)) {
    throw new Error(
      'Eval recipe harness hash must be a full 40-character commit SHA. ' +
        `Received ${hash}; use the full skills/harness commit SHA or a named ref in harness.ref.`,
    );
  }
  const ref = requestedHarnessRef(axis);
  if (ref && !fullSha(ref) && /^[0-9a-f]{7,39}$/i.test(ref)) {
    throw new Error(
      'Eval recipe harness ref looks like an abbreviated commit SHA. ' +
        `Received ${ref}; use the full 40-character skills/harness commit SHA.`,
    );
  }
}

export function parseResolvedHarnessSha(stdout: string): string | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const sha = fullSha(lines[index]);
    if (sha) return sha;
  }
  return undefined;
}

function resolveHarnessSource(
  axis: EvalPackageAxisRef,
  projectJson?: RawProjectJson,
): ResolvedHarnessSource {
  const explicitLocalPath = axis.path?.trim();
  if (explicitLocalPath) {
    return {
      source: explicitLocalPath,
      localPath: explicitLocalPath,
      relativePath: '',
      ref: requestedHarnessRef(axis),
    };
  }

  const entry = harnessCatalogEntry(axis, projectJson);
  if (entry) {
    const localPath = entry.local_path?.trim();
    const gitUrl = entry.repo_url?.trim();
    const relativePath = entry.path?.trim() ?? '';
    const relativeSourcePath = relativePath ? `/${relativePath}` : '';
    const gitSource = gitUrl ? `${gitUrl}${relativeSourcePath}` : undefined;
    const source = entry.source?.trim() || gitSource || localPath || axis.name?.trim();
    return {
      source,
      gitUrl,
      relativePath,
      localPath,
      ref: requestedHarnessRef(axis, entry),
    };
  }

  const name = axis.name?.trim();
  if (name?.startsWith('git@') || name?.startsWith('https://')) {
    return { source: name, gitUrl: name, relativePath: '', ref: requestedHarnessRef(axis) };
  }

  return {
    source: name,
    relativePath: '',
    ref: requestedHarnessRef(axis),
  };
}

function harnessSource(axis: EvalPackageAxisRef, projectJson?: RawProjectJson): string | undefined {
  return resolveHarnessSource(axis, projectJson).source;
}

function taskFileForRun(run: Run): string | null {
  if (run.taskFile) return run.taskFile;
  const writeTaskStep = run.steps.find((step) => step.name === 'write-task');
  const taskFile = writeTaskStep?.outputs?.taskFile;
  return typeof taskFile === 'string' && taskFile.trim() ? taskFile : null;
}

function workerTaskDir(taskFile: string, repo: string, taskDirBase: string): string {
  const taskDir = path.dirname(taskFile);
  const taskFolderId = path.basename(taskDir);
  const flowSubdir = path.basename(path.dirname(taskDir));
  return path.join(repo, taskDirBase || DEFAULT_TASK_DIR, flowSubdir, taskFolderId);
}

export function materializeHarnessCommand(
  axis: EvalPackageAxisRef,
  sourceRoot: string,
  projectJson?: RawProjectJson,
): { command: string; harnessDir: string; resolvedShaCommand?: string } {
  assertFetchableHarnessRef(axis);
  const resolved = resolveHarnessSource(axis, projectJson);
  const gitUrl = resolved.gitUrl;
  const ref = resolved.ref;
  const relativePath = resolved.relativePath;
  const checkoutDir = path.join(sourceRoot, 'checkout');
  const harnessDir = gitUrl ? path.join(checkoutDir, relativePath) : (resolved.localPath ?? '');

  if (!gitUrl) {
    if (!harnessDir) {
      throw new Error(
        `Eval harness "${axis.name ?? 'unnamed'}" has no source. Define project.eval_harnesses.${axis.name ?? 'recipe-harness'} or pass harness.path.`,
      );
    }
    return {
      harnessDir,
      command: [
        `test -n ${shellQuote(harnessDir)}`,
        `test -x ${shellQuote(path.join(harnessDir, 'scripts', 'recipe-harness.sh'))}`,
      ].join(' && '),
    };
  }

  const fetch = ref
    ? [
        `git init ${shellQuote(checkoutDir)}`,
        `git -C ${shellQuote(checkoutDir)} remote add origin ${shellQuote(gitUrl)}`,
        `git -C ${shellQuote(checkoutDir)} fetch --depth 1 origin ${shellQuote(ref)}`,
        `git -C ${shellQuote(checkoutDir)} checkout --detach FETCH_HEAD`,
      ]
    : [`git clone --depth 1 ${shellQuote(gitUrl)} ${shellQuote(checkoutDir)}`];
  const command = [
    `if [ ! -x ${shellQuote(path.join(harnessDir, 'scripts', 'recipe-harness.sh'))} ]; then rm -rf ${shellQuote(checkoutDir)}; ${fetch.join(' && ')}; fi`,
    `test -x ${shellQuote(path.join(harnessDir, 'scripts', 'recipe-harness.sh'))}`,
  ].join(' && ');

  return {
    command,
    harnessDir,
    resolvedShaCommand: `git -C ${shellQuote(checkoutDir)} rev-parse HEAD`,
  };
}

export function mergeHarnessLifecycle(
  currentPackage: ResultPackageManifest,
  phase: EvalHarnessLifecyclePhase,
  patch: Partial<EvalHarnessLifecycle>,
): ResultPackageManifest {
  const axis = currentPackage.axes.harness;
  const adapter = axis ? inferHarnessAdapter(currentPackage.project, axis) : undefined;
  const normalizedPatch = resetDownstreamLifecycleOnInstall(phase, patch);
  const next: EvalHarnessLifecycle = {
    ...currentPackage.harnessLifecycle,
    source:
      normalizedPatch.source ??
      (axis ? harnessSource(axis) : currentPackage.harnessLifecycle?.source),
    requestedRef:
      normalizedPatch.requestedRef ??
      (axis ? requestedHarnessRef(axis) : currentPackage.harnessLifecycle?.requestedRef),
    resolvedSha: axis
      ? (requestedHarnessResolvedSha(axis) ?? currentPackage.harnessLifecycle?.resolvedSha)
      : currentPackage.harnessLifecycle?.resolvedSha,
    adapter: adapter ?? currentPackage.harnessLifecycle?.adapter,
    manifestPath: adapter
      ? `${harnessRoot()}/${adapter}/manifest.json`
      : currentPackage.harnessLifecycle?.manifestPath,
    ...normalizedPatch,
    updatedAt: new Date().toISOString(),
  };
  const lifecyclePhases = ['install', 'verify', 'cleanup'] as const;
  const touchedPhases = lifecyclePhases.filter(
    (candidate) => normalizedPatch[statusKey(candidate)] !== undefined,
  );
  const resolvedMissing = new Set(
    touchedPhases.flatMap((candidate) => [
      `harness-${candidate}-pending`,
      `harness-${candidate}-failed`,
    ]),
  );
  const nextMissing = currentPackage.missingData.filter((entry) => !resolvedMissing.has(entry));
  for (const candidate of touchedPhases) {
    const candidateStatus = normalizedPatch[statusKey(candidate)];
    if (candidateStatus === 'pending') nextMissing.push(`harness-${candidate}-pending`);
    if (candidateStatus === 'failed') nextMissing.push(`harness-${candidate}-failed`);
  }
  return {
    ...currentPackage,
    harnessLifecycle: next,
    missingData: [...new Set(nextMissing)],
  };
}

function resetDownstreamLifecycleOnInstall(
  phase: EvalHarnessLifecyclePhase,
  patch: Partial<EvalHarnessLifecycle>,
): Partial<EvalHarnessLifecycle> {
  if (phase !== 'install' || patch.installStatus !== 'pending') return patch;
  return {
    ...patch,
    verifyStatus: 'pending',
    cleanupStatus: 'pending',
    verifyLogPath: undefined,
    cleanupLogPath: undefined,
  };
}

async function updateHarnessLifecyclePackage(
  packagePath: string,
  phase: EvalHarnessLifecyclePhase,
  patch: Partial<EvalHarnessLifecycle>,
): Promise<ResultPackageManifest> {
  const currentPackage = await readResultPackageManifest(packagePath);
  return writeResultPackageManifest(
    packagePath,
    mergeHarnessLifecycle(currentPackage, phase, patch),
  );
}

export async function executeEvalHarnessLifecycle(
  run: Run,
  phase: EvalHarnessLifecyclePhase,
  options: { throwOnFailure?: boolean } = {},
): Promise<{ skipped: boolean; logPath?: string; status?: EvalHarnessLifecycle['installStatus'] }> {
  const link = run.engineState?.evalExperiment;
  if (!link || !run.slotId) return { skipped: true };
  const taskFile = taskFileForRun(run);
  if (!taskFile) return { skipped: true };

  const currentPackage = await readResultPackageManifest(link.packagePath);
  const harnessAxis = currentPackage.axes.harness;
  if (!harnessAxis) return { skipped: true };
  if (phase === 'cleanup' && currentPackage.harnessLifecycle?.cleanupStatus === 'passed') {
    return {
      skipped: true,
      logPath: currentPackage.harnessLifecycle.cleanupLogPath,
      status: 'passed',
    };
  }

  const vars = await loadSlotVars(run.slotId);
  const projectVars = await loadProjectVars(run.project);
  const hook = expandHook(hookName(phase), projectVars.projectJson, vars, projectVars);
  const adapter = inferHarnessAdapter(run.project, harnessAxis);
  const relativeLogPath = `artifacts/recipe-harness/${phase}.log`;
  const taskDir = workerTaskDir(
    taskFile,
    vars.remoteRepo,
    getProjectField(projectVars.projectJson, 'task_dir') || DEFAULT_TASK_DIR,
  );
  const harnessArtifactsDir = path.join(taskDir, 'artifacts', 'recipe-harness');
  const logPath = path.join(harnessArtifactsDir, `${phase}.log`);
  const verifyArtifactsDir = path.join(harnessArtifactsDir, 'verify');
  const harnessSourceRoot = path.join(harnessArtifactsDir, 'source');
  const materializedHarness = materializeHarnessCommand(
    harnessAxis,
    harnessSourceRoot,
    projectVars.projectJson,
  );
  const localHarnessArtifactsDir = path.dirname(path.join(path.dirname(taskFile), relativeLogPath));

  // Keep the local artifact folder shape stable for package readers before
  // worker artifacts are copied back at completion. Do this before running the
  // remote hook so a local filesystem issue cannot leave the manifest marked
  // passed while the gateway step throws.
  await mkdir(localHarnessArtifactsDir, { recursive: true });

  await updateHarnessLifecyclePackage(link.packagePath, phase, {
    adapter,
    source: harnessSource(harnessAxis, projectVars.projectJson),
    requestedRef: resolveHarnessSource(harnessAxis, projectVars.projectJson).ref,
    [statusKey(phase)]: 'pending',
    [logKey(phase)]: relativeLogPath,
  });

  if (!hook) {
    await updateHarnessLifecyclePackage(link.packagePath, phase, {
      [statusKey(phase)]: 'failed',
      [logKey(phase)]: relativeLogPath,
    });
    const error = new Error(
      `Eval recipe harness ${phase} hook is not configured for ${run.project}`,
    );
    if (options.throwOnFailure !== false) throw error;
    return { skipped: false, logPath: relativeLogPath, status: 'failed' };
  }

  const exports = [
    // Pass the configured harness root through to the slot so the adapter installs/
    // verifies under the same root the gateway records in manifestPath.
    `export RECIPE_HARNESS_ROOT=${shellQuote(harnessRoot())}`,
    `export FARMSLOT_EVAL_HARNESS_SOURCE=${shellQuote(harnessSource(harnessAxis, projectVars.projectJson) ?? '')}`,
    `export FARMSLOT_EVAL_HARNESS_REF=${shellQuote(resolveHarnessSource(harnessAxis, projectVars.projectJson).ref ?? '')}`,
    `export FARMSLOT_EVAL_HARNESS_ADAPTER=${shellQuote(adapter ?? '')}`,
    `export FARMSLOT_EVAL_HARNESS_DIR=${shellQuote(materializedHarness.harnessDir)}`,
    `export FARMSLOT_TASK_DIR=${shellQuote(taskDir)}`,
    `export FARMSLOT_ARTIFACTS_DIR=${shellQuote(path.join(taskDir, 'artifacts'))}`,
    `export FARMSLOT_HARNESS_VERIFY_ARTIFACTS_DIR=${shellQuote(verifyArtifactsDir)}`,
  ].join('; ');
  const command = [
    `mkdir -p ${shellQuote(harnessArtifactsDir)} ${shellQuote(verifyArtifactsDir)} ${shellQuote(harnessSourceRoot)}`,
    `(${exports}; set -e; ${materializedHarness.command}; ${hook}) > ${shellQuote(logPath)} 2>&1`,
    materializedHarness.resolvedShaCommand,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' && ');

  const result = await execOnSlot(vars, command, { timeout: phase === 'verify' ? 120000 : 60000 });
  if (result.exitCode !== 0) {
    await updateHarnessLifecyclePackage(link.packagePath, phase, {
      [statusKey(phase)]: 'failed',
      [logKey(phase)]: relativeLogPath,
    });
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    const error = new Error(`Eval recipe harness ${phase} failed for ${run.project}: ${detail}`);
    if (options.throwOnFailure !== false) throw error;
    return { skipped: false, logPath: relativeLogPath, status: 'failed' };
  }

  const resolvedSha = parseResolvedHarnessSha(result.stdout);
  await updateHarnessLifecyclePackage(link.packagePath, phase, {
    [statusKey(phase)]: 'passed',
    [logKey(phase)]: relativeLogPath,
    ...(resolvedSha ? { resolvedSha } : {}),
  });

  return { skipped: false, logPath: relativeLogPath, status: 'passed' };
}
