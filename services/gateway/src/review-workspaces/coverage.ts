import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  composeReviewArtifacts,
  coverageDefinitions,
  type CoverageIndex,
  type CoveragePolicy,
  coverageRowKey,
  parseCoverageSourceHashes,
  readCoverageIndex,
  readReviewTaskFile,
  relativeFile,
  reusableCoverageRows,
  reviewCoverageEvidencePaths,
  reviewCoverageSourcePaths,
  sha256,
} from '@farmslot/agent-runtime/scripts/review-coverage.cjs';
import { REVIEW_DIFF_SCOPE_RULE } from '@farmslot/agent-runtime/scripts/review-diff-scope.cjs';
import type {
  EvidenceManifestEntry,
  ReviewIssue,
  ReviewWorkspaceSubject,
  Run,
} from '@farmslot/protocol';

export interface WarmDeltaCoverageRow {
  key: string;
  kind: 'scope' | 'criterion';
  label: string;
  outcome?: string;
  sourcePaths: string[];
}

export interface WarmDeltaPacket {
  schemaVersion: 1;
  runId: string;
  chainId: string;
  reviewId?: string;
  baselineHeadSha: string;
  currentHeadSha: string;
  comparedRanges: string[];
  scopePaths: string[];
  deltaPaths: string[];
  unresolvedFindings: ReviewIssue[];
  baselineRefs: EvidenceManifestEntry[];
  candidateRows: WarmDeltaCoverageRow[];
  reusableKeys: string[];
  requiresEvaluation: string[];
  compactionFocus: string;
  completionActions: string[];
}
export interface PreparedReviewCoverage {
  policy: CoveragePolicy;
  priorIndexBytes?: string;
  packet?: WarmDeltaPacket;
}
export interface PrepareReviewCoverageInput {
  run: Run;
  subject: ReviewWorkspaceSubject;
  instructionFiles: Array<{ path: string; sha256: string }>;
  viewDir: (runId: string) => string;
  getPrior: (runId: string) => Run | undefined | Promise<Run | undefined>;
  git: (args: string[]) => Promise<string>;
}

async function optionalBytes(file: string) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The prior run's retained artifact hashes remain authority; model-authored indexes do not. */
async function baselineCoverage(input: PrepareReviewCoverageInput) {
  const context = input.run.repeatReviewContext;
  const ref = context?.artifactRefs.find((row) => row.path === 'artifacts/review-coverage.json');
  const report = context?.artifactRefs.find((row) => row.path === 'artifacts/review.md');
  if (!context?.priorReviewedHeadSha || !ref?.sha256 || !report?.sha256) return undefined;
  const ids = [
    ...new Set(
      [
        context.priorRunId,
        context.originatingRunId,
        ...(context.priorGenerations ?? []).map((row) => row.runId),
      ].filter((id): id is string => !!id),
    ),
  ];
  for (const id of ids) {
    const prior = await input.getPrior(id);
    if (
      !prior ||
      prior.id !== id ||
      prior.project !== input.run.project ||
      prior.familyId !== context.priorFamilyId
    )
      continue;
    const bytes = await optionalBytes(path.join(input.viewDir(id), ref.path));
    if (!bytes) continue;
    const identity = {
      runId: id,
      headSha: context.priorReviewedHeadSha,
      indexSha256: ref.sha256,
      reportSha256: report.sha256,
    };
    const index = readCoverageIndex(bytes.toString('utf8'), identity);
    const reportBytes = await optionalBytes(path.join(input.viewDir(id), report.path));
    if (!index || !reportBytes || sha256(reportBytes) !== report.sha256) continue;
    const evidenceHashes: Record<string, string> = {};
    const refs = [...new Set(index.rows.flatMap((row) => Object.keys(row.evidenceHashes)))];
    await Promise.all(
      refs.map(async (key) => {
        const separator = key.indexOf(':');
        const owner = key.slice(0, separator),
          file = key.slice(separator + 1);
        if (separator < 1 || !ids.includes(owner)) {
          evidenceHashes[key] = 'missing';
          return;
        }
        relativeFile(file);
        if (!file.startsWith('artifacts/') || file === 'artifacts/acceptance-status.json')
          throw new Error('Review coverage cannot use the engine acceptance ledger');
        const bytes = await optionalBytes(path.join(input.viewDir(owner), file));
        evidenceHashes[key] = bytes ? sha256(bytes) : 'missing';
      }),
    );
    return { bytes: bytes.toString('utf8'), index, identity: { ...identity, evidenceHashes } };
  }
  return undefined;
}

