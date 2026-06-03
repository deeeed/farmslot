import { access, copyFile, cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FlowType, Run, RunCreateParams } from '@farmslot/protocol';

import {
  invalidateArtifactTextCache,
  invalidateLiveRecipeContextMemo,
} from '../live-recipe/context.js';
import { getAllRuns, listRuns } from '../runs/store.js';

export const FOLLOW_UP_SCOPE_VERDICTS = [
  'full-scope-addressed',
  'partial-symptom-only',
  'unable-to-determine',
] as const;

type FollowUpScopeVerdict = (typeof FOLLOW_UP_SCOPE_VERDICTS)[number];
type ResolutionTier =
  | 'task-local-inherited'
  | 'current-run-artifact'
  | 'parent-run-artifact'
  | 'family-root-artifact'
  | 'family-member-artifact';

type FamilyArtifactKey =
  | 'task-md'
  | 'report'
  | 'learnings'
  | 'recipe'
  | 'recipe-flows'
  | 'recipe-quality'
  | 'recipe-coverage'
  | 'evidence-package';

interface FamilyArtifactSpec {
  key: FamilyArtifactKey;
  label: string;
  /** Default 'file'. 'directory' walks the source dir and copies each immediate-child file —
   * needed for `recipe-flows/` where the bundle filenames vary per recipe. */
  kind?: 'file' | 'directory';
  sourceRelativePath: string;
  materializedRelativePath: string;
  seedCurrentRelativePath?: string;
}

interface FamilyArtifactCandidate {
  tier: ResolutionTier;
  sourcePath: string;
  sourceRunId?: string;
}

interface FamilyArtifactManifestEntry {
  artifact: FamilyArtifactKey;
  label: string;
  status: 'resolved' | 'missing';
  resolutionTier?: ResolutionTier;
  sourceRunId?: string;
  sourcePath?: string;
  materializedPath?: string;
  seededPath?: string;
  attempts: Array<{
    tier: ResolutionTier;
    sourceRunId?: string;
    sourcePath: string;
    exists: boolean;
  }>;
}

export interface FamilyContextManifest {
  version: 1;
  familyId: string;
  familyRootTicketOrPr: string;
  parentRunId: string | null;
  originalFamilyScopeSummary: string;
  currentTriggerSummary: string;
  requiredScopeVerdicts: FollowUpScopeVerdict[];
  provenancePolicy: 'resolve-materialize-reference';
  inheritedArtifacts: FamilyArtifactManifestEntry[];
  generatedAt: string;
}

const FAMILY_ARTIFACT_SPECS: readonly FamilyArtifactSpec[] = [
  {
    key: 'task-md',
    label: 'Original task file',
    sourceRelativePath: 'TASK.md',
    materializedRelativePath: 'inputs/inherited/TASK.md',
  },
  {
    key: 'report',
    label: 'Worker report',
    sourceRelativePath: 'artifacts/report.md',
    materializedRelativePath: 'inputs/inherited/report.md',
  },
  {
    key: 'learnings',
    label: 'Worker learnings',
    sourceRelativePath: 'artifacts/learnings.md',
    materializedRelativePath: 'inputs/inherited/learnings.md',
  },
  {
    key: 'recipe',
    label: 'Validation recipe',
    sourceRelativePath: 'artifacts/recipe.json',
    materializedRelativePath: 'inputs/inherited/recipe.json',
    seedCurrentRelativePath: 'artifacts/recipe.json',
  },
  {
    key: 'recipe-flows',
    label: 'Recipe subflow bundle',
    kind: 'directory',
    // The recipe runner resolves `bundle/<name>` against `<artifactsDir>/recipe-flows/<name>.json`
    // (see the project-configured recipe_dir catalog). Without inheriting this dir, every follow-up flow
    // (pr-complete, review-pr) on a multi-AC recipe fails at the first `call: bundle/<name>`
    // node despite the orchestrator recipe having been inherited successfully.
    sourceRelativePath: 'artifacts/recipe-flows',
    materializedRelativePath: 'inputs/inherited/recipe-flows',
    seedCurrentRelativePath: 'artifacts/recipe-flows',
  },
  {
    key: 'recipe-quality',
    label: 'Recipe quality artifact',
    sourceRelativePath: 'artifacts/recipe-quality.json',
    materializedRelativePath: 'inputs/inherited/recipe-quality.json',
  },
  {
    key: 'recipe-coverage',
    label: 'Recipe coverage',
    sourceRelativePath: 'artifacts/recipe-coverage.md',
    materializedRelativePath: 'inputs/inherited/recipe-coverage.md',
  },
] as const;

