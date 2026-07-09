// methods/recipe.ts — recipe.rerun and recipe.cancel handlers
// Re-execute a recipe on a warm slot during review-gate.

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  Events,
  isRecord,
  type LiveRecipeContext,
  type RecipeCancelParams,
  type RecipeCancelResult,
  type RecipeCommandParams,
  type RecipeCommandResult,
  type RecipeProjectHookCommandParams,
  type RecipeProjectHookCommandResult,
  type RecipeProjectHookName,
  type RecipeProjectHookRunParams,
  type RecipeProjectHookRunResult,
  type RecipeProjectHookValidationCheck,
  type RecipeProjectHookValidationResult,
  type RecipeRerunParams,
  type RecipeValidationResult,
  type ScriptActionResult,
  validateRecipeActionManifestDocument,
  validateRecipeArtifactPackage,
} from '@farmslot/protocol';

import {
  getOrchestratorTaskRoot,
  getProjectField,
  getProjectFieldRaw,
  loadProjectVars,
  loadSlotVars,
  type ProjectVars,
  type RawProjectJson,
  resolveProjectTaskDirName,
  resolveTaskRelDir,
  type SlotVars,
} from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import { expandHook, expandTemplate } from '../core/hooks.js';
import {
  isShellHomePath,
  normalizeRemotePath,
  resolvePathWithinRemoteBase,
  shellExpressionForRemotePath,
} from '../core/remote-paths.js';
import { resolveTmuxSession, shellQuote } from '../core/tmux.js';
import { loadFleetStatus } from '../fleet/state.js';
import {
  attachLiveRecipeContext,
  listRecipeRunArtifactGroupsForRun,
} from '../live-recipe/context.js';
import { getRun, updateRun } from '../runs/store.js';

import { runHealthCheck } from './slot/check.js';

type EmitFn = (event: string, payload: unknown) => void;

interface WarmthCheck {
  check: 'tmux' | 'devserver' | 'branch';
  severity: 'hard' | 'soft';
  message: string;
}

interface WarmthResult {
  warm: boolean;
  warnings: WarmthCheck[];
}

interface ActiveRerun {
  requestId: string;
  abortController: AbortController;
}

const activeReruns = new Map<string, ActiveRerun>();

const DEFAULT_TIMEOUT_MS = 300_000;
const ARTIFACT_RUN_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MIN_PLAYBACK_SLOW_MS = 100;
const MAX_PLAYBACK_SLOW_MS = 60_000;
const RECIPE_PROJECT_HOOKS = new Set<RecipeProjectHookName>([
  'recipe_action_manifest',
  'recipe_doctor',
  'recipe_run',
]);

function addHookValidationCheck(
  checks: RecipeProjectHookValidationCheck[],
  id: string,
  status: RecipeProjectHookValidationCheck['status'],
  message: string,
): void {
  checks.push({ id, status, message });
}

function assertRecipeProjectHookName(hook: string): asserts hook is RecipeProjectHookName {
  if (!RECIPE_PROJECT_HOOKS.has(hook as RecipeProjectHookName)) {
    throw new Error(
      `Unsupported Recipe v1 project hook ${hook}. Expected recipe_action_manifest, recipe_doctor, or recipe_run.`,
    );
  }
}

function parseProjectHookJson(hook: RecipeProjectHookName, stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`hooks.${hook} must print valid JSON: ${message}`);
  }
}

function validateRecipeDoctorJson(document: unknown): RecipeProjectHookValidationResult {
  const checks: RecipeProjectHookValidationCheck[] = [];
  addHookValidationCheck(
    checks,
    'doctor.document',
    isRecord(document) ? 'pass' : 'fail',
    'recipe_doctor output must be a JSON object.',
  );
  if (!isRecord(document)) return { status: 'fail', checks };

  addHookValidationCheck(
    checks,
    'doctor.runner_protocol_version',
    document.runner_protocol_version === 1 ? 'pass' : 'fail',
    'recipe_doctor must report runner_protocol_version: 1.',
  );
  addHookValidationCheck(
    checks,
    'doctor.status',
    document.status === 'pass' ? 'pass' : 'fail',
    'recipe_doctor must report top-level status: pass.',
  );

  const doctorChecks = document.checks;
  if (doctorChecks !== undefined && !Array.isArray(doctorChecks)) {
    addHookValidationCheck(
      checks,
      'doctor.checks_shape',
      'fail',
      'recipe_doctor checks must be an array when present.',
    );
  } else {
    const malformedChecks = (doctorChecks ?? []).filter(
      (check) => !isRecord(check) || typeof check.status !== 'string',
    );
    const failedChecks = (doctorChecks ?? []).filter(
      (check) => isRecord(check) && typeof check.status === 'string' && check.status !== 'pass',
    );
    addHookValidationCheck(
      checks,
      'doctor.checks_entries',
      malformedChecks.length === 0 ? 'pass' : 'fail',
      'recipe_doctor checks[] entries must be objects with a string status.',
    );
    addHookValidationCheck(
      checks,
      'doctor.checks_pass',
      malformedChecks.length === 0 && failedChecks.length === 0 ? 'pass' : 'fail',
      'recipe_doctor checks[] must not contain failed readiness checks.',
    );
  }

  return {
    status: checks.some((check) => check.status === 'fail') ? 'fail' : 'pass',
    checks,
  };
}

interface RecipeRunArtifactPackageOutputInput {
  artifactPaths: string[];
  artifactListError?: string;
  summary?: unknown;
  manifest?: unknown;
  recipe?: unknown;
  recipeArtifactPresent?: boolean;
  resolvedRecipe?: unknown;
  readErrors?: Record<string, string>;
}

const RECIPE_ARTIFACT_MISSING_SENTINEL = '__FARMSLOT_MISSING__';
const RECIPE_ARTIFACT_MISSING_ERROR = 'file missing';
const RECIPE_ARTIFACT_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function readTerminalStatus(document: unknown): string | undefined {
  return isRecord(document) && typeof document.status === 'string' ? document.status : undefined;
}