export async function prepareReviewCoverage(
  input: PrepareReviewCoverageInput,
): Promise<PreparedReviewCoverage | undefined> {
  const { run, subject } = input;
  // Older frozen subjects cannot certify whole-contribution row reuse. Keep their
  // original manual report contract rather than inventing a publication baseline.
  if (!subject.contributionBaseSha || !run.reviewWorkspace || !run.executionTemplate)
    return undefined;
  const scopePaths = (
    await input.git([
      'diff',
      '--no-ext-diff',
      '--no-renames',
      '--name-only',
      '-z',
      subject.contributionBaseSha,
      subject.headSha,
      '--',
    ])
  )
    .split('\0')
    .filter(Boolean)
    .map(relativeFile);
  const policy: CoveragePolicy = {
    schemaVersion: 1,
    runId: run.id,
    repo: run.reviewWorkspace.checkoutPath,
    headSha: subject.headSha,
    scopePaths,
    authorizationHash: sha256(
      JSON.stringify({
        repository: subject.repository,
        title: subject.title,
        body: subject.body,
        criteria: run.ticketData?.acceptanceCriteria ?? [],
      }),
    ),
    ruleHash: sha256(
      JSON.stringify({
        template: run.executionTemplate.sha256,
        instructions: input.instructionFiles,
        support: run.reviewWorkspace.support?.sha256,
        depth: run.reviewValidationDepth,
        scopeRule: REVIEW_DIFF_SCOPE_RULE,
      }),
    ),
  };
  const context = run.repeatReviewContext;
  const deltaScoped =
    context?.mode === 'warm' ||
    Boolean(context?.session?.fallback && context.session.fallback.reason !== 'retention-expired');
  const baseline = deltaScoped ? await baselineCoverage(input) : undefined;
  if (baseline) policy.baseline = baseline.identity;
  if (!deltaScoped || !context?.priorReviewedHeadSha) return { policy };
  const index: CoverageIndex | null = baseline?.index ?? null;
  const definitions = [
    ...scopePaths.map((file) => ({ kind: 'scope' as const, path: file })),
    ...(index?.rows
      .filter((row) => row.definition.kind === 'criterion')
      .map((row) => row.definition) ?? []),
  ];
  const sourcePaths = [
    ...new Set([
      ...scopePaths,
      ...(index?.rows.flatMap((row) => Object.keys(row.sourceHashes)) ?? []),
    ]),
  ].map(relativeFile);
  const tree = sourcePaths.length
    ? await input.git([
        '--literal-pathspecs',
        'ls-tree',
        '-r',
        '-z',
        '--full-tree',
        subject.headSha,
        '--',
        ...sourcePaths,
      ])
    : '';
  const selected = reusableCoverageRows(index, {
    ...policy,
    definitions,
    sourceHashes: parseCoverageSourceHashes(tree, sourcePaths, scopePaths),
    evidenceHashes: baseline?.identity.evidenceHashes ?? {},
  });
  const reusable = new Set(selected.reusable.map((row) => row.key));
  const deltaPaths = (
    await input.git([
      'diff',
      '--no-ext-diff',
      '--no-renames',
      '--name-only',
      '-z',
      context.priorReviewedHeadSha,
      subject.headSha,
      '--',
    ])
  )
    .split('\0')
    .filter(Boolean)
    .map(relativeFile);
  const packet: WarmDeltaPacket = {
    schemaVersion: 1,
    runId: run.id,
    baselineHeadSha: context.priorReviewedHeadSha,
    chainId: context.chainId,
    reviewId: context.session?.reviewId,
    currentHeadSha: subject.headSha,
    comparedRanges: context.session?.fallback?.comparedRanges ?? [
      `${subject.baseSha}..${subject.headSha}`,
    ],
    scopePaths,
    deltaPaths,
    unresolvedFindings: context.unresolvedFindings,
    baselineRefs: context.artifactRefs,
    candidateRows: (index?.rows ?? []).map((row) => ({
      key: row.key,
      kind: row.definition.kind,
      label: row.definition.kind === 'scope' ? row.definition.path : row.definition.label,
      outcome: row.value.outcome ?? row.value.scope,
      sourcePaths: Object.keys(row.sourceHashes),
    })),
    reusableKeys: [...reusable],
    requiresEvaluation: definitions.map(coverageRowKey).filter((key) => !reusable.has(key)),
    compactionFocus: `Retain reviewed head ${context.priorReviewedHeadSha}, review knowledge, unresolved findings and frozen audit references. Retire obsolete task paths, commands, checklist ticks and unfinished operational instructions from earlier completed tasks. Do not inspect source or use tools during this maintenance. No task is active until the next message explicitly binds its current instructions.`,
    completionActions: [
      'Register required child checklists before writing coverage.',
      'Review the frozen delta and recheck prior findings and every rule applicability.',
      'Author current findings/result and changed coverage rows; do not regenerate unchanged tables.',
      'Use the existing mark completion commands; the shared runtime composes full scope/criteria tables before validation.',
    ],
  };
  return { policy, ...(baseline ? { priorIndexBytes: baseline.bytes } : {}), packet };
}

