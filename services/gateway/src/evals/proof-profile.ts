import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { executionTemplateReference } from '@farmslot/agent-runtime';
import {
  type CommandOutput,
  type EvalExperimentCreateParams,
  type EvalProofInput,
  type EvalProofSource,
  type FamilyObservabilityArtifact,
  isRecord,
  type ResultPackageManifest,
  selectQaProfile,
} from '@farmslot/protocol';

import { loadProjectVars } from '../core/config.js';
import { ghRequest } from '../integrations/github-client.js';
import type { ResolvedEvalSource } from '../methods/eval/source-resolution.js';
import { readRetainedRunText } from '../run-completion/retained-artifacts.js';
import { getRunWithArchived } from '../runs/store.js';
import {
  configuredExecutionTemplateOptions,
  readConfiguredExecutionTemplateSnapshot,
} from '../tasks/execution-template-catalog.js';

import { FULL_COMMIT, stablePatchId } from './blind-inputs.js';
import { sha256Text } from './package-store.js';

export interface ResolvedProofInput {
  proof: EvalProofInput;
  diffText: string;
}

function fullCommit(value: string | undefined): value is string {
  return typeof value === 'string' && FULL_COMMIT.test(value);
}

/** Extract recorded anchors before any network or profile work, never a requested ref. */
export function proofSourceAnchors(
  resolved: ResolvedEvalSource,
  retained?: ResultPackageManifest,
): { baseSha?: string; headSha: string; repository: string } {
  const source = resolved.source;
  const headSha =
    source.kind === 'merged-pr'
      ? source.mergeCommitSha
      : source.kind === 'git-ref'
        ? source.headSha
        : (retained?.head?.headSha ?? resolved.diff.headSha);
  const baseSha =
    source.kind === 'merged-pr'
      ? undefined
      : source.kind === 'git-ref'
        ? source.baseSha
        : (retained?.baseline?.baseSha ?? resolved.diff.baseSha);
  if (!fullCommit(headSha) || (source.kind !== 'merged-pr' && !fullCommit(baseSha)))
    throw new Error(
      'Proof profile requires a committed implementation and QA base range. Materialize an uncommitted-only change before admission.',
    );
  const repository =
    source.kind === 'merged-pr'
      ? source.repo
      : source.kind === 'git-ref'
        ? source.repository
        : (retained?.diff.repository ?? resolved.diff.repository);
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error('Proof profile requires the recorded repository of its committed QA source.');
  return { headSha, baseSha, repository };
}

async function recordedDiff(resolved: ResolvedEvalSource): Promise<string | undefined> {
  if (resolved.diffText !== undefined) return resolved.diffText;
  if (resolved.source.kind === 'git-ref') return undefined;
  if (!resolved.diff.artifactPath)
    throw new Error('Proof profile requires the recorded implementation diff.');
  const root =
    resolved.source.kind === 'package' && resolved.source.packagePath
      ? path.dirname(path.dirname(path.dirname(resolved.source.packagePath)))
      : resolved.source.kind === 'prior-run' && resolved.source.taskFile
        ? path.dirname(resolved.source.taskFile)
        : undefined;
  if (!root)
    throw new Error('Proof profile recorded implementation diff has no retained artifact root.');
  const file = path.resolve(root, resolved.diff.artifactPath);
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Proof profile implementation diff escapes its retained package.');
  return readFile(file, 'utf8');
}

export interface ProofInputDependencies {
  request: (args: string[]) => Promise<Pick<CommandOutput, 'stdout'>>;
  admitQa: (
    params: EvalExperimentCreateParams,
  ) => Promise<Pick<EvalProofInput, 'qa' | 'executionTemplate'>>;
}

export async function admitProofQa(
  params: EvalExperimentCreateParams,
): Promise<Pick<EvalProofInput, 'qa' | 'executionTemplate'>> {
  const vars = await loadProjectVars(params.project);
  const qa = selectQaProfile(vars.projectJson.qa, params.qaProfileId, params.qaInputs);
  const catalog = configuredExecutionTemplateOptions(vars, {
    flow: 'qa',
    explicitId: qa.profile.template_id,
  });
  const template = catalog.options.find((option) => option.id === qa.profile.template_id);
  if (!template) throw new Error('Proof profile requires its admitted farm QA execution template.');
  const snapshot = readConfiguredExecutionTemplateSnapshot(vars, { ...template, flow: 'qa' });
  return { qa, executionTemplate: executionTemplateReference(snapshot.entry) };
}

const defaults: ProofInputDependencies = { request: ghRequest, admitQa: admitProofQa };

