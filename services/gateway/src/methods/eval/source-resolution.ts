import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type EvalExperimentSource,
  type EvalPackageSource,
  type FamilyDiffProvenance,
  type FamilyObservabilityArtifact,
  isFamilyDiffProvenance,
  isResultPackageManifest,
  parseGitHubRef,
  type ResultPackageManifest,
  type Run,
} from '@farmslot/protocol';

import {
  fileExists,
  readTaskDiffProvenance,
  scanResultPackageArtifacts,
  unavailableDiff,
  writeJsonFile,
} from '../../evals/package-store.js';
import { fetchGitHubPR, fetchPRDiffFiles } from '../../external/github.js';
import { loadProjectConfig } from '../../fleet/state.js';
import { getAllRuns, getRun } from '../../runs/store.js';
import {
  assertTicketRefMatchesProjectRepo,
  normalizeTicketRef,
  resolvePrRef,
} from '../dispatch/ticket-ref.js';

export interface ResolvedEvalSource {
  source: EvalPackageSource;
  referenceLabel: string;
  /** Source-family provenance only. Eval experiments must not inherit this as their own family id by default. */
  familyId?: string;
  diff: FamilyDiffProvenance;
  contextArtifacts: FamilyObservabilityArtifact[];
  packageArtifacts: FamilyObservabilityArtifact[];
  diffText?: string;
  mergedPr?: {
    repo: string;
    prNumber: number;
    url: string;
    title: string;
    body: string;
    bodyExcerpt?: string;
    mergedAt: string;
    mergeCommitSha?: string;
    headSha: string;
    baseRef: string;
    baseSha: string;
    headRef: string;
    tickets: string[];
    linkedIssues: string[];
  };
}

function extractJiraTickets(body: string): string[] {
  return [...new Set(body.match(/[A-Z][A-Z0-9]+-\d+/g) ?? [])];
}