/** Acceptance recomputes the index from frozen policy and independently read proof. */
export async function verifyReviewCoverage(
  input: PrepareReviewCoverageInput,
  taskDir: string,
  policy: CoveragePolicy,
  result: { coverage?: unknown; issues?: unknown },
  report: string,
): Promise<void> {
  if (
    policy.runId !== input.run.id ||
    policy.headSha !== input.subject.headSha ||
    policy.repo !== input.run.reviewWorkspace?.checkoutPath
  )
    throw new Error('Review coverage policy belongs to another review');
  if (input.run.reviewWorkspace.cleanedAt) {
    const accepted = input.run.reviewResult;
    if (accepted?.reviewSnapshot?.headSha !== policy.headSha || !accepted.artifactManifest?.length)
      throw new Error('Cleaned review coverage has no accepted result receipt');
    for (const file of [
      'artifacts/review.md',
      'artifacts/review-result.json',
      'artifacts/review-coverage.json',
      'artifacts/review-ledger.md',
      ...reviewCoverageEvidencePaths(result.coverage),
    ]) {
      const expected = accepted.artifactManifest.find((row) => row.path === file)?.sha256;
      const bytes = readReviewTaskFile(taskDir, file, null);
      if (!expected || bytes === undefined || sha256(bytes) !== expected)
        throw new Error('Cleaned review coverage differs from its accepted result');
    }
    return;
  }
  const baseline = policy.baseline ? await baselineCoverage(input) : undefined;
  if (
    baseline &&
    (baseline.identity.runId !== policy.baseline?.runId ||
      baseline.identity.indexSha256 !== policy.baseline.indexSha256)
  )
    throw new Error('Review coverage baseline changed during review');
  const definitions = coverageDefinitions(taskDir, policy);
  const files = reviewCoverageSourcePaths(
    policy.scopePaths,
    baseline?.index ?? null,
    result.coverage,
  );
  if ((await input.git(['rev-parse', 'HEAD'])).trim() !== policy.headSha)
    throw new Error('Review source head changed before coverage acceptance');
  const tree = files.length
    ? await input.git([
        '--literal-pathspecs',
        'ls-tree',
        '-r',
        '-z',
        '--full-tree',
        policy.headSha,
        '--',
        ...files,
      ])
    : '';
  const artifactHashes = Object.fromEntries(
    reviewCoverageEvidencePaths(result.coverage).map((file) => {
      const bytes = readReviewTaskFile(taskDir, file, null);
      return [file, bytes === undefined ? 'missing' : sha256(bytes)];
    }),
  );
  const composed = composeReviewArtifacts(
    policy,
    definitions,
    result,
    report,
    baseline?.index ?? null,
    parseCoverageSourceHashes(tree, files, policy.scopePaths),
    artifactHashes,
    baseline?.identity.evidenceHashes ?? {},
  );
  const index = JSON.parse(readReviewTaskFile(taskDir, 'artifacts/review-coverage.json') ?? 'null');
  const ledger = readReviewTaskFile(taskDir, 'artifacts/review-ledger.md');
  if (
    composed.report !== report ||
    composed.ledger !== ledger ||
    !isDeepStrictEqual(composed.index, index)
  )
    throw new Error('Review coverage does not match current rows, source and evidence');
}