async function rejectKnownProofOverlap(
  resolved: ResolvedEvalSource,
  treeSha: string,
  repository: string,
  request: ProofInputDependencies['request'],
): Promise<void> {
  const known = resolved.packageArtifacts.filter((artifact) =>
    /(?:^|\/)recipe\.json$/i.test(artifact.path),
  );
  if (!known.length) return;
  const response = await request(['api', `repos/${repository}/git/trees/${treeSha}?recursive=1`]);
  const tree: unknown = JSON.parse(response.stdout);
  if (!isRecord(tree) || tree.truncated !== false || !Array.isArray(tree.tree))
    throw new Error(
      'Cannot inspect the complete implementation for known reference proof overlap.',
    );
  for (const artifact of known) {
    const text = await knownProofText(artifact);
    if (!artifact.sha256 || sha256Text(text) !== artifact.sha256)
      throw new Error('Known reference proof bytes are unavailable or changed.');
    const blobSha = createHash('sha1')
      .update(`blob ${Buffer.byteLength(text)}\0`)
      .update(text)
      .digest('hex');
    if (
      tree.tree.some(
        (entry) =>
          isRecord(entry) &&
          entry.type === 'blob' &&
          (entry.sha === blobSha || entry.path === artifact.path),
      )
    )
      throw new Error('Supplied implementation contains a known reference proof.');
  }
}

async function knownProofText(artifact: FamilyObservabilityArtifact): Promise<string> {
  const run = await getRunWithArchived(artifact.runId);
  if (run?.output?.artifactBundle || run?.artifactBundle)
    return readRetainedRunText(run, artifact.path);
  if (run?.taskFile) return readFile(path.join(path.dirname(run.taskFile), artifact.path), 'utf8');
  if (path.isAbsolute(artifact.path)) return readFile(artifact.path, 'utf8');
  throw new Error('Known reference proof cannot be resolved without its retained source.');
}

export async function resolveProofInput(
  params: EvalExperimentCreateParams,
  resolved: ResolvedEvalSource,
  retained?: ResultPackageManifest,
  dependencies: ProofInputDependencies = defaults,
): Promise<ResolvedProofInput> {
  if (
    !params.objective?.trim() ||
    !params.acceptanceCriteria?.length ||
    params.acceptanceCriteria.some((text) => typeof text !== 'string' || !text.trim())
  )
    throw new Error('Proof profile requires explicit problem text and ordered acceptanceCriteria.');
  const anchors = proofSourceAnchors(resolved, retained);
  const commitResponse = await dependencies.request([
    'api',
    `repos/${anchors.repository}/git/commits/${anchors.headSha}`,
  ]);
  const commit: unknown = JSON.parse(commitResponse.stdout);
  if (
    !isRecord(commit) ||
    commit.sha !== anchors.headSha ||
    !isRecord(commit.tree) ||
    typeof commit.tree.sha !== 'string' ||
    !FULL_COMMIT.test(commit.tree.sha)
  )
    throw new Error('Proof implementation commit/tree could not be verified.');
  const parent = Array.isArray(commit.parents) ? commit.parents[0] : undefined;
  const baseSha =
    anchors.baseSha ??
    (isRecord(parent) && typeof parent.sha === 'string' ? parent.sha : undefined);
  if (!fullCommit(baseSha) || baseSha === anchors.headSha)
    throw new Error('Proof implementation requires a distinct committed QA base.');
  const compare = await dependencies.request([
    'api',
    `repos/${anchors.repository}/compare/${baseSha}...${anchors.headSha}`,
  ]);
  const metadata: unknown = JSON.parse(compare.stdout);
  if (
    !isRecord(metadata) ||
    !isRecord(metadata.merge_base_commit) ||
    metadata.merge_base_commit.sha !== baseSha
  )
    throw new Error('Proof QA base must be an ancestor of the implementation.');
  const diff = await dependencies.request([
    'api',
    `repos/${anchors.repository}/compare/${baseSha}...${anchors.headSha}`,
    '--header',
    'Accept: application/vnd.github.diff',
  ]);
  const patch = await stablePatchId(diff.stdout);
  const expected = await recordedDiff(resolved);
  if (!patch || (expected !== undefined && patch !== (await stablePatchId(expected))))
    throw new Error(
      'Proof committed QA range does not contain the complete recorded/PR change. Use an explicit complete committed source range.',
    );
  await rejectKnownProofOverlap(
    resolved,
    commit.tree.sha,
    anchors.repository,
    dependencies.request,
  );
  const admitted = await dependencies.admitQa(params);
  const source: EvalProofSource = {
    baseSha,
    headSha: anchors.headSha,
    treeSha: commit.tree.sha,
    diffSha256: sha256Text(diff.stdout),
    ...(expected !== undefined ? { recordedDiffSha256: sha256Text(expected) } : {}),
  };
  return {
    proof: { version: 1, source, acceptanceCriteria: [...params.acceptanceCriteria], ...admitted },
    diffText: diff.stdout,
  };
}