function isSuppressedRecipeProtocolFinding(
  finding: RecipeValidationResult['findings'][number],
  artifactReadErrorPaths: ReadonlySet<string>,
  missingArtifactPaths: ReadonlySet<string>,
): boolean {
  return (
    (finding.code === 'artifact_package.missing_required_file' &&
      missingArtifactPaths.has(finding.path)) ||
    (finding.code === 'artifact_package.missing_manifest' &&
      artifactReadErrorPaths.has('artifact-manifest.json'))
  );
}

function formatRecipeValidationFindings(
  result: RecipeValidationResult,
  suppressFinding?: (finding: RecipeValidationResult['findings'][number]) => boolean,
): string {
  const errorFindings = result.findings.filter(
    (finding) => finding.severity === 'error' && !suppressFinding?.(finding),
  );
  const findings = errorFindings.slice(0, 5);
  if (findings.length === 0) return '';
  const suffix = errorFindings.length > findings.length ? '; …' : '';
  return ` Findings: ${findings.map((finding) => `${finding.code}@${finding.path}`).join('; ')}${suffix}`;
}

export function validateRecipeRunArtifactPackageOutput(
  input: RecipeRunArtifactPackageOutputInput,
): RecipeProjectHookValidationResult {
  const checks: RecipeProjectHookValidationCheck[] = [];
  const artifactPathSet = new Set(input.artifactPaths);
  const readErrors = input.readErrors ?? {};
  const artifactReadErrorPaths = new Set(Object.keys(readErrors));
  const missingArtifactPaths = new Set(
    Object.entries(readErrors)
      .filter(([, error]) => error === RECIPE_ARTIFACT_MISSING_ERROR)
      .map(([filePath]) => filePath),
  );

  if (input.artifactListError) {
    addHookValidationCheck(
      checks,
      'recipe_run.artifact_list',
      'fail',
      `Could not list recipe artifact package files: ${input.artifactListError}`,
    );
  }

  for (const requiredPath of ['summary.json', 'trace.json', 'artifact-manifest.json'] as const) {
    const error = readErrors[requiredPath];
    const passed =
      !error && (artifactPathSet.has(requiredPath) || input.artifactListError !== undefined);
    addHookValidationCheck(
      checks,
      `recipe_run.artifact.${requiredPath}`,
      passed ? 'pass' : 'fail',
      error
        ? error === RECIPE_ARTIFACT_MISSING_ERROR
          ? `${requiredPath} is missing.`
          : `${requiredPath} could not be read as JSON: ${error}`
        : artifactPathSet.has(requiredPath)
          ? `${requiredPath} exists.`
          : `Recipe run artifact package must include ${requiredPath}.`,
    );
  }

  const recipeReadError = readErrors['recipe.json'];
  if (recipeReadError) {
    addHookValidationCheck(
      checks,
      'recipe_run.artifact.recipe.json',
      'fail',
      recipeReadError === RECIPE_ARTIFACT_MISSING_ERROR
        ? 'recipe.json is missing.'
        : `recipe.json could not be read as JSON: ${recipeReadError}`,
    );
  }

  // resolved-recipe.json is optional; a present-but-unreadable one must fail rather
  // than silently skip the full-composition validation below.
  const resolvedRecipeReadError = readErrors['resolved-recipe.json'];
  if (resolvedRecipeReadError && resolvedRecipeReadError !== RECIPE_ARTIFACT_MISSING_ERROR) {
    addHookValidationCheck(
      checks,
      'recipe_run.artifact.resolved-recipe.json',
      'fail',
      `resolved-recipe.json could not be read as JSON: ${resolvedRecipeReadError}`,
    );
  }

  const summaryStatus = readTerminalStatus(input.summary);
  const manifestStatus = isRecord(input.manifest) ? input.manifest.runStatus : undefined;
  addHookValidationCheck(
    checks,
    'recipe_run.manifest.status_matches_summary',
    typeof summaryStatus === 'string' && manifestStatus === summaryStatus ? 'pass' : 'fail',
    `artifact-manifest.json runStatus must match summary.json status (summary=${summaryStatus ?? 'missing'}, manifest=${typeof manifestStatus === 'string' ? manifestStatus : 'missing'}).`,
  );

  // For a passing run the composition must be proven — recipe.json is validated in
  // full unless resolved-recipe.json proves it; a failed run stays envelope-only so a
  // graceful failure (e.g. a flow cycle) is not turned into an ingestion rejection.
  const recipe = validateRecipeArtifactPackage({
    recipe: input.recipeArtifactPresent ? input.recipe : undefined,
    ...(input.resolvedRecipe != null ? { resolvedRecipe: input.resolvedRecipe } : {}),
    runPassed: summaryStatus === 'pass',
    manifest: input.manifest,
    artifactPaths: input.artifactListError ? undefined : input.artifactPaths,
  });
  const hasUnsuppressedRecipeErrors = recipe.findings.some(
    (finding) =>
      finding.severity === 'error' &&
      !isSuppressedRecipeProtocolFinding(finding, artifactReadErrorPaths, missingArtifactPaths),
  );
  addHookValidationCheck(
    checks,
    'recipe_run.artifact_manifest.validation',
    recipe.status === 'valid' || !hasUnsuppressedRecipeErrors ? 'pass' : 'fail',
    `artifact-manifest.json must satisfy Recipe Protocol v1 and reference existing artifacts.${formatRecipeValidationFindings(
      recipe,
      (finding) =>
        isSuppressedRecipeProtocolFinding(finding, artifactReadErrorPaths, missingArtifactPaths),
    )}`,
  );

  return {
    status: checks.some((check) => check.status === 'fail') ? 'fail' : 'pass',
    checks,
    recipe,
  };
}

function mergeHookValidationResults(
  left: RecipeProjectHookValidationResult,
  right: RecipeProjectHookValidationResult,
): RecipeProjectHookValidationResult {
  return {
    status: left.status === 'pass' && right.status === 'pass' ? 'pass' : 'fail',
    checks: [...left.checks, ...right.checks],
    recipe: right.recipe ?? left.recipe,
  };
}

function formatFailedHookValidation(validation: RecipeProjectHookValidationResult): string {
  return validation.checks
    .filter((check) => check.status === 'fail')
    .map((check) => `${check.id}: ${check.message}`)
    .join('; ');
}

function joinRemoteArtifactPath(root: string, relativePath: string): string {
  return normalizeRemotePath(`${normalizeRemotePath(root).replace(/\/+$/u, '')}/${relativePath}`);
}