const RECIPE_PACKAGE_STATIC_FILES = [
  'recipe.json',
  'recipe-quality.json',
  'recipe-coverage.md',
  'report.md',
  'learnings.md',
  'evidence-manifest.json',
  'summary.json',
  'trace.json',
  'workflow.json',
  'workflow.mmd',
  'console-errors.json',
  'console-warnings.json',
  'runtime-exceptions.json',
] as const;

function runTaskDir(run: Pick<Run, 'taskFile'>): string | null {
  return run.taskFile ? path.dirname(run.taskFile) : null;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Existence semantics that match the artifact's kind. A file artifact "exists" when the
 * single path is reachable; a directory artifact "exists" only when the dir holds at least
 * one regular file. Treating an empty `recipe-flows/` dir as "exists" would resolve an
 * inheritance attempt against a parent that produced no subflows, masking the real
 * upstream failure.
 */
async function artifactSourceExists(
  sourcePath: string,
  kind: 'file' | 'directory',
): Promise<boolean> {
  if (!(await pathExists(sourcePath))) return false;
  if (kind === 'file') return true;
  try {
    const entries = await readdir(sourcePath);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Copy an artifact source to a destination, respecting kind. Directories use `fs.cp` with
 * `recursive: true` so nested subdirectories are preserved — recipe-flows is flat today but
 * the resolver allows `bundle/<sub>/<name>` paths and a flat-only walk would silently drop
 * any future nested structure. Overwrite semantics match copyFile's default — a stale
 * destination never shadows a refreshed source.
 */
async function copyArtifactSource(
  sourcePath: string,
  destPath: string,
  kind: 'file' | 'directory',
): Promise<void> {
  if (kind === 'file') {
    await mkdir(path.dirname(destPath), { recursive: true });
    await copyFile(sourcePath, destPath);
    return;
  }
  await mkdir(destPath, { recursive: true });
  await cp(sourcePath, destPath, { recursive: true, force: true });
}

function normalizePackageRelativePath(value: string): string | null {
  const normalized = value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^artifacts\//, '')
    .replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return null;
  const posixPath = path.posix.normalize(normalized);
  if (posixPath === '.' || posixPath.startsWith('../') || path.posix.isAbsolute(posixPath)) {
    return null;
  }
  if (posixPath.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  return posixPath;
}

function collectEvidenceManifestPath(value: unknown, paths: Set<string>): void {
  if (typeof value !== 'string') return;
  const normalized = normalizePackageRelativePath(value);
  if (normalized) paths.add(normalized);
}

function extractEvidenceManifestPackagePaths(raw: string): string[] {
  const parsed = JSON.parse(raw) as {
    before_after_pairs?: unknown;
    standalone?: unknown;
    videos?: unknown;
  };
  const paths = new Set<string>();
  if (Array.isArray(parsed.before_after_pairs)) {
    for (const entry of parsed.before_after_pairs) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as { before?: unknown; after?: unknown };
      collectEvidenceManifestPath(row.before, paths);
      collectEvidenceManifestPath(row.after, paths);
    }
  }
  if (Array.isArray(parsed.standalone)) {
    for (const entry of parsed.standalone) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as { file?: unknown };
      collectEvidenceManifestPath(row.file, paths);
    }
  }
  if (parsed.videos && typeof parsed.videos === 'object') {
    for (const [key, value] of Object.entries(parsed.videos as Record<string, unknown>)) {
      if (key === 'note' || key === 'preferred') continue;
      collectEvidenceManifestPath(value, paths);
    }
  }
  return [...paths].sort();
}

function inheritedPackageRunId(sourceRunId: string | undefined): string {
  const suffix = (sourceRunId ?? 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  return `inherited-${suffix || 'package'}`;
}

async function copyIfExists(sourceRoot: string, destRoot: string, relativePath: string) {
  const normalized = normalizePackageRelativePath(relativePath);
  if (!normalized) return false;
  const sourcePath = path.join(sourceRoot, normalized);
  if (!(await artifactSourceExists(sourcePath, 'file'))) return false;
  const destPath = path.join(destRoot, normalized);
  await copyArtifactSource(sourcePath, destPath, 'file');
  return true;
}

export function isFollowUpFlow(flowType: FlowType): boolean {
  return flowType === 'review-pr' || flowType === 'pr-complete' || flowType === 'merge-main';
}

export function resolveFamilyIdentity(
  run: Pick<Run, 'id' | 'ticketOrPr' | 'familyId' | 'familyRootTicketOrPr'>,
): {
  familyId: string;
  familyRootTicketOrPr: string;
} {
  return {
    familyId: run.familyId || run.id,
    familyRootTicketOrPr: run.familyRootTicketOrPr || run.ticketOrPr,
  };
}

export function buildFollowUpLineage(
  parentRun: Pick<Run, 'id' | 'ticketOrPr' | 'familyId' | 'familyRootTicketOrPr'>,
): Pick<RunCreateParams, 'familyId' | 'parentRunId' | 'familyRootTicketOrPr'> {
  const { familyId, familyRootTicketOrPr } = resolveFamilyIdentity(parentRun);
  return {
    familyId,
    parentRunId: parentRun.id,
    familyRootTicketOrPr,
  };
}

export function buildFollowUpClassification(
  parentRun: Pick<Run, 'lane' | 'variant'>,
): Pick<RunCreateParams, 'lane' | 'variant'> {
  return {
    lane: parentRun.lane,
    variant: parentRun.variant ?? undefined,
  };
}

export function summarizeRunScope(
  run: Pick<Run, 'flowType' | 'ticketOrPr' | 'summary' | 'ticketData'>,
): string {
  const summary = run.summary?.trim();
  if (summary) return summary;
  const title = run.ticketData?.title?.trim();
  if (title && title !== run.ticketOrPr) return `${run.ticketOrPr}: ${title}`;
  const acceptance = run.ticketData?.acceptanceCriteria?.filter(Boolean)[0]?.trim();
  if (acceptance) return `${run.ticketOrPr}: ${acceptance}`;
  return `${run.flowType} ${run.ticketOrPr}`;
}

function buildCurrentTriggerSummary(
  run: Pick<Run, 'flowType' | 'ticketOrPr' | 'summary' | 'ticketData'>,
): string {
  if (run.summary?.trim()) return `${run.flowType}: ${run.summary.trim()}`;
  return `${run.flowType}: ${summarizeRunScope(run)}`;
}

/**
 * Resolve immediate family lineage for a run: family identity, the direct
 * parent (one hop only), the family root, and remaining siblings.
 *
 * Intentionally one-hop — `parentRun` is `run.parentRunId`'s direct match,
 * not a recursive walk. `rootRun` is found by `familyId` match (or
 * `familyRootTicketOrPr` fallback) so root resolution is also one-step.
 * No cycle detection needed inside this function. Callers that walk deeper
 * (e.g. `composeFamilyLearnings` in methods/run.ts which traces parentRunId
 * up to the root) carry their own `seen: Set<string>` guard.
 */
export function getFamilyRuns(
  run: Run,
  allRuns: Run[],
): {
  familyId: string;
  familyRootTicketOrPr: string;
  parentRun: Run | null;
  rootRun: Run;
  otherFamilyRuns: Run[];
} {
  const { familyId, familyRootTicketOrPr } = resolveFamilyIdentity(run);
  const familyRuns = allRuns.filter((candidate) => {
    const candidateFamilyId = candidate.familyId || candidate.id;
    return candidateFamilyId === familyId;
  });
  const parentRun = run.parentRunId
    ? (familyRuns.find((candidate) => candidate.id === run.parentRunId) ?? null)
    : null;
  const rootRun =
    familyRuns.find((candidate) => candidate.id === familyId) ??
    familyRuns.find((candidate) => candidate.ticketOrPr === familyRootTicketOrPr) ??
    run;
  const excluded = new Set([run.id, parentRun?.id, rootRun.id].filter(Boolean) as string[]);
  const otherFamilyRuns = familyRuns
    .filter((candidate) => !excluded.has(candidate.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return { familyId, familyRootTicketOrPr, parentRun, rootRun, otherFamilyRuns };
}

function buildArtifactCandidates(
  run: Run,
  taskAbsDir: string,
  allRuns: Run[],
  spec: FamilyArtifactSpec,
): FamilyArtifactCandidate[] {
  const candidates: FamilyArtifactCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (tier: ResolutionTier, sourcePath: string, sourceRunId?: string) => {
    if (seen.has(sourcePath)) return;
    seen.add(sourcePath);
    candidates.push({ tier, sourcePath, sourceRunId });
  };

  addCandidate('task-local-inherited', path.join(taskAbsDir, spec.materializedRelativePath));

  const currentRunTaskDir = runTaskDir(run);
  if (currentRunTaskDir)
    addCandidate(
      'current-run-artifact',
      path.join(currentRunTaskDir, spec.sourceRelativePath),
      run.id,
    );

  const { parentRun, rootRun, otherFamilyRuns } = getFamilyRuns(run, allRuns);
  const parentTaskDir = parentRun ? runTaskDir(parentRun) : null;
  if (parentTaskDir)
    addCandidate(
      'parent-run-artifact',
      path.join(parentTaskDir, spec.sourceRelativePath),
      parentRun!.id,
    );

  const rootTaskDir = runTaskDir(rootRun);
  if (rootTaskDir)
    addCandidate(
      'family-root-artifact',
      path.join(rootTaskDir, spec.sourceRelativePath),
      rootRun.id,
    );

  for (const familyRun of otherFamilyRuns) {
    const familyTaskDir = runTaskDir(familyRun);
    if (!familyTaskDir) continue;
    addCandidate(
      'family-member-artifact',
      path.join(familyTaskDir, spec.sourceRelativePath),
      familyRun.id,
    );
  }

  return candidates;
}

async function materializeInheritedEvidencePackage(
  run: Run,
  taskAbsDir: string,
  allRuns: Run[],
): Promise<FamilyArtifactManifestEntry> {
  const spec: FamilyArtifactSpec = {
    key: 'evidence-package',
    label: 'Recipe evidence package',
    sourceRelativePath: 'artifacts/evidence-manifest.json',
    materializedRelativePath: 'inputs/inherited/evidence-manifest.json',
  };
  const candidates = buildArtifactCandidates(run, taskAbsDir, allRuns, spec);
  const attempts: FamilyArtifactManifestEntry['attempts'] = [];

  for (const candidate of candidates) {
    const exists = await artifactSourceExists(candidate.sourcePath, 'file');
    attempts.push({
      tier: candidate.tier,
      sourceRunId: candidate.sourceRunId,
      sourcePath: candidate.sourcePath,
      exists,
    });
    if (!exists) continue;

    const sourceArtifactsRoot = path.dirname(candidate.sourcePath);
    const manifestRaw = await readFile(candidate.sourcePath, 'utf-8');
    const referencedPaths = extractEvidenceManifestPackagePaths(manifestRaw);
    const packageRunId = inheritedPackageRunId(candidate.sourceRunId);
    const packageRelativeRoot = `recipe-runs/${packageRunId}`;
    const packageRoot = path.join(taskAbsDir, 'artifacts', packageRelativeRoot);
    const materializedManifestPath = path.join(taskAbsDir, spec.materializedRelativePath);

    await copyArtifactSource(candidate.sourcePath, materializedManifestPath, 'file');
    await mkdir(packageRoot, { recursive: true });

    for (const staticFile of RECIPE_PACKAGE_STATIC_FILES) {
      await copyIfExists(sourceArtifactsRoot, packageRoot, staticFile);
    }
    for (const referencedPath of referencedPaths) {
      await copyIfExists(sourceArtifactsRoot, packageRoot, referencedPath);
    }

    await writeFile(
      path.join(taskAbsDir, 'artifacts', 'latest-valid-recipe-run.json'),
      JSON.stringify(
        {
          version: 1,
          runId: packageRunId,
          relativeArtifactRoot: packageRelativeRoot,
          updatedAt: new Date().toISOString(),
          source: 'inherited-family-package',
          sourceRunId: candidate.sourceRunId ?? null,
        },
        null,
        2,
      ),
      'utf-8',
    );

    return {
      artifact: 'evidence-package',
      label: 'Recipe evidence package',
      status: 'resolved',
      resolutionTier: candidate.tier,
      sourceRunId: candidate.sourceRunId,
      sourcePath: candidate.sourcePath,
      materializedPath: spec.materializedRelativePath,
      seededPath: packageRelativeRoot,
      attempts,
    };
  }

  return {
    artifact: 'evidence-package',
    label: 'Recipe evidence package',
    status: 'missing',
    attempts,
  };
}

export async function materializeInheritedContext(
  run: Run,
  taskAbsDir: string,
  allRuns?: Run[],
): Promise<FamilyContextManifest | null> {
  if (!run.parentRunId) return null;
  if (!isFollowUpFlow(run.flowType)) return null;
  const relevantRuns =
    allRuns ?? (run.familyId ? listRuns({ familyId: run.familyId }).runs : getAllRuns());

  await mkdir(path.join(taskAbsDir, 'inputs', 'inherited'), { recursive: true });

  const { familyId, familyRootTicketOrPr, rootRun } = getFamilyRuns(run, relevantRuns);
  const manifest: FamilyContextManifest = {
    version: 1,
    familyId,
    familyRootTicketOrPr,
    parentRunId: run.parentRunId ?? null,
    originalFamilyScopeSummary: summarizeRunScope(rootRun),
    currentTriggerSummary: buildCurrentTriggerSummary(run),
    requiredScopeVerdicts: [...FOLLOW_UP_SCOPE_VERDICTS],
    provenancePolicy: 'resolve-materialize-reference',
    inheritedArtifacts: [],
    generatedAt: new Date().toISOString(),
  };

  for (const spec of FAMILY_ARTIFACT_SPECS) {
    const candidates = buildArtifactCandidates(run, taskAbsDir, relevantRuns, spec);
    const attempts: FamilyArtifactManifestEntry['attempts'] = [];
    let resolved: FamilyArtifactManifestEntry | null = null;

    const kind: 'file' | 'directory' = spec.kind ?? 'file';
    for (const candidate of candidates) {
      const exists = await artifactSourceExists(candidate.sourcePath, kind);
      attempts.push({
        tier: candidate.tier,
        sourceRunId: candidate.sourceRunId,
        sourcePath: candidate.sourcePath,
        exists,
      });
      if (!exists || resolved) continue;

      const materializedPath = path.join(taskAbsDir, spec.materializedRelativePath);
      if (candidate.sourcePath !== materializedPath) {
        await copyArtifactSource(candidate.sourcePath, materializedPath, kind);
      }

      let seededPath: string | undefined;
      if (spec.seedCurrentRelativePath) {
        const currentArtifactPath = path.join(taskAbsDir, spec.seedCurrentRelativePath);
        const currentArtifactExists = await artifactSourceExists(currentArtifactPath, kind);
        if (!currentArtifactExists) {
          const seedSource =
            candidate.sourcePath === currentArtifactPath ? materializedPath : candidate.sourcePath;
          if (seedSource !== currentArtifactPath)
            await copyArtifactSource(seedSource, currentArtifactPath, kind);
        }
        seededPath = spec.seedCurrentRelativePath;
      }

      resolved = {
        artifact: spec.key,
        label: spec.label,
        status: 'resolved',
        resolutionTier: candidate.tier,
        sourceRunId: candidate.sourceRunId,
        sourcePath: candidate.sourcePath,
        materializedPath: spec.materializedRelativePath,
        seededPath,
        attempts,
      };
    }

    manifest.inheritedArtifacts.push(
      resolved ?? {
        artifact: spec.key,
        label: spec.label,
        status: 'missing',
        attempts,
      },
    );
  }

  manifest.inheritedArtifacts.push(
    await materializeInheritedEvidencePackage(run, taskAbsDir, relevantRuns),
  );

  await writeFile(
    path.join(taskAbsDir, 'inputs', 'inherited-context.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );

  // Drop the live-recipe-context caches now that we've seeded fresh
  // artifacts/recipe.json + artifacts/recipe-flows/ for this child run.
  // Without this, a UI panel opening for this run mid-WRITE_TASK would
  // serve any earlier-cached values (parent's or empty negatives) for up
  // to 5s after the seed, defeating the whole inheritance flow.
  invalidateArtifactTextCache(path.join(taskAbsDir, 'artifacts'), run.slotId);
  invalidateLiveRecipeContextMemo(run.id);

  return manifest;
}

export function buildFollowUpScopeContractSection(
  taskDir: string,
  manifest: FamilyContextManifest,
): string {
  const resolvedArtifacts =
    manifest.inheritedArtifacts
      .filter((entry) => entry.status === 'resolved')
      .map((entry) => `- ${entry.label}: ${entry.materializedPath}`)
      .join('\n') || '- None resolved';
  const missingArtifacts =
    manifest.inheritedArtifacts
      .filter((entry) => entry.status === 'missing')
      .map((entry) => `- ${entry.label}`)
      .join('\n') || '- None';

  return [
    '',
    '---',
    '',
    '## Follow-up Family Context',
    '',
    `- Family ID: ${manifest.familyId}`,
    `- Family root reference: ${manifest.familyRootTicketOrPr}`,
    `- Parent run: ${manifest.parentRunId ?? 'none'}`,
    `- Original family scope summary: ${manifest.originalFamilyScopeSummary}`,
    `- Current trigger summary: ${manifest.currentTriggerSummary}`,
    `- Inherited context manifest: ${taskDir}/inputs/inherited-context.json`,
    '',
    '### Resolved inherited artifacts',
    resolvedArtifacts,
    '',
    '### Missing inherited artifacts',
    missingArtifacts,
    '',
    '### Required follow-up scope output',
    `Before completion, write ${taskDir}/artifacts/family-scope.json with JSON containing:`,
    '- `originalFamilyScopeSummary`',
    '- `currentTriggerSummary`',
    `- \`scopeVerdict\` = one of: ${FOLLOW_UP_SCOPE_VERDICTS.join(' | ')}`,
    '- `notes` — brief evidence-based rationale',
    '',
    'Use inherited context by file path. Do not inline large copied blobs into the task response.',
  ].join('\n');
}

export function getFamilyRecoveryLedger(
  familyId: string,
): import('@farmslot/protocol').RunReplayStep[] {
  return getAllRuns()
    .filter((run) => (run.familyId || run.id) === familyId)
    .flatMap((run) => run.recoveryAttempts ?? [])
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