function extractGithubIssueRefs(body: string, repo: string): string[] {
  const localRefs = [...body.matchAll(/#(\d+)/g)].map((match) => `${repo}#${match[1]}`);
  const explicitRefs = body.match(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+/g) ?? [];
  return [...new Set([...localRefs, ...explicitRefs])];
}

function buildDiffProvenance(
  repo: string,
  prNumber: number,
  baseRef: string,
  baseSha: string,
  headRef: string,
  headSha: string,
  files: Awaited<ReturnType<typeof fetchPRDiffFiles>>,
): FamilyDiffProvenance {
  const summary = files.reduce(
    (acc, file) => {
      acc.files += 1;
      acc.additions += file.additions;
      acc.deletions += file.deletions;
      return acc;
    },
    { files: 0, additions: 0, deletions: 0 },
  );
  return {
    source: summary.files > 0 ? 'artifact' : 'unavailable',
    available: summary.files > 0,
    files: summary.files,
    additions: summary.additions,
    deletions: summary.deletions,
    kind: 'contribution',
    ...(summary.files > 0
      ? { artifactPath: 'inputs/reference-diff.txt' }
      : { missingReason: 'no-source-diff' }),
    repository: repo,
    prNumber,
    baseRef,
    baseSha,
    headRef,
    headSha,
    capturedAt: new Date().toISOString(),
  };
}

function renderReferenceDiff(files: Awaited<ReturnType<typeof fetchPRDiffFiles>>): string {
  if (files.length === 0) return '# No source diff available for the reference PR\n';
  return files
    .map((file) =>
      [
        `## ${file.filename}`,
        `status: ${file.status} (+${file.additions} -${file.deletions})`,
        file.patch?.trim() || '_patch unavailable_',
      ].join('\n\n'),
    )
    .join('\n\n');
}

async function resolveMergedPrSource(project: string, ref: string): Promise<ResolvedEvalSource> {
  const projectConfig = await loadProjectConfig(project);
  const normalizedRef = normalizeTicketRef(ref);
  const resolvedRef = projectConfig?.ci?.repo
    ? await resolvePrRef(normalizedRef, projectConfig.ci.repo)
    : normalizedRef;
  assertTicketRefMatchesProjectRepo(resolvedRef, project, projectConfig?.ci?.repo);

  const parsed = parseGitHubRef(resolvedRef);
  if (!parsed) throw new Error(`Merged PR eval source must be a GitHub PR reference: ${ref}`);
  const pr = await fetchGitHubPR(resolvedRef);
  if (!pr.merged || !pr.mergedAt)
    throw new Error(`Eval source requires a merged PR: ${resolvedRef}`);

  const diffFiles = await fetchPRDiffFiles(parsed.repo, pr.number);
  const diff = buildDiffProvenance(
    parsed.repo,
    pr.number,
    pr.baseRef,
    pr.baseSha,
    pr.branch,
    pr.headSha,
    diffFiles,
  );
  const tickets = extractGithubIssueRefs(pr.body, parsed.repo);
  const linkedIssues = extractJiraTickets(pr.body);
  return {
    source: {
      kind: 'merged-pr',
      repo: parsed.repo,
      prNumber: pr.number,
      url: pr.url ?? `https://github.com/${parsed.repo}/pull/${pr.number}`,
      title: pr.title,
      baseRef: pr.baseRef,
      baseSha: pr.baseSha,
      headRef: pr.branch,
      headSha: pr.headSha,
      mergedAt: pr.mergedAt,
      mergeCommitSha: pr.mergeCommitSha ?? undefined,
    },
    referenceLabel: `${parsed.repo}#${pr.number}`,
    diff,
    contextArtifacts: [],
    packageArtifacts: [],
    diffText: renderReferenceDiff(diffFiles),
    mergedPr: {
      repo: parsed.repo,
      prNumber: pr.number,
      url: pr.url ?? `https://github.com/${parsed.repo}/pull/${pr.number}`,
      title: pr.title,
      body: pr.body,
      bodyExcerpt: pr.body.slice(0, 500) || undefined,
      mergedAt: pr.mergedAt,
      mergeCommitSha: pr.mergeCommitSha ?? undefined,
      headSha: pr.headSha,
      baseRef: pr.baseRef,
      baseSha: pr.baseSha,
      headRef: pr.branch,
      tickets,
      linkedIssues,
    },
  };
}

async function readRunInputDiffProvenance(run: Run): Promise<FamilyDiffProvenance | null> {
  if (!run.taskFile) return null;
  const filePath = path.join(path.dirname(run.taskFile), 'inputs', 'diff-stat.json');
  if (!(await fileExists(filePath))) return null;
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf-8'));
  return isFamilyDiffProvenance(parsed)
    ? parsed
    : unavailableDiff('invalid-input-diff-stat-artifact');
}

async function readRunContributionDiffProvenance(run: Run): Promise<FamilyDiffProvenance | null> {
  if (!run.taskFile) return null;
  return readTaskDiffProvenance(path.dirname(run.taskFile), 'prior-run-diff-missing');
}

function sortRunsNewestFirst(runs: Run[]): Run[] {
  return [...runs].sort(
    (a, b) => Date.parse(b.updatedAt ?? b.createdAt) - Date.parse(a.updatedAt ?? a.createdAt),
  );
}

async function githubPrDiffForRun(project: string, run: Run): Promise<FamilyDiffProvenance | null> {
  if (run.prNumber == null) return null;
  const projectConfig = await loadProjectConfig(project);
  const repo = projectConfig?.ci?.repo;
  if (!repo) return null;
  const pr = await fetchGitHubPR(`${repo}#${run.prNumber}`);
  const files = await fetchPRDiffFiles(repo, run.prNumber);
  return {
    ...buildDiffProvenance(
      repo,
      run.prNumber,
      pr.baseRef,
      pr.baseSha,
      pr.branch,
      pr.headSha,
      files,
    ),
    kind: 'review-input',
    repository: repo,
    prNumber: run.prNumber,
    capturedAt: new Date().toISOString(),
  };
}

async function bestReferenceDiffForPriorRun(
  project: string,
  run: Run,
  familyRuns: Run[],
): Promise<FamilyDiffProvenance> {
  const newest = sortRunsNewestFirst(familyRuns);
  const samePrRuns =
    run.prNumber == null
      ? newest
      : newest.filter((candidate) => candidate.prNumber === run.prNumber);
  const prSurfaceRuns = samePrRuns.filter(
    (candidate) => candidate.flowType === 'pr-complete' || candidate.flowType === 'review-pr',
  );
  for (const candidate of prSurfaceRuns) {
    const inputDiff = await readRunInputDiffProvenance(candidate);
    if (inputDiff?.available) return inputDiff;
  }

  const selectedContribution = await readRunContributionDiffProvenance(run);
  if (selectedContribution?.available) return selectedContribution;

  for (const candidate of samePrRuns) {
    const contributionDiff = await readRunContributionDiffProvenance(candidate);
    if (contributionDiff?.available) return contributionDiff;
  }

  const githubDiff = await githubPrDiffForRun(project, run);
  if (githubDiff?.available) return githubDiff;

  return run.taskFile
    ? unavailableDiff('prior-run-diff-missing')
    : unavailableDiff('prior-run-task-missing');
}

async function scanPriorRunFamilyArtifacts(
  familyRuns: Run[],
): Promise<FamilyObservabilityArtifact[]> {
  const artifacts = (
    await Promise.all(
      sortRunsNewestFirst(familyRuns).map(async (candidate) => {
        if (!candidate.taskFile) return [];
        return scanResultPackageArtifacts(path.dirname(candidate.taskFile), candidate);
      }),
    )
  ).flat();
  const byKey = new Map<string, FamilyObservabilityArtifact>();
  for (const artifact of artifacts) {
    byKey.set(`${artifact.runId}:${artifact.path}`, artifact);
  }
  return [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function resolvePriorRunSource(
  project: string,
  source: Extract<EvalExperimentSource, { kind: 'prior-run' }>,
): Promise<ResolvedEvalSource> {
  const run = getRun(source.runId);
  if (!run) throw new Error(`Prior run not found: ${source.runId}`);
  const familyRuns = getAllRuns().filter((candidate) => candidate.familyId === run.familyId);
  const diff = await bestReferenceDiffForPriorRun(
    project,
    run,
    familyRuns.length ? familyRuns : [run],
  );
  const packageArtifacts = await scanPriorRunFamilyArtifacts(
    familyRuns.length ? familyRuns : [run],
  );
  return {
    source: { kind: 'prior-run', runId: run.id, familyId: run.familyId, taskFile: run.taskFile },
    referenceLabel: `run ${run.id.slice(0, 8)}`,
    familyId: run.familyId,
    diff,
    contextArtifacts: [],
    packageArtifacts,
  };
}

async function resolvePackageSource(
  source: Extract<EvalExperimentSource, { kind: 'package' }>,
): Promise<{ resolved: ResolvedEvalSource; package: ResultPackageManifest }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(source.packagePath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Invalid result package source: ${source.packagePath}: ${(err as Error).message}`,
    );
  }
  if (!isResultPackageManifest(parsed))
    throw new Error(`Invalid result package source: ${source.packagePath}`);
  return {
    resolved: {
      source: {
        kind: 'package',
        packageId: parsed.packageId,
        packageHash: parsed.packageHash,
        packagePath: source.packagePath,
      },
      referenceLabel: `package ${parsed.packageId}`,
      familyId: parsed.familyId,
      diff: parsed.diff,
      contextArtifacts: [],
      packageArtifacts: parsed.validationEvidence,
    },
    package: parsed,
  };
}

function resolveGitRefSource(
  source: Extract<EvalExperimentSource, { kind: 'git-ref' }>,
): ResolvedEvalSource {
  return {
    source: {
      kind: 'git-ref',
      ref: source.ref,
      repository: source.repository,
      baseRef: source.baseRef,
      baseSha: source.baseSha,
      headRef: source.headRef,
      headSha: source.headSha,
    },
    referenceLabel: source.repository ? `${source.repository}@${source.ref}` : source.ref,
    diff: unavailableDiff('git-ref-diff-unavailable', {
      repository: source.repository,
      baseRef: source.baseRef,
      baseSha: source.baseSha,
      headRef: source.headRef,
      headSha: source.headSha,
    }),
    contextArtifacts: [],
    packageArtifacts: [],
  };
}

export async function resolveEvalSource(
  project: string,
  source: EvalExperimentSource,
): Promise<{ resolved: ResolvedEvalSource; package?: ResultPackageManifest }> {
  if (source.kind === 'merged-pr')
    return { resolved: await resolveMergedPrSource(project, source.ref) };
  if (source.kind === 'prior-run')
    return { resolved: await resolvePriorRunSource(project, source) };
  if (source.kind === 'package') return resolvePackageSource(source);
  return { resolved: resolveGitRefSource(source) };
}

export async function writeMergedPrInputs(
  evalRoot: string,
  resolved: ResolvedEvalSource,
): Promise<FamilyObservabilityArtifact[]> {
  if (!resolved.mergedPr) return [];
  const inputsDir = path.join(evalRoot, 'inputs');
  await mkdir(inputsDir, { recursive: true });
  await writeJsonFile(path.join(inputsDir, 'reference-pr.json'), {
    repo: resolved.mergedPr.repo,
    prNumber: resolved.mergedPr.prNumber,
    url: resolved.mergedPr.url,
    title: resolved.mergedPr.title,
    body: resolved.mergedPr.body,
    merged: true,
    mergedAt: resolved.mergedPr.mergedAt,
    mergeCommitSha: resolved.mergedPr.mergeCommitSha,
    baseRef: resolved.mergedPr.baseRef,
    baseSha: resolved.mergedPr.baseSha,
    headRef: resolved.mergedPr.headRef,
    headSha: resolved.mergedPr.headSha,
  });
  await writeJsonFile(path.join(inputsDir, 'reference-context.json'), {
    linkedIssues: resolved.mergedPr.linkedIssues,
    tickets: resolved.mergedPr.tickets,
  });
  await writeFile(
    path.join(inputsDir, 'reference-diff.txt'),
    resolved.diffText ?? '# No source diff text available for this eval source\n',
    'utf-8',
  );
  await writeJsonFile(path.join(inputsDir, 'reference-diff-stat.json'), resolved.diff);
  return [
    {
      runId: 'eval-reference',
      familyId: 'eval-reference',
      path: 'inputs/reference-pr.json',
      purpose: 'reference-pr-metadata',
      source: 'task-input',
    },
    {
      runId: 'eval-reference',
      familyId: 'eval-reference',
      path: 'inputs/reference-diff.txt',
      purpose: 'reference-diff',
      source: 'task-input',
    },
    {
      runId: 'eval-reference',
      familyId: 'eval-reference',
      path: 'inputs/reference-diff-stat.json',
      purpose: 'reference-diff-stat',
      source: 'task-input',
    },
    {
      runId: 'eval-reference',
      familyId: 'eval-reference',
      path: 'inputs/reference-context.json',
      purpose: 'reference-context',
      source: 'task-input',
    },
  ];
}