async function listSlotRecipeArtifactFiles(
  slotVars: SlotVars,
  artifactRoot: string,
): Promise<{ paths: string[]; error?: string }> {
  const script = `root=${shellExpressionForRemotePath(artifactRoot)}; if [ ! -d "$root" ]; then exit 0; fi; cd "$root" && find . -type f -print0`;
  let result: Awaited<ReturnType<typeof execOnSlot>>;
  try {
    result = await execOnSlot(slotVars, script, {
      timeout: 10_000,
      maxBuffer: RECIPE_ARTIFACT_LIST_MAX_BUFFER_BYTES,
    });
  } catch (error) {
    return { paths: [], error: error instanceof Error ? error.message : String(error) };
  }
  if (result.exitCode !== 0) {
    return {
      paths: [],
      error: result.stderr.trim() || `artifact listing exited ${result.exitCode}`,
    };
  }
  return {
    paths: result.stdout
      .split('\0')
      .map((line) => line.replace(/^\.\//u, ''))
      .filter(Boolean)
      .sort(),
  };
}

const DEFAULT_RECIPE_JSON_MAX_BUFFER_BYTES = 1024 * 1024;

async function readSlotJsonIfPresent(
  slotVars: SlotVars,
  filePath: string,
  maxBuffer = DEFAULT_RECIPE_JSON_MAX_BUFFER_BYTES,
): Promise<{ value?: unknown; error?: string }> {
  const script = `file=${shellExpressionForRemotePath(filePath)}; if [ ! -f "$file" ]; then echo ${RECIPE_ARTIFACT_MISSING_SENTINEL}; exit 0; fi; cat "$file"`;
  let text: string;
  try {
    const result = await execOnSlot(slotVars, script, { timeout: 10_000, maxBuffer });
    if (result.exitCode !== 0) {
      return { error: (result.stderr || result.stdout || `exit ${result.exitCode}`).trim() };
    }
    text = result.stdout;
  } catch (error) {
    // A too-large or unreadable artifact is validation evidence, not a gateway crash.
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (text.trim() === RECIPE_ARTIFACT_MISSING_SENTINEL) {
    return { error: RECIPE_ARTIFACT_MISSING_ERROR };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function validateRecipeRunArtifactsOnSlot(
  slotVars: SlotVars,
  artifactRoot: string,
): Promise<RecipeProjectHookValidationResult> {
  const artifactList = await listSlotRecipeArtifactFiles(slotVars, artifactRoot);
  const recipeArtifactPresent = artifactList.paths.includes('recipe.json');
  const resolvedRecipePresent = artifactList.paths.includes('resolved-recipe.json');
  const emptyRead = Promise.resolve({ value: undefined } as { value?: unknown; error?: string });
  const [summary, manifest, recipe, resolvedRecipe] = await Promise.all([
    readSlotJsonIfPresent(slotVars, joinRemoteArtifactPath(artifactRoot, 'summary.json')),
    readSlotJsonIfPresent(slotVars, joinRemoteArtifactPath(artifactRoot, 'artifact-manifest.json')),
    recipeArtifactPresent
      ? readSlotJsonIfPresent(slotVars, joinRemoteArtifactPath(artifactRoot, 'recipe.json'))
      : emptyRead,
    resolvedRecipePresent
      ? readSlotJsonIfPresent(
          slotVars,
          joinRemoteArtifactPath(artifactRoot, 'resolved-recipe.json'),
        )
      : emptyRead,
  ]);
  return validateRecipeRunArtifactPackageOutput({
    artifactPaths: artifactList.paths,
    artifactListError: artifactList.error,
    summary: summary.value,
    manifest: manifest.value,
    recipe: recipe.value,
    recipeArtifactPresent,
    resolvedRecipe: resolvedRecipe.value,
    readErrors: {
      ...(summary.error ? { 'summary.json': summary.error } : {}),
      ...(manifest.error ? { 'artifact-manifest.json': manifest.error } : {}),
      ...(recipe.error ? { 'recipe.json': recipe.error } : {}),
      ...(resolvedRecipe.error ? { 'resolved-recipe.json': resolvedRecipe.error } : {}),
    },
  });
}

export function validateRecipeProjectHookOutput(
  hook: RecipeProjectHookName,
  stdout: string,
): RecipeProjectHookValidationResult {
  if (hook === 'recipe_run') {
    return {
      status: 'pass',
      checks: [
        {
          id: 'recipe_run.process_exit',
          status: 'pass',
          message: 'hooks.recipe_run process exited successfully.',
        },
      ],
    };
  }

  const document = parseProjectHookJson(hook, stdout);
  if (hook === 'recipe_doctor') return validateRecipeDoctorJson(document);

  const recipe = validateRecipeActionManifestDocument(document);
  const checks: RecipeProjectHookValidationCheck[] = [
    {
      id: 'action_manifest.validation',
      status: recipe.status === 'valid' ? 'pass' : 'fail',
      message: 'recipe_action_manifest must print a valid Recipe v1 action manifest.',
    },
  ];
  return {
    status: checks.some((check) => check.status === 'fail') ? 'fail' : 'pass',
    checks,
    recipe,
  };
}

export function expandRecipeProjectHookTemplate(
  hook: RecipeProjectHookName,
  projectVars: ProjectVars,
  slotVars: SlotVars,
  params: { recipePath?: string; artifactsDir?: string } = {},
): RecipeProjectHookCommandResult {
  const template = projectVars.projectJson.hooks?.[hook];
  if (!template || typeof template !== 'string') {
    throw new Error(`No ${hook} hook configured in project.json for ${projectVars.projectName}.`);
  }
  if (hook === 'recipe_run') {
    if (!params.recipePath) {
      throw new Error('hooks.recipe_run execution requires recipePath.');
    }
    if (!params.artifactsDir) {
      throw new Error('hooks.recipe_run execution requires artifactsDir.');
    }
    return {
      hook,
      command: expandRecipeRunHookTemplate(
        template,
        slotVars,
        projectVars,
        shellExpressionForRemotePath(params.recipePath),
        shellExpressionForRemotePath(params.artifactsDir),
      ),
    };
  }
  return { hook, command: expandTemplate(template, slotVars, projectVars) };
}

export function assertSlotProjectMatchesRequestedProject(
  slotVars: SlotVars,
  requestedProject: string,
): void {
  if (slotVars.projectName !== requestedProject) {
    throw new Error(
      `Slot ${slotVars.slotId} belongs to project ${slotVars.projectName}; refusing to run Recipe v1 hook for requested project ${requestedProject}.`,
    );
  }
}

export function validateRecipeRunHookTemplate(template: string): void {
  const missing = ['{{recipe_path}}', '{{artifacts_dir}}'].filter(
    (placeholder) => !template.includes(placeholder),
  );
  if (missing.length > 0) {
    throw new Error(
      `hooks.recipe_run must explicitly include ${missing.join(' and ')} so Recipe v1 runner input/output paths are visible in project config.`,
    );
  }
}

export function expandRecipeRunHookTemplate(
  template: string,
  slotVars: SlotVars,
  projectVars: ProjectVars,
  recipePath: string,
  artifactsDir: string,
): string {
  validateRecipeRunHookTemplate(template);
  return expandTemplate(template, slotVars, projectVars)
    .replaceAll('{{recipe_path}}', recipePath)
    .replaceAll('{{artifacts_dir}}', artifactsDir);
}

export function canRecipeRerunOnSlot(
  slotStatus: {
    slot?: string | null;
    currentRunId?: string | null;
    phase?: string | null;
    lifecycle?: string | null;
    agent?: string | null;
  },
  runId: string,
  runSlotId?: string | null,
): boolean {
  if (slotStatus.currentRunId && slotStatus.currentRunId !== runId) return false;
  if (slotStatus.currentRunId === runId) {
    // Operator load-run / warm switch binds currentRunId without always resetting
    // lifecycle to `ready`. Reject only when a live worker still owns the slot.
    if (slotStatus.agent === 'working') return false;
    return true;
  }
  // Some review-gate slots do not persist currentRunId after handoff; keep that
  // recovery path narrow so arbitrary held slots cannot be claimed by stale runs.
  return Boolean(slotStatus.phase === 'review-gate' && runSlotId && slotStatus.slot === runSlotId);
}

async function checkSlotWarmth(
  slotVars: SlotVars,
  expectedBranch: string | null,
): Promise<WarmthResult> {
  const warnings: WarmthCheck[] = [];
  const session = await resolveTmuxSession(slotVars.slotId, slotVars);

  // Run all checks in parallel — they're independent
  await Promise.allSettled([
    execOnSlot(
      slotVars,
      `tmux has-session -t ${shellQuote(session)} 2>/dev/null && echo ok || echo no`,
    )
      .then((r) => {
        if (r.stdout.trim() !== 'ok')
          warnings.push({
            check: 'tmux',
            severity: 'hard',
            message: `tmux session '${session}' not found`,
          });
      })
      .catch(() => {
        warnings.push({ check: 'tmux', severity: 'hard', message: 'tmux session check failed' });
      }),
    ...(slotVars.resourceVars.port && /^\d+$/.test(slotVars.resourceVars.port)
      ? [
          execOnSlot(
            slotVars,
            `bash -c 'echo > /dev/tcp/localhost/${slotVars.resourceVars.port}' 2>/dev/null && echo ok || echo no`,
            { timeout: 5000 },
          )
            .then((r) => {
              if (r.stdout.trim() !== 'ok')
                warnings.push({
                  check: 'devserver',
                  severity: 'soft',
                  message: `devserver port ${slotVars.resourceVars.port} not listening`,
                });
            })
            .catch(() => {
              warnings.push({
                check: 'devserver',
                severity: 'soft',
                message: `devserver port ${slotVars.resourceVars.port} check failed`,
              });
            }),
        ]
      : []),
    ...(expectedBranch
      ? [
          execOnSlot(
            slotVars,
            `git -C ${shellQuote(slotVars.remoteRepo)} rev-parse --abbrev-ref HEAD 2>/dev/null`,
          )
            .then((r) => {
              if (r.stdout.trim() !== expectedBranch)
                warnings.push({
                  check: 'branch',
                  severity: 'hard',
                  message: `branch mismatch: expected '${expectedBranch}', got '${r.stdout.trim()}'`,
                });
            })
            .catch(() => {
              warnings.push({ check: 'branch', severity: 'hard', message: 'branch check failed' });
            }),
        ]
      : []),
  ]);

  return { warm: warnings.length === 0, warnings };
}

export const RECIPE_REPLAY_HEALTH_RETRY_DELAYS_MS = [0, 3_000, 5_000] as const;

export function recipeReplayHealthReady(
  healthValue: string,
  readyIndicator: string | undefined,
): boolean {
  if (!readyIndicator) return Boolean(healthValue);
  return healthValue === readyIndicator;
}

async function readRecipeReplayHealth(
  slotVars: SlotVars,
  healthHook: string,
  parseCmd: string,
  delayMs: number,
): Promise<string> {
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return runHealthCheck(slotVars, healthHook, parseCmd, {
    logPrefix: 'recipe',
    timeoutMs: 30_000,
  });
}

async function waitForRecipeReplayHealth(
  slotVars: SlotVars,
  healthHook: string,
  parseCmd: string,
  readyIndicator: string | undefined,
): Promise<string> {
  let lastValue = '';
  for (const delayMs of RECIPE_REPLAY_HEALTH_RETRY_DELAYS_MS) {
    lastValue = await readRecipeReplayHealth(slotVars, healthHook, parseCmd, delayMs);
    if (recipeReplayHealthReady(lastValue, readyIndicator)) return lastValue;
  }
  return lastValue;
}

/** Mirror prepare health gating so recipe replay fails fast when CDP/app is cold. */
export async function assertSlotHealthForRecipeRerun(
  slotVars: SlotVars,
  projectJson: RawProjectJson,
  projectVars: ProjectVars,
): Promise<void> {
  const healthHook = expandHook('health_check', projectJson, slotVars, projectVars);
  if (!healthHook?.trim()) return;

  const readyIndicator = getProjectField(projectJson, 'health.ready_indicator');
  const parseCmd = getProjectField(projectJson, 'health.parse_health') ?? '';
  let healthValue = await waitForRecipeReplayHealth(slotVars, healthHook, parseCmd, readyIndicator);

  if (recipeReplayHealthReady(healthValue, readyIndicator)) return;

  const unlockHook = expandHook('unlock', projectJson, slotVars, projectVars);
  if (unlockHook?.trim()) {
    await execOnSlot(slotVars, `cd ${shellQuote(slotVars.remoteRepo)} && ${unlockHook} 2>&1`, {
      timeout: 60_000,
    });
    healthValue = await waitForRecipeReplayHealth(slotVars, healthHook, parseCmd, readyIndicator);
  }

  if (!recipeReplayHealthReady(healthValue, readyIndicator)) {
    throw new Error(
      `Slot ${slotVars.slotId} is not ready for recipe replay (health=${healthValue || 'none'}, expected ${readyIndicator}). ` +
        'Run ensure-js-runtime prepare (or slot check) so Metro, the app, and CDP reach WalletView.',
    );
  }
}

/**
 * Resolve a recipe artifact path on the SLOT filesystem (not orchestrator).
 * Defaults to artifacts/recipe.json but can also target bundled task-local subflows.
 */
function resolveWorkerTaskDir(
  run: { taskFile: string | null; project: string },
  slotVars: SlotVars,
  projectJson: RawProjectJson,
): string | null {
  if (!run.taskFile) return null;
  const orchRoot = getOrchestratorTaskRoot(run.project, projectJson);
  const relPath = resolveTaskRelDir(run.taskFile, orchRoot);
  if (relPath === null) return null;
  const taskDirName = resolveProjectTaskDirName(projectJson);
  return path.join(slotVars.remoteRepo, taskDirName, relPath);
}

export function resolveRecipeArtifactRootForSlot(
  runTaskFile: string | null,
  workerTaskDir: string,
  selectedArtifactRoot?: string | null,
): string {
  if (!selectedArtifactRoot || !runTaskFile) return workerTaskDir;
  const localTaskArtifactsRoot = path.join(path.dirname(runTaskFile), 'artifacts');
  const relativeArtifactRoot = path.relative(localTaskArtifactsRoot, selectedArtifactRoot);
  if (
    relativeArtifactRoot === '' ||
    (!relativeArtifactRoot.startsWith('..') && !path.isAbsolute(relativeArtifactRoot))
  ) {
    return path.join(workerTaskDir, 'artifacts', relativeArtifactRoot);
  }
  return selectedArtifactRoot;
}

export function resolveSlotRecipePath(
  recipeArtifactRoot: string,
  recipeArtifactPath?: string,
): string | null {
  const normalizedArtifactRoot = isShellHomePath(recipeArtifactRoot)
    ? normalizeRemotePath(recipeArtifactRoot)
    : path.resolve(recipeArtifactRoot);
  const artifactRootLooksLikeArtifactsDir =
    normalizedArtifactRoot.endsWith(`${path.sep}artifacts`) ||
    normalizedArtifactRoot.includes(`${path.sep}artifacts${path.sep}recipe-runs${path.sep}`);
  const rawRelativeArtifactPath =
    recipeArtifactPath ??
    (artifactRootLooksLikeArtifactsDir ? 'recipe.json' : 'artifacts/recipe.json');
  const relativeArtifactPath =
    artifactRootLooksLikeArtifactsDir && rawRelativeArtifactPath.startsWith('artifacts/')
      ? rawRelativeArtifactPath.slice('artifacts/'.length)
      : rawRelativeArtifactPath;
  if (path.isAbsolute(relativeArtifactPath) || relativeArtifactPath.split(/[\\/]+/).includes('..'))
    return null;
  return isShellHomePath(recipeArtifactRoot)
    ? resolvePathWithinRemoteBase(normalizedArtifactRoot, relativeArtifactPath)
    : (() => {
        const targetPath = path.resolve(normalizedArtifactRoot, relativeArtifactPath);
        const relativeTargetPath = path.relative(normalizedArtifactRoot, targetPath);
        if (relativeTargetPath.startsWith('..') || path.isAbsolute(relativeTargetPath)) return null;
        return targetPath;
      })();
}

export interface SlotRecipePathCandidate {
  recipePath: string;
  artifactRoot: string;
  source: 'selected-run' | 'current-package';
}

export function resolveSlotRecipePathCandidates(
  runTaskFile: string | null,
  workerTaskDir: string,
  selectedArtifactRoot: string | null | undefined,
  recipeArtifactPath?: string,
): SlotRecipePathCandidate[] {
  const candidates: SlotRecipePathCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (artifactRoot: string, source: SlotRecipePathCandidate['source']) => {
    const recipePath = resolveSlotRecipePath(artifactRoot, recipeArtifactPath);
    if (!recipePath || seen.has(recipePath)) return;
    seen.add(recipePath);
    candidates.push({ recipePath, artifactRoot, source });
  };

  if (selectedArtifactRoot) {
    addCandidate(
      resolveRecipeArtifactRootForSlot(runTaskFile, workerTaskDir, selectedArtifactRoot),
      'selected-run',
    );
  }
  addCandidate(workerTaskDir, 'current-package');
  return candidates;
}

export async function selectExistingRecipePathCandidate(
  candidates: SlotRecipePathCandidate[],
  fileExists: (recipePath: string) => Promise<boolean>,
): Promise<SlotRecipePathCandidate | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  for (const candidate of candidates) {
    if (await fileExists(candidate.recipePath)) return candidate;
  }
  return candidates[0]!;
}

function assertValidArtifactRunId(artifactRunId: string): void {
  if (!ARTIFACT_RUN_ID_RE.test(artifactRunId)) {
    throw new Error(`Invalid artifact run id: ${artifactRunId}`);
  }
}

function normalizePlaybackSlowMs(playbackSlowMs: number | undefined): number | undefined {
  if (playbackSlowMs === undefined) return undefined;
  if (
    !Number.isInteger(playbackSlowMs) ||
    playbackSlowMs < MIN_PLAYBACK_SLOW_MS ||
    playbackSlowMs > MAX_PLAYBACK_SLOW_MS
  ) {
    throw new Error(
      `Invalid playback slow-down: expected ${MIN_PLAYBACK_SLOW_MS}-${MAX_PLAYBACK_SLOW_MS}ms`,
    );
  }
  return playbackSlowMs;
}

export function appendRecipePlaybackOptions(
  command: string,
  args: { playbackSlowMs?: number; recordVideo?: boolean },
): string {
  const playbackSlowMs = normalizePlaybackSlowMs(args.playbackSlowMs);
  const options: string[] = [];
  if (playbackSlowMs !== undefined) options.push(`--slow ${playbackSlowMs}`);
  if (args.recordVideo) options.push('--record-video=full-run');
  return options.length > 0 ? `${command} ${options.join(' ')}` : command;
}

export function recipeRunOptionsForProject(
  projectJson: RawProjectJson,
  args: { playbackSlowMs?: number; recordVideo?: boolean },
): { playbackSlowMs?: number; recordVideo?: boolean } {
  const options: { playbackSlowMs?: number; recordVideo?: boolean } = {};
  if (
    args.playbackSlowMs !== undefined &&
    getProjectFieldRaw(projectJson, 'recipe_run_supports_playback_slow') === true
  ) {
    options.playbackSlowMs = args.playbackSlowMs;
  }
  if (
    args.recordVideo &&
    getProjectFieldRaw(projectJson, 'recipe_run_supports_video_recording') === true
  ) {
    options.recordVideo = true;
  }
  return options;
}

export function recipeRunUnsupportedOptionWarnings(
  projectJson: RawProjectJson,
  args: { playbackSlowMs?: number; recordVideo?: boolean },
): string[] {
  const warnings: string[] = [];
  if (
    args.playbackSlowMs !== undefined &&
    getProjectFieldRaw(projectJson, 'recipe_run_supports_playback_slow') !== true
  ) {
    warnings.push(
      'Slow playback requested, but this project has not set recipe_run_supports_playback_slow=true; running at normal speed.',
    );
  }
  if (
    args.recordVideo &&
    getProjectFieldRaw(projectJson, 'recipe_run_supports_video_recording') !== true
  ) {
    warnings.push(
      'Video recording requested, but this project has not set recipe_run_supports_video_recording=true; replay will not include a video artifact.',
    );
  }
  return warnings;
}

async function recipeRunHasVideoArtifact(
  slotVars: SlotVars,
  artifactRoot: string,
): Promise<boolean> {
  const script = `root=${shellExpressionForRemotePath(artifactRoot)}; test -d "$root" || exit 0; find "$root" -type f \( -iname '*.mp4' -o -iname '*.mov' -o -iname '*.webm' \) -print -quit`;
  const result = await execOnSlot(slotVars, script, { timeout: 10_000, maxBuffer: 64 * 1024 });
  return result.stdout.trim().length > 0;
}

async function resolveSelectedRecipeArtifactRoot(
  run: { taskFile: string | null; project: string } & { id: string },
  recipeRunId: string | undefined,
): Promise<string | null> {
  if (!recipeRunId) return null;
  const groups = await listRecipeRunArtifactGroupsForRun(
    await attachLiveRecipeContext(getRun(run.id)!),
  );
  return groups.find((group) => group.id === recipeRunId)?.artifactRoot ?? null;
}

async function slotFileExists(slotVars: SlotVars, filePath: string): Promise<boolean> {
  const result = await execOnSlot(
    slotVars,
    `test -f ${shellExpressionForRemotePath(filePath)} && echo ok || echo missing`,
  );
  return result.stdout.trim() === 'ok';
}

async function buildRecipeExecutionCommand(
  run: { taskFile: string | null; project: string; branch: string | null; id: string },
  slotVars: SlotVars,
  projectVars: ProjectVars,
  recipeArtifactPath: string | undefined,
  recipeRunId: string | undefined,
  artifactRunId: string,
  playbackSlowMs: number | undefined,
  recordVideo: boolean | undefined,
): Promise<{ recipePath: string; artifactRoot: string; command: string }> {
  assertValidArtifactRunId(artifactRunId);
  const workerTaskDir = resolveWorkerTaskDir(run, slotVars, projectVars.projectJson);
  if (!workerTaskDir) {
    throw new Error('Cannot resolve worker task dir from orchestrator task file');
  }
  const selectedRecipeArtifactRoot = await resolveSelectedRecipeArtifactRoot(run, recipeRunId);
  if (recipeRunId && !selectedRecipeArtifactRoot) {
    throw new Error(`Cannot resolve recipe run artifact root for ${recipeRunId}`);
  }
  const recipePathCandidate = await selectExistingRecipePathCandidate(
    resolveSlotRecipePathCandidates(
      run.taskFile,
      workerTaskDir,
      selectedRecipeArtifactRoot,
      recipeArtifactPath,
    ),
    (recipePath) => slotFileExists(slotVars, recipePath),
  );
  if (!recipePathCandidate) {
    throw new Error('Cannot resolve recipe path from task file or requested recipe artifact path');
  }
  const slotRecipePath = recipePathCandidate.recipePath;
  const slotArtifactsDir = path.join(workerTaskDir, 'artifacts');
  const slotRecipeRunArtifactsDir = path.join(slotArtifactsDir, 'recipe-runs', artifactRunId);
  const recipeHook = projectVars.projectJson.hooks?.recipe_run;
  if (!recipeHook || typeof recipeHook !== 'string') {
    throw new Error(
      `No recipe_run hook configured in project.json for ${run.project}. Add hooks.recipe_run to enable recipe re-execution.`,
    );
  }
  let recipeCmd = expandRecipeRunHookTemplate(
    recipeHook,
    slotVars,
    projectVars,
    shellExpressionForRemotePath(slotRecipePath),
    shellExpressionForRemotePath(slotRecipeRunArtifactsDir),
  );
  recipeCmd = appendRecipePlaybackOptions(
    recipeCmd,
    recipeRunOptionsForProject(projectVars.projectJson, { playbackSlowMs, recordVideo }),
  );
  return {
    recipePath: slotRecipePath,
    artifactRoot: slotRecipeRunArtifactsDir,
    command: recipeCmd,
  };
}

export async function recipeCommand(params: RecipeCommandParams): Promise<RecipeCommandResult> {
  const { runId, slotId, recipeArtifactPath, recipeRunId, playbackSlowMs, recordVideo } = params;
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const slotVars = await loadSlotVars(slotId);
  const projectVars = await loadProjectVars(run.project);
  const built = await buildRecipeExecutionCommand(
    run,
    slotVars,
    projectVars,
    recipeArtifactPath,
    recipeRunId,
    `manual-${randomUUID().slice(0, 8)}`,
    playbackSlowMs,
    recordVideo,
  );
  return { command: built.command, artifactRoot: built.artifactRoot, recipePath: built.recipePath };
}

export async function recipeProjectHookCommand(
  params: RecipeProjectHookCommandParams,
): Promise<RecipeProjectHookCommandResult> {
  return (await buildRecipeProjectHookCommand(params)).built;
}

async function buildRecipeProjectHookCommand(
  params: RecipeProjectHookCommandParams,
): Promise<{ built: RecipeProjectHookCommandResult; slotVars: SlotVars }> {
  assertRecipeProjectHookName(params.hook);
  const slotVars = await loadSlotVars(params.slotId);
  assertSlotProjectMatchesRequestedProject(slotVars, params.project);
  const projectVars = await loadProjectVars(params.project);
  return {
    built: expandRecipeProjectHookTemplate(params.hook, projectVars, slotVars, {
      recipePath: params.recipePath,
      artifactsDir: params.artifactsDir,
    }),
    slotVars,
  };
}

export async function recipeProjectHookRun(
  params: RecipeProjectHookRunParams,
): Promise<RecipeProjectHookRunResult> {
  const { built, slotVars } = await buildRecipeProjectHookCommand(params);
  const result = await execOnSlot(slotVars, built.command, {
    timeout: params.timeoutMs ?? 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `hooks.${params.hook} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
    );
  }
  let validation = validateRecipeProjectHookOutput(params.hook, result.stdout);
  if (params.hook === 'recipe_run') {
    const artifactsDir = params.artifactsDir;
    // buildRecipeProjectHookCommand enforces this before execution; keep a local guard for TS and tests.
    if (!artifactsDir) throw new Error('hooks.recipe_run execution requires artifactsDir.');
    validation = mergeHookValidationResults(
      validation,
      await validateRecipeRunArtifactsOnSlot(slotVars, artifactsDir),
    );
  }
  if (validation.status !== 'pass') {
    throw new Error(
      `hooks.${params.hook} produced invalid Recipe v1 output: ${formatFailedHookValidation(validation)}`,
    );
  }
  return {
    ...built,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    validation,
  };
}

function emitRecipeRerunStream(
  emit: EmitFn,
  requestId: string,
  data: string,
  stream: 'stdout' | 'stderr' = 'stderr',
): void {
  emit(Events.SCRIPT_OUTPUT, { requestId, stream, data, timestamp: Date.now() });
}

async function executeRecipeRerunJob(args: {
  emit: EmitFn;
  run: NonNullable<ReturnType<typeof getRun>>;
  runId: string;
  slotId: string;
  requestId: string;
  abortController: AbortController;
  recipeArtifactPath?: string;
  recipeRunId?: string;
  playbackSlowMs?: number;
  recordVideo?: boolean;
}): Promise<void> {
  const {
    emit,
    run,
    runId,
    slotId,
    requestId,
    abortController,
    recipeArtifactPath,
    recipeRunId,
    playbackSlowMs,
    recordVideo,
  } = args;
  const startTime = Date.now();
  let slotRecipeRunArtifactsDir = '';

  const complete = (detail: { exitCode: number; error?: string; artifactRoot?: string }): void => {
    emit(Events.SCRIPT_COMPLETE, {
      requestId,
      exitCode: detail.exitCode,
      duration: Date.now() - startTime,
      error: detail.error,
      artifactRoot: detail.artifactRoot ?? slotRecipeRunArtifactsDir,
    });
  };

  try {
    emitRecipeRerunStream(emit, requestId, 'Preflight: resolving recipe command...\n');
    const slotVars = await loadSlotVars(slotId);
    const projectVars = await loadProjectVars(run.project);
    const projectJson = projectVars.projectJson;

    const built = await buildRecipeExecutionCommand(
      run,
      slotVars,
      projectVars,
      recipeArtifactPath,
      recipeRunId,
      requestId,
      playbackSlowMs,
      recordVideo,
    );
    const slotRecipePath = built.recipePath;
    if (!slotRecipePath) {
      throw new Error(
        'Cannot resolve recipe path from task file or requested recipe artifact path',
      );
    }

    emitRecipeRerunStream(emit, requestId, 'Preflight: verifying recipe.json on slot...\n');
    const fileCheck = await execOnSlot(
      slotVars,
      `test -f ${shellExpressionForRemotePath(slotRecipePath)} && echo ok || echo missing`,
    );
    if (fileCheck.stdout.trim() !== 'ok') {
      throw new Error(`recipe.json not found on slot at ${slotRecipePath}`);
    }

    slotRecipeRunArtifactsDir = built.artifactRoot;

    emitRecipeRerunStream(emit, requestId, 'Preflight: checking slot warmth...\n');
    const warmth = await checkSlotWarmth(slotVars, run.branch);
    const hardFailures = warmth.warnings.filter((w) => w.severity === 'hard');
    if (hardFailures.length > 0) {
      throw new Error(
        `Slot ${slotId} is not warm: ${hardFailures.map((w) => w.message).join('; ')}`,
      );
    }
    if (warmth.warnings.length > 0) {
      console.warn(
        `[recipe] warmth warnings for ${slotId}: ${warmth.warnings.map((w) => w.message).join('; ')}`,
      );
      for (const w of warmth.warnings) {
        emitRecipeRerunStream(emit, requestId, `⚠ warmth [${w.check}]: ${w.message}\n`);
      }
    }

    emitRecipeRerunStream(
      emit,
      requestId,
      'Preflight: checking app health (Metro, CDP, WalletView)...\n',
    );
    await assertSlotHealthForRecipeRerun(slotVars, projectJson, projectVars);
    emitRecipeRerunStream(emit, requestId, 'Preflight: health check passed.\n');

    for (const warning of recipeRunUnsupportedOptionWarnings(projectJson, {
      playbackSlowMs,
      recordVideo,
    })) {
      emitRecipeRerunStream(emit, requestId, `⚠ recipe option: ${warning}\n`);
    }

    const rawTimeout = getProjectField(projectJson, 'recipe_timeout');
    const timeoutMs = typeof rawTimeout === 'number' ? rawTimeout : DEFAULT_TIMEOUT_MS;
    const recipeCmd = built.command;

    let liveContextPublished = false;
    const publishLiveRecipeContext = () => {
      if (liveContextPublished) return;
      liveContextPublished = true;
      const liveRecipeContext: LiveRecipeContext = {
        source: 'recipe-run-live',
        recipeRunId: requestId,
        artifactRoot: slotRecipeRunArtifactsDir,
        artifactManifest: null,
        recipeJson: null,
        recipeQualityArtifact: null,
        qualityReport: null,
        workerLearnings: null,
        isStale: false,
        selectionReason: 'latest-run',
      };
      const updatedRun = updateRun(runId, { liveRecipeContext });
      emit(Events.RUN_UPDATED, { run: updatedRun });
    };

    console.log(`[recipe] rerun ${requestId} on ${slotId}: ${recipeCmd.slice(0, 100)}`);
    emitRecipeRerunStream(emit, requestId, `Starting recipe runner...\n$ ${recipeCmd}\n`, 'stdout');

    publishLiveRecipeContext();
    const result = await execOnSlot(slotVars, recipeCmd, {
      timeout: timeoutMs,
      signal: abortController.signal,
      onOutput: (stream, data) => {
        publishLiveRecipeContext();
        emit(Events.SCRIPT_OUTPUT, { requestId, stream, data, timestamp: Date.now() });
      },
    });
    publishLiveRecipeContext();
    if (abortController.signal.aborted) {
      throw new Error('Recipe rerun cancelled by operator');
    }

    if (result.exitCode !== 0) {
      complete({ exitCode: result.exitCode, artifactRoot: slotRecipeRunArtifactsDir });
      console.warn(
        `[recipe] rerun ${requestId} exited with code ${result.exitCode} (${Date.now() - startTime}ms)`,
      );
      return;
    }

    const artifactValidation = await validateRecipeRunArtifactsOnSlot(
      slotVars,
      slotRecipeRunArtifactsDir,
    );
    if (artifactValidation.status !== 'pass') {
      const invalidArtifacts = formatFailedHookValidation(artifactValidation);
      throw new Error(
        result.exitCode === 0
          ? `Recipe runner produced invalid Recipe v1 artifacts: ${invalidArtifacts}`
          : `Recipe runner exited with code ${result.exitCode} and produced invalid Recipe v1 artifacts: ${invalidArtifacts}`,
      );
    }

    const gatedRecordVideo = recipeRunOptionsForProject(projectJson, {
      playbackSlowMs,
      recordVideo,
    }).recordVideo;
    if (
      gatedRecordVideo &&
      !(await recipeRunHasVideoArtifact(slotVars, slotRecipeRunArtifactsDir))
    ) {
      emitRecipeRerunStream(
        emit,
        requestId,
        '⚠ recipe option: Video recording was requested, but no .mp4/.mov/.webm artifact was produced. Check the project runner recorder/capture-helper integration.\n',
      );
    }

    complete({ exitCode: result.exitCode, artifactRoot: slotRecipeRunArtifactsDir });
    console.log(
      `[recipe] rerun ${requestId} complete: exit=${result.exitCode} (${Date.now() - startTime}ms)`,
    );
  } catch (err) {
    const message = (err as Error).message;
    emitRecipeRerunStream(emit, requestId, `Recipe rerun failed: ${message}\n`);
    complete({ exitCode: 1, error: message, artifactRoot: slotRecipeRunArtifactsDir });
    console.warn(`[recipe] rerun ${requestId} failed: ${message}`);
  } finally {
    activeReruns.delete(slotId);
  }
}

export async function recipeRerun(
  params: RecipeRerunParams,
  emit: EmitFn,
): Promise<ScriptActionResult> {
  const { runId, slotId, recipeArtifactPath, recipeRunId, playbackSlowMs, recordVideo } = params;

  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const fleet = await loadFleetStatus();
  const slotStatus = fleet.slots.find((s) => s.slot === slotId);
  if (!slotStatus) {
    throw new Error(`Slot ${slotId} not found`);
  }
  if (!canRecipeRerunOnSlot(slotStatus, runId, run.slotId)) {
    if (slotStatus.agent === 'working') {
      throw new Error(
        `Slot ${slotId} has a live worker — wait until it finishes before replaying the recipe`,
      );
    }
    throw new Error(
      `Slot ${slotId} is not ready for recipe replay on this run ` +
        `(phase=${slotStatus.phase ?? '-'}, current run=${slotStatus.currentRunId?.slice(0, 8) ?? '-'})`,
    );
  }

  if (activeReruns.has(slotId)) {
    throw new Error(
      `Recipe rerun already active on ${slotId} (requestId: ${activeReruns.get(slotId)!.requestId})`,
    );
  }

  const requestId = `recipe-${randomUUID().slice(0, 8)}`;
  const abortController = new AbortController();
  activeReruns.set(slotId, { requestId, abortController });

  void executeRecipeRerunJob({
    emit,
    run,
    runId,
    slotId,
    requestId,
    abortController,
    recipeArtifactPath,
    recipeRunId,
    playbackSlowMs,
    recordVideo,
  });

  return { requestId };
}

export async function recipeCancel(params: RecipeCancelParams): Promise<RecipeCancelResult> {
  const active = activeReruns.get(params.slotId);
  if (!active || active.requestId !== params.requestId) {
    return { cancelled: false };
  }

  // Check if slot is local — remote slots don't support signal-based cancellation
  const slotVars = await loadSlotVars(params.slotId);
  const local = isLocal(slotVars.host, slotVars.machine);
  if (!local) {
    console.warn(
      `[recipe] cancel not supported on remote slot ${params.slotId} — process will run until timeout`,
    );
    return {
      cancelled: false,
      reason: 'Cancel not supported on remote slots — recipe will run until timeout',
    };
  }

  active.abortController.abort();
  // Don't delete here — the finally block in recipeRerun owns cleanup
  console.log(`[recipe] cancelled rerun ${params.requestId} on ${params.slotId}`);
  return { cancelled: true };
}
