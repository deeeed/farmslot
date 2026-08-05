import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import {
  type ArtifactRef,
  DEFAULT_BRANCH,
  type DiffStat,
  type FamilyDiffKind,
  type FamilyDiffProvenance,
  type FamilyInputCommitMetadata,
  isFamilyDiffProvenance,
  type ReviewDiffSnapshot,
  type Run,
} from '@farmslot/protocol';

import {
  getProjectField,
  getProjectFieldRaw,
  loadProjectVars,
  loadSlotVars,
  type RawProjectJson,
} from '../core/config.js';
import { diffKindForFlow } from '../core/diff-kind.js';
import { execOnSlot } from '../core/exec.js';
import {
  buildSourceDiffFilter,
  isSourceCodePath,
  readSourceDiffFilterConfig,
  sourceCodeGitPathspecs,
  type SourceDiffFilter,
} from '../core/source-diff-filter.js';
import { shellQuote } from '../core/tmux.js';
import { fetchGitHubPR, fetchPRDiffFiles } from '../external/github.js';
import { remoteBranchRefspec } from '../methods/slot/slot-tracking.js';

import {
  atomicWriteTextFile,
  parseDiffTooLargeBytes,
  sha256Text,
  withTimeout,
} from './diff-artifact-utils.js';

type LoadedProjectVars = Awaited<ReturnType<typeof loadProjectVars>>;

async function loadProjectVarsOrNull(
  project: string,
  context: string,
  runId?: string,
): Promise<LoadedProjectVars | null> {
  try {
    return await loadProjectVars(project);
  } catch (err) {
    const runLabel = runId ? ` run ${runId.slice(0, 8)}` : '';
    console.warn(
      `[run-engine] ${context} project config unavailable for ${project}${runLabel}: ${(err as Error).message.slice(0, 200)}`,
    );
    return null;
  }
}

export function parseGitNumstat(
  numstat: string,
  options: { sourceOnly?: boolean; sourceFilter?: SourceDiffFilter } = {},
): DiffStat {
  const lines = numstat.trim().split('\n').filter(Boolean);
  let files = 0,
    additions = 0,
    deletions = 0;
  for (const line of lines) {
    // numstat is tab-separated; using \s+ would split paths containing spaces.
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const filePath = parts.slice(2).join('\t');
    if (options.sourceOnly && !isSourceCodePath(filePath, options.sourceFilter)) continue;
    const a = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    // Binary files emit `-\t-\t<path>` — additions/deletions are NaN and
    // contribute 0 line-deltas, but the file still counts when the path itself
    // is source-allowlisted so diff headers and file counts stay aligned.
    if (!isNaN(a)) additions += a;
    if (!isNaN(d)) deletions += d;
    files++;
  }
  return { files, additions, deletions };
}

const MAX_DIFF_ARTIFACT_BYTES = 50 * 1024 * 1024;
const REVIEW_INPUT_CAPTURE_TIMEOUT_MS = 8_000;
const REVIEW_INPUT_CAPTURE_TIMEOUT_MIN_MS = 1_000;
const REVIEW_INPUT_CAPTURE_TIMEOUT_MAX_MS = 60_000;

export function resolveReviewInputCaptureTimeoutMs(
  projectJson: RawProjectJson | null | undefined,
): number {
  const raw = projectJson
    ? getProjectFieldRaw(projectJson, 'diff_analysis.review_input_timeout_ms')
    : undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return REVIEW_INPUT_CAPTURE_TIMEOUT_MS;
  if (raw < REVIEW_INPUT_CAPTURE_TIMEOUT_MIN_MS) return REVIEW_INPUT_CAPTURE_TIMEOUT_MIN_MS;
  if (raw > REVIEW_INPUT_CAPTURE_TIMEOUT_MAX_MS) return REVIEW_INPUT_CAPTURE_TIMEOUT_MAX_MS;
  return raw;
}
const GIT_DIFF_NO_QUOTE_PATH = 'git -c core.quotePath=false diff';
// Sentinel exit code returned by `cappedGitDiffCommand`'s bash script when the
// captured diff exceeds MAX_DIFF_ARTIFACT_BYTES. 42 is chosen to avoid clashing
// with git's documented exit codes (0=no-diff, 1=diff, 128=error) and the
// shell's own non-zero range used by `set -e` short-circuits (1, 2, 127, 128+).
const GIT_DIFF_TOO_LARGE_EXIT_CODE = 42;
const DIFF_ARTIFACT_EXEC_MAX_BUFFER = MAX_DIFF_ARTIFACT_BYTES + 5 * 1024 * 1024;
const UNAVAILABLE_DIFF_RECAPTURE_COOLDOWN_MS = 60_000;
const REVIEW_INPUT_CAPTURE_REUSE_WINDOW_MS = 60_000;
const REUSABLE_UNAVAILABLE_DIFF_REASONS = new Set(['diff-artifact-too-large']);
const runArtifactMutationTails = new Map<string, Promise<void>>();

function withRunArtifactMutation<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const previous = runArtifactMutationTails.get(runId) ?? Promise.resolve();
  const current = previous.then(fn);
  const tail = current.then(
    () => undefined,
    (err) => {
      // The caller still receives `current` and its rejection. The queue tail
      // resolves only so later artifact mutations for this run are not wedged
      // behind a completed failure.
      console.warn(
        `[run-engine] artifact mutation for run ${runId} failed before queue advance: ${(err as Error).message.slice(0, 200)}`,
      );
    },
  );
  runArtifactMutationTails.set(runId, tail);
  void tail.finally(() => {
    if (runArtifactMutationTails.get(runId) === tail) runArtifactMutationTails.delete(runId);
  });
  return current;
}

function readProjectSourceDiffFilterConfig(
  projectJson: RawProjectJson,
): ReturnType<typeof readSourceDiffFilterConfig> {
  return readSourceDiffFilterConfig(getProjectFieldRaw(projectJson, 'diff_analysis.source_filter'));
}

function buildProjectSourceDiffFilter(projectJson: RawProjectJson | null): SourceDiffFilter {
  return buildSourceDiffFilter(projectJson ? readProjectSourceDiffFilterConfig(projectJson) : {});
}

function unavailableDiff(
  reason: string,
  kind: FamilyDiffKind,
  error?: string,
  stat: DiffStat = { files: 0, additions: 0, deletions: 0 },
): FamilyDiffProvenance {
  const hasPartialStat = stat.files > 0 || stat.additions > 0 || stat.deletions > 0;
  return {
    source: 'unavailable',
    available: false,
    files: 0,
    additions: 0,
    deletions: 0,
    ...(hasPartialStat ? { partialStat: stat } : {}),
    kind,
    filter: 'source-code',
    capturedAt: new Date().toISOString(),
    missingReason: reason,
    ...(error ? { error } : {}),
  };
}

function describeInvalidPatterns(filter: SourceDiffFilter): {
  configFallbackReason?: string;
  configFallbackError?: string;
} {
  if (filter.invalidPatterns.length === 0) return {};
  return {
    configFallbackReason: 'invalid-glob-pattern',
    configFallbackError: `unsupported glob pattern(s): ${filter.invalidPatterns.slice(0, 5).join(', ')}`,
  };
}

async function resolveDiffCaptureSettings(project: string): Promise<{
  defaultBranch: string;
  sourceFilter: SourceDiffFilter;
  configSource: 'project' | 'gateway-default';
  configFallbackReason?: string;
  configFallbackError?: string;
}> {
  try {
    const pv = await loadProjectVars(project);
    const sourceFilter = buildProjectSourceDiffFilter(pv.projectJson);
    return {
      defaultBranch: getProjectField(pv.projectJson, 'default_branch') || DEFAULT_BRANCH,
      sourceFilter,
      configSource: 'project',
      ...describeInvalidPatterns(sourceFilter),
    };
  } catch (err) {
    // Project configuration is optional for legacy/manual projects; preserving
    // the existing gateway default keeps diff capture explicit without making
    // missing project metadata block run completion.
    console.warn(
      `[run-engine] diff base branch fallback for project ${project}: ${(err as Error).message.slice(0, 200)}`,
    );
    return {
      defaultBranch: DEFAULT_BRANCH,
      sourceFilter: buildProjectSourceDiffFilter(null),
      configSource: 'gateway-default',
      configFallbackReason: 'project-config-unavailable',
      configFallbackError: (err as Error).message,
    };
  }
}

async function resolveProjectSourceDiffFilter(project: string): Promise<{
  sourceFilter: SourceDiffFilter;
  configSource: 'project' | 'gateway-default';
  configFallbackReason?: string;
  configFallbackError?: string;
}> {
  try {
    const sourceFilter = buildProjectSourceDiffFilter((await loadProjectVars(project)).projectJson);
    return { sourceFilter, configSource: 'project', ...describeInvalidPatterns(sourceFilter) };
  } catch (err) {
    // Review-input capture should stay best-effort for legacy/manual projects;
    // keep explicit evidence by falling back to the gateway default filter.
    console.warn(
      `[run-engine] source diff filter fallback for project ${project}: ${(err as Error).message.slice(0, 200)}`,
    );
    return {
      sourceFilter: buildProjectSourceDiffFilter(null),
      configSource: 'gateway-default',
      configFallbackReason: 'project-config-unavailable',
      configFallbackError: (err as Error).message,
    };
  }
}

interface ExistingRunDiffArtifactState {
  provenance: FamilyDiffProvenance;
  reuse: boolean;
}

function shouldReuseUnavailableDiffArtifact(
  provenance: FamilyDiffProvenance,
  nowMs = Date.now(),
): boolean {
  if (provenance.available) return true;
  if (!provenance.missingReason || !REUSABLE_UNAVAILABLE_DIFF_REASONS.has(provenance.missingReason))
    return false;
  if (!provenance.capturedAt) return false;
  const capturedAtMs = Date.parse(provenance.capturedAt);
  if (!Number.isFinite(capturedAtMs)) return false;
  // Clock skew (NTP step backwards) can make capturedAt land in the future;
  // treat that as no cooldown rather than reusing forever.
  if (capturedAtMs > nowMs) return false;
  return nowMs - capturedAtMs < UNAVAILABLE_DIFF_RECAPTURE_COOLDOWN_MS;
}

async function readDiffStatArtifactState(
  taskFile: string | null | undefined,
  statBasename: string,
  expectedKind?: FamilyDiffKind,
): Promise<ExistingRunDiffArtifactState | null> {
  if (!taskFile) return null;
  const diffStatPath = path.join(path.dirname(taskFile), 'artifacts', `${statBasename}-stat.json`);
  if (!existsSync(diffStatPath)) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(diffStatPath, 'utf-8'));
    if (isFamilyDiffProvenance(parsed)) {
      if (expectedKind && parsed.kind !== expectedKind) {
        if (shouldReuseUnavailableDiffArtifact(parsed)) {
          return {
            provenance: unavailableDiff(
              'diff-kind-mismatch-cooldown',
              expectedKind,
              `recent ${parsed.kind} unavailable diff capture still cooling down`,
              parsed.partialStat,
            ),
            reuse: true,
          };
        }
        console.warn(
          `[run-engine] ignoring ${parsed.kind} diff artifact provenance at ${diffStatPath}; expected ${expectedKind}`,
        );
        return null;
      }
      const reuse = shouldReuseUnavailableDiffArtifact(parsed);
      if (!reuse) {
        console.warn(
          `[run-engine] recapturing unavailable diff artifact provenance at ${diffStatPath}: ${parsed.missingReason ?? 'unavailable'}`,
        );
      }
      return { provenance: parsed, reuse };
    }
    console.warn(`[run-engine] ignoring malformed diff artifact provenance at ${diffStatPath}`);
    return null;
  } catch (err) {
    // Malformed/stale local artifact metadata is recoverable: recapture from
    // the slot rather than letting one bad JSON file block run completion.
    console.warn(
      `[run-engine] failed to read existing diff artifact provenance at ${diffStatPath}: ${(err as Error).message.slice(0, 200)}`,
    );
    return null;
  }
}

async function readRunDiffArtifactState(
  taskFile: string | null | undefined,
  expectedKind?: FamilyDiffKind,
): Promise<ExistingRunDiffArtifactState | null> {
  return readDiffStatArtifactState(taskFile, 'diff', expectedKind);
}

async function readIterationDiffArtifactState(
  taskFile: string | null | undefined,
): Promise<ExistingRunDiffArtifactState | null> {
  return readDiffStatArtifactState(taskFile, 'iteration-diff', 'iteration');
}

export async function readExistingRunDiffArtifacts(
  taskFile: string | null | undefined,
): Promise<FamilyDiffProvenance | null> {
  const state = await readRunDiffArtifactState(taskFile);
  return state?.reuse ? state.provenance : null;
}

export function quotedPathspecArgs(pathspecs: readonly string[]): string {
  // Pathspecs ride as positional argv after `--`; `git diff` does not accept
  // `--pathspec-from-file`. source-diff-filter caps keep argv under ARG_MAX.
  return pathspecs.map((spec) => shellQuote(spec)).join(' ');
}

export function cappedGitDiffCommand(range: string, pathspecs: readonly string[]): string {
  const pathspecArgs = pathspecs.length > 0 ? `-- ${quotedPathspecArgs(pathspecs)}` : '';
  const script = [
    'set -euo pipefail',
    'export LC_ALL=C',
    'tmp=$(mktemp "${TMPDIR:-/tmp}/farmslot-diff.XXXXXX")',
    'trap \'rm -f "$tmp"\' EXIT',
    `${GIT_DIFF_NO_QUOTE_PATH} ${range} ${pathspecArgs} > "$tmp"`,
    'bytes=$(stat -f%z "$tmp" 2>/dev/null || stat -c%s "$tmp")',
    `if [ "$bytes" -gt ${MAX_DIFF_ARTIFACT_BYTES} ]; then printf 'farmslot-diff-bytes=%s\\n' "$bytes" >&2; exit ${GIT_DIFF_TOO_LARGE_EXIT_CODE}; fi`,
    'cat "$tmp"',
  ].join('\n');
  return `bash -c ${shellQuote(script)}`;
}

function gitPathspecClause(pathspecs: readonly string[]): string {
  return pathspecs.length > 0 ? `-- ${quotedPathspecArgs(pathspecs)}` : '';
}

export function runSourceDiffNumstatCommand(
  trackedDiffBase: string,
  pathspecs: readonly string[],
): string {
  const pathspecClause = gitPathspecClause(pathspecs);
  const script = [
    'set -euo pipefail',
    'export LC_ALL=C',
    `tracked_base=${shellQuote(trackedDiffBase)}`,
    `${GIT_DIFF_NO_QUOTE_PATH} --numstat "$tracked_base" ${pathspecClause}`,
    'untracked=$(mktemp "${TMPDIR:-/tmp}/farmslot-untracked.XXXXXX")',
    'trap \'rm -f "$untracked"\' EXIT',
    `git -c core.quotePath=false ls-files --others --exclude-standard -z ${pathspecClause} > "$untracked"`,
    "while IFS= read -r -d '' file; do",
    '  [ -f "$file" ] || continue',
    '  lines=$(wc -l < "$file" | tr -d \'[:space:]\')',
    '  printf \'%s\\t0\\t%s\\n\' "${lines:-0}" "$file"',
    'done < "$untracked"',
  ].join('\n');
  return `bash -c ${shellQuote(script)}`;
}

/**
 * Emit NUL-delimited blob-SHA/path pairs for every untracked file.
 *
 * A normal `git diff --no-index /dev/null <file>` has no output for an empty
 * file. Review snapshots therefore need this explicit manifest so creating,
 * removing, or renaming an empty untracked file changes the reviewed identity.
 */
export function runSourceDiffUntrackedManifestCommand(pathspecs: readonly string[]): string {
  const pathspecClause = gitPathspecClause(pathspecs);
  const script = [
    'set -euo pipefail',
    'export LC_ALL=C',
    'untracked=$(mktemp "${TMPDIR:-/tmp}/farmslot-untracked.XXXXXX")',
    'trap \'rm -f "$untracked"\' EXIT',
    `git -c core.quotePath=false ls-files --others --exclude-standard -z ${pathspecClause} > "$untracked"`,
    "while IFS= read -r -d '' file; do",
    '  [ -f "$file" ] || continue',
    '  blob=$(git hash-object -- "$file")',
    '  printf \'%s\\0%s\\0\' "$blob" "$file"',
    'done < "$untracked"',
  ].join('\n');
  return `bash -c ${shellQuote(script)}`;
}

export function cappedRunSourceDiffCommand(
  trackedDiffBase: string,
  pathspecs: readonly string[],
): string {
  const pathspecClause = gitPathspecClause(pathspecs);
  const script = [
    'set -euo pipefail',
    'export LC_ALL=C',
    'tmp=$(mktemp "${TMPDIR:-/tmp}/farmslot-diff.XXXXXX")',
    'untracked=$(mktemp "${TMPDIR:-/tmp}/farmslot-untracked.XXXXXX")',
    'trap \'rm -f "$tmp" "$untracked"\' EXIT',
    `tracked_base=${shellQuote(trackedDiffBase)}`,
    `git -c core.quotePath=false ls-files --others --exclude-standard -z ${pathspecClause} > "$untracked"`,
    '{',
    `  ${GIT_DIFF_NO_QUOTE_PATH} "$tracked_base" ${pathspecClause}`,
    "  while IFS= read -r -d '' file; do",
    '    [ -f "$file" ] || continue',
    '    set +e',
    '    git -c core.quotePath=false diff --no-index -- /dev/null "$file"',
    '    code=$?',
    '    set -e',
    '    if [ "$code" -ne 0 ] && [ "$code" -ne 1 ]; then exit "$code"; fi',
    '  done < "$untracked"',
    '} > "$tmp"',
    'bytes=$(stat -f%z "$tmp" 2>/dev/null || stat -c%s "$tmp")',
    `if [ "$bytes" -gt ${MAX_DIFF_ARTIFACT_BYTES} ]; then printf 'farmslot-diff-bytes=%s\\n' "$bytes" >&2; exit ${GIT_DIFF_TOO_LARGE_EXIT_CODE}; fi`,
    'cat "$tmp"',
  ].join('\n');
  return `bash -c ${shellQuote(script)}`;
}

export function contributionDiffBaseSpec(
  run: Pick<Run, 'startRef'>,
  defaultBranch: string,
): { baseRef: string; commitish: string } {
  const requested = run.startRef?.requestedRef?.trim();
  if (!requested) {
    const remote = `origin/${defaultBranch}`;
    return { baseRef: remote, commitish: remote };
  }
  return {
    baseRef: `startRef:${requested}`,
    commitish: run.startRef?.resolvedSha?.trim() || requested,
  };
}

export async function captureWorktreeHeadSha(
  slotId: string | null | undefined,
): Promise<string | null> {
  if (!slotId) return null;
  try {
    const vars = await loadSlotVars(slotId);
    const head = await execOnSlot(vars, 'git rev-parse HEAD', { timeout: 10000 });
    return head.exitCode === 0 ? head.stdout.trim() : null;
  } catch (err) {
    console.warn(
      `[run-engine] worktree head capture failed for slot ${slotId}: ${(err as Error).message.slice(0, 200)}`,
    );
    return null;
  }
}

type CaptureRunDiffSnapshotOptions = {
  baseSpec?: { baseRef: string; commitish: string };
  /** When true (default), diff from merge-base(base, HEAD); when false, diff from base..HEAD. */
  useMergeBase?: boolean;
  kind?: FamilyDiffKind;
  diffArtifactPath?: string;
};

async function ensureRemoteDefaultBranchFetched(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  defaultBranch: string,
  commitish: string,
): Promise<string | null> {
  const remoteRef = `origin/${defaultBranch}`;
  if (commitish !== remoteRef) return null;
  const fetchResult = await execOnSlot(
    vars,
    `git fetch origin ${shellQuote(remoteBranchRefspec(defaultBranch))}`,
    { timeout: 15000 },
  );
  if (fetchResult.exitCode === 0) return null;
  return (
    fetchResult.stderr.trim() ||
    fetchResult.stdout.trim() ||
    `git fetch origin ${defaultBranch} failed on ${vars.slotId}`
  );
}

export async function captureRunDiffSnapshot(
  run: Run,
  options: CaptureRunDiffSnapshotOptions = {},
): Promise<FamilyDiffProvenance & { diffText?: string }> {
  const diffKind = options.kind ?? diffKindForFlow(run.flowType);
  if (!run.slotId) return unavailableDiff('missing-slot', diffKind);
  if (!run.branch) return unavailableDiff('missing-branch', diffKind);
  const runBranch = run.branch;

  let vars: Awaited<ReturnType<typeof loadSlotVars>>;
  try {
    vars = await loadSlotVars(run.slotId);
  } catch (err) {
    return unavailableDiff('slot-vars-unavailable', diffKind, (err as Error).message);
  }

  const { defaultBranch, sourceFilter, configSource, configFallbackReason, configFallbackError } =
    await resolveDiffCaptureSettings(run.project);
  const baseSpec = options.baseSpec ?? contributionDiffBaseSpec(run, defaultBranch);
  const useMergeBase = options.useMergeBase ?? true;
  const diffArtifactPath = options.diffArtifactPath ?? 'artifacts/diff.txt';
  const sourcePathspecList = sourceCodeGitPathspecs(sourceFilter);
  try {
    const fetchError = await ensureRemoteDefaultBranchFetched(
      vars,
      defaultBranch,
      baseSpec.commitish,
    );
    if (fetchError) {
      return unavailableDiff('base-ref-unavailable', diffKind, fetchError);
    }
    const headRefResult = await execOnSlot(vars, 'git rev-parse HEAD', { timeout: 10000 });
    if (headRefResult.exitCode !== 0) {
      return unavailableDiff(
        'head-ref-unavailable',
        diffKind,
        headRefResult.stderr.trim() || headRefResult.stdout.trim(),
      );
    }
    const baseRefResult = await execOnSlot(
      vars,
      `git rev-parse --verify ${shellQuote(`${baseSpec.commitish}^{commit}`)}`,
      { timeout: 10000 },
    );
    if (baseRefResult.exitCode !== 0) {
      return unavailableDiff(
        'base-ref-unavailable',
        diffKind,
        baseRefResult.stderr.trim() || baseRefResult.stdout.trim(),
      );
    }
    const baseSha = baseRefResult.stdout.trim();
    const headSha = headRefResult.stdout.trim();
    let trackedDiffBase = baseSha;
    if (useMergeBase) {
      const mergeBaseResult = await execOnSlot(vars, `git merge-base ${shellQuote(baseSha)} HEAD`, {
        timeout: 10000,
      });
      if (mergeBaseResult.exitCode !== 0) {
        return unavailableDiff(
          'base-ref-unavailable',
          diffKind,
          mergeBaseResult.stderr.trim() || mergeBaseResult.stdout.trim(),
        );
      }
      trackedDiffBase = mergeBaseResult.stdout.trim();
    }
    const noSourceDiffSnapshot = (): FamilyDiffProvenance & { diffText: string } => ({
      source: 'artifact',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: diffKind,
      filter: 'source-code',
      baseRef: baseSpec.baseRef,
      baseSha,
      headRef: runBranch,
      headSha,
      capturedAt: new Date().toISOString(),
      configSource,
      ...(configFallbackReason ? { configFallbackReason } : {}),
      ...(configFallbackError ? { configFallbackError } : {}),
      missingReason: 'no-source-diff',
      diffText: '',
    });
    if (sourcePathspecList.length === 0) {
      return noSourceDiffSnapshot();
    }
    const numstatResult = await execOnSlot(
      vars,
      runSourceDiffNumstatCommand(trackedDiffBase, sourcePathspecList),
      { timeout: 10000 },
    );
    if (numstatResult.exitCode !== 0) {
      return unavailableDiff(
        'git-numstat-failed',
        diffKind,
        numstatResult.stderr.trim() || numstatResult.stdout.trim(),
      );
    }
    const stat = parseGitNumstat(numstatResult.stdout, { sourceOnly: true, sourceFilter });
    if (stat.files === 0) {
      return noSourceDiffSnapshot();
    }
    const diffResult = await execOnSlot(
      vars,
      cappedRunSourceDiffCommand(trackedDiffBase, sourcePathspecList),
      {
        timeout: 30000,
        maxBuffer: DIFF_ARTIFACT_EXEC_MAX_BUFFER,
      },
    );
    const diffText = diffResult.stdout;
    if (diffResult.exitCode === GIT_DIFF_TOO_LARGE_EXIT_CODE) {
      const diffBytes = parseDiffTooLargeBytes(diffResult.stderr);
      return unavailableDiff(
        'diff-artifact-too-large',
        diffKind,
        diffBytes == null
          ? `diff exceeded limit of ${MAX_DIFF_ARTIFACT_BYTES} bytes`
          : `diff is ${diffBytes} bytes; limit is ${MAX_DIFF_ARTIFACT_BYTES} bytes`,
        stat,
      );
    }
    if (diffResult.exitCode !== 0 && /maxBuffer exceeded/i.test(diffResult.stderr)) {
      return unavailableDiff('diff-artifact-too-large', diffKind, diffResult.stderr.trim(), stat);
    }
    if (diffResult.exitCode !== 0) {
      return unavailableDiff(
        'git-diff-failed',
        diffKind,
        diffResult.stderr.trim() || diffResult.stdout.trim(),
        stat,
      );
    }
    return {
      source: 'artifact',
      available: true,
      ...stat,
      kind: diffKind,
      filter: 'source-code',
      artifactPath: diffArtifactPath,
      baseRef: baseSpec.baseRef,
      baseSha,
      headRef: runBranch,
      headSha,
      capturedAt: new Date().toISOString(),
      configSource,
      ...(configFallbackReason ? { configFallbackReason } : {}),
      ...(configFallbackError ? { configFallbackError } : {}),
      diffText,
    };
  } catch (err) {
    // Slot exec may throw on remote disconnect or nodeExec rejection mid-call;
    // surface as unavailable so COMPLETE stays durable. `slot-exec-error` is
    // excluded from REUSABLE_UNAVAILABLE_DIFF_REASONS so transient failures
    // recapture immediately instead of sticking through cooldown.
    console.warn(
      `[run-engine] diff capture aborted on slot exec failure for run ${run.id} slot ${run.slotId}: ${(err as Error).message.slice(0, 200)}`,
    );
    return unavailableDiff('slot-exec-error', diffKind, (err as Error).message);
  }
}

export async function captureRunDiffArtifacts(
  run: Run,
  options: { forceRecapture?: boolean } = {},
): Promise<FamilyDiffProvenance> {
  return withRunArtifactMutation(run.id, () => captureRunDiffArtifactsUnlocked(run, options));
}

async function writeDiffArtifactPair(
  artifactsDir: string,
  basename: string,
  snapshot: FamilyDiffProvenance & { diffText?: string },
): Promise<void> {
  const { diffText, ...provenance } = snapshot;
  const diffTextPath = path.join(artifactsDir, `${basename}.txt`);
  const diffStatPath = path.join(artifactsDir, `${basename}-stat.json`);
  if (snapshot.source === 'artifact' && snapshot.available) {
    await atomicWriteTextFile(diffTextPath, diffText ?? '');
    await atomicWriteTextFile(diffStatPath, JSON.stringify(provenance));
  } else {
    await atomicWriteTextFile(diffStatPath, JSON.stringify(provenance));
    if (basename === 'diff') {
      await preservePreviousDiffText(diffTextPath, artifactsDir, snapshot.capturedAt);
    }
    await rm(diffTextPath, { force: true });
  }
}

async function captureRunDiffArtifactsUnlocked(
  run: Run,
  options: { forceRecapture?: boolean },
): Promise<FamilyDiffProvenance> {
  const existingState = options.forceRecapture
    ? null
    : await readRunDiffArtifactState(run.taskFile, diffKindForFlow(run.flowType));
  const existingIterationState = await readIterationDiffArtifactState(run.taskFile);
  const snapshot = existingState?.reuse
    ? existingState.provenance
    : await captureRunDiffSnapshot(run);
  const dispatchHead = run.worktreeHeadAtDispatch?.trim();
  let iterationSnapshot: (FamilyDiffProvenance & { diffText?: string }) | null = null;
  if (dispatchHead && !existingIterationState?.reuse) {
    iterationSnapshot = await captureRunDiffSnapshot(run, {
      baseSpec: { baseRef: `dispatchHead:${dispatchHead}`, commitish: dispatchHead },
      useMergeBase: false,
      kind: 'iteration',
      diffArtifactPath: 'artifacts/iteration-diff.txt',
    });
  }
  if (!run.taskFile) return snapshot;
  const taskDir = path.dirname(run.taskFile);
  const artifactsDir = path.join(taskDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  if (!existingState?.reuse) {
    await writeDiffArtifactPair(artifactsDir, 'diff', snapshot);
  }
  if (iterationSnapshot) {
    await writeDiffArtifactPair(artifactsDir, 'iteration-diff', iterationSnapshot);
  }
  if ('diffText' in snapshot) {
    const { diffText: _diffText, ...provenance } = snapshot;
    return provenance;
  }
  return snapshot;
}

const MAX_PREVIOUS_DIFF_BACKUPS = 3;

async function preservePreviousDiffText(
  diffTextPath: string,
  artifactsDir: string,
  capturedAt: string | undefined,
): Promise<void> {
  if (!existsSync(diffTextPath)) return;
  const stamp =
    (capturedAt ?? new Date().toISOString()).replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '') ||
    String(Date.now());
  // UUID suffix avoids existsSync→rename races between concurrent runs that
  // might share the same artifacts dir (recovered-provenance copies, etc.).
  const target = path.join(artifactsDir, `diff.txt.previous.${stamp}.${randomUUID()}`);
  await rename(diffTextPath, target);
  await pruneOldDiffTextBackups(artifactsDir);
}

async function pruneOldDiffTextBackups(artifactsDir: string): Promise<void> {
  // Cap diff.txt.previous.* retention so a project that thrashes between
  // available and unavailable recapture cannot grow the artifacts directory
  // unboundedly. Keep MAX_PREVIOUS_DIFF_BACKUPS most-recent by mtime.
  let names: string[];
  try {
    names = await readdir(artifactsDir);
  } catch (err) {
    // Directory disappearing under us is recoverable: nothing to prune.
    if ((err as { code?: string }).code === 'ENOENT') return;
    console.warn(
      `[run-engine] diff backup prune list failed at ${artifactsDir}: ${(err as Error).message.slice(0, 200)}`,
    );
    return;
  }
  const backups = names.filter((name) => name.startsWith('diff.txt.previous.'));
  if (backups.length <= MAX_PREVIOUS_DIFF_BACKUPS) return;
  const stamped: { name: string; mtimeMs: number }[] = [];
  for (const name of backups) {
    try {
      const s = await fsStat(path.join(artifactsDir, name));
      stamped.push({ name, mtimeMs: s.mtimeMs });
    } catch (err) {
      console.warn(
        `[run-engine] diff backup stat failed at ${path.join(artifactsDir, name)}: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }
  // Secondary sort by name descending so concurrent recaptures landing in the
  // same mtime bucket (HFS+ second-granularity, ext4 coalescing) have a stable
  // tie-break. The UUID suffix only prevents rename collisions; it carries no
  // chronological meaning.
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  const toRemove = stamped.slice(MAX_PREVIOUS_DIFF_BACKUPS);
  for (const entry of toRemove) {
    try {
      await rm(path.join(artifactsDir, entry.name), { force: true });
    } catch (err) {
      console.warn(
        `[run-engine] diff backup prune failed at ${path.join(artifactsDir, entry.name)}: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }
}

function parseRunPrRef(run: Run): { repo: string; prNumber: number } | null {
  const ref = run.ticketOrPr ?? '';
  const match = ref.match(/^([^#]+)#(\d+)$/);
  if (match) {
    const refPrNumber = Number(match[2]);
    const prNumber = run.prNumber != null && run.prNumber > 0 ? run.prNumber : refPrNumber;
    return prNumber > 0 ? { repo: match[1], prNumber } : null;
  }
  if (run.prNumber != null && run.prNumber > 0) {
    const repoMatch = ref.match(/^([^#]+)#/);
    if (repoMatch) return { repo: repoMatch[1], prNumber: run.prNumber };
  }
  return null;
}

async function resolveRunPrRef(run: Run): Promise<{ repo: string; prNumber: number } | null> {
  const parsed = parseRunPrRef(run);
  if (parsed) return parsed;
  // parseRunPrRef can return null while run.prNumber > 0 — e.g., ticketOrPr lacks
  // any '#' suffix so the repo regex never matched. Re-validate prNumber here
  // before falling back to the project-config repo lookup.
  if (run.prNumber == null || run.prNumber <= 0) return null;
  try {
    const pv = await loadProjectVars(run.project);
    const repo = getProjectField(pv.projectJson, 'ci.repo');
    if (repo) return { repo, prNumber: run.prNumber };
    console.warn(
      `[run-engine] cannot resolve review-input repo for ${run.id}: project ${run.project} has no ci.repo`,
    );
    return null;
  } catch (err) {
    // Direct pr-complete dispatches may learn prNumber before a repo-qualified
    // ticketOrPr is available. Falling back to missing-pr-ref keeps capture
    // best-effort while recording explicit unavailable provenance.
    console.warn(
      `[run-engine] cannot resolve review-input repo for ${run.id}: ${(err as Error).message.slice(0, 200)}`,
    );
    return null;
  }
}

function filterSourceDiffFiles(
  files: Awaited<ReturnType<typeof fetchPRDiffFiles>>,
  sourceFilter: SourceDiffFilter,
): Awaited<ReturnType<typeof fetchPRDiffFiles>> {
  return files.filter((file) => isSourceCodePath(file.filename, sourceFilter));
}

function renderPrInputDiff(files: Awaited<ReturnType<typeof fetchPRDiffFiles>>): string {
  // Display-only review input snapshot: the injected status/source-unavailable
  // comments make this useful evidence for agents and operators, not a patch
  // intended for `git apply`.
  const header = '# display-only review snapshot — not a git-applyable patch\n';
  return (
    header +
    files
      .map((file) =>
        [
          `diff --git a/${file.filename} b/${file.filename}`,
          `# status: ${file.status} (+${file.additions} -${file.deletions})`,
          file.patch ?? '# Source patch unavailable from GitHub API',
          '',
        ].join('\n'),
      )
      .join('\n')
  );
}

interface ReviewInputCaptureDeps {
  fetchGitHubPR: (
    prRef: string,
    opts?: { signal?: AbortSignal },
  ) => ReturnType<typeof fetchGitHubPR>;
  fetchPRDiffFiles: (
    repo: string,
    prNumber: number,
    opts?: { signal?: AbortSignal },
  ) => ReturnType<typeof fetchPRDiffFiles>;
}

interface ReviewInputPRMetadata {
  branch: string;
  title: string;
  body: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  number: number;
}

const defaultReviewInputCaptureDeps: ReviewInputCaptureDeps = {
  fetchGitHubPR,
  fetchPRDiffFiles,
};

function unavailableInputDiff(
  reason: string,
  now: string,
  options: {
    repository?: string;
    prNumber?: number;
    baseRef?: string;
    baseSha?: string;
    headRef?: string;
    headSha?: string;
    error?: string;
  } = {},
): FamilyDiffProvenance {
  return {
    source: 'unavailable',
    available: false,
    files: 0,
    additions: 0,
    deletions: 0,
    kind: 'review-input',
    filter: 'source-code',
    capturedAt: now,
    missingReason: reason,
    ...(options.repository ? { repository: options.repository } : {}),
    ...(options.prNumber != null ? { prNumber: options.prNumber } : {}),
    ...(options.baseRef ? { baseRef: options.baseRef } : {}),
    ...(options.baseSha ? { baseSha: options.baseSha } : {}),
    ...(options.headRef ? { headRef: options.headRef } : {}),
    ...(options.headSha ? { headSha: options.headSha } : {}),
    ...(options.error ? { error: options.error } : {}),
  };
}

async function readExistingAvailableReviewInputArtifacts(
  inputsDir: string,
): Promise<ArtifactRef[] | null> {
  const diffStatPath = path.join(inputsDir, 'diff-stat.json');
  if (!existsSync(diffStatPath)) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(diffStatPath, 'utf-8'));
    if (!isFamilyDiffProvenance(parsed) || parsed.kind !== 'review-input' || !parsed.available)
      return null;
    return [
      { path: 'inputs/commit.json', purpose: 'input-commit' },
      ...(existsSync(path.join(inputsDir, 'diff.txt'))
        ? [{ path: 'inputs/diff.txt', purpose: 'input-diff' }]
        : []),
      { path: 'inputs/diff-stat.json', purpose: 'input-diff-stat' },
    ];
  } catch (err) {
    // Malformed cached provenance is not trustworthy; recapture below writes a
    // fresh explicit receipt instead of letting a bad cache block review input.
    console.warn(
      `[run-engine] ignoring malformed existing review-input provenance at ${diffStatPath}: ${(err as Error).message.slice(0, 200)}`,
    );
    return null;
  }
}

async function readFreshReviewInputArtifacts(
  inputsDir: string,
  prRef: { repo: string; prNumber: number },
  nowMs = Date.now(),
): Promise<ArtifactRef[] | null> {
  const diffStatPath = path.join(inputsDir, 'diff-stat.json');
  if (!existsSync(diffStatPath)) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(diffStatPath, 'utf-8'));
    if (!isFamilyDiffProvenance(parsed) || parsed.kind !== 'review-input') return null;
    if (parsed.repository && parsed.repository !== prRef.repo) return null;
    if (parsed.prNumber != null && parsed.prNumber !== prRef.prNumber) return null;
    if (!parsed.capturedAt) return null;
    const capturedAtMs = Date.parse(parsed.capturedAt);
    if (!Number.isFinite(capturedAtMs) || capturedAtMs > nowMs) return null;
    if (nowMs - capturedAtMs >= REVIEW_INPUT_CAPTURE_REUSE_WINDOW_MS) return null;
    const reusable =
      parsed.source === 'artifact' &&
      (parsed.available || parsed.missingReason === 'no-source-diff');
    if (!reusable) return null;
    return [
      { path: 'inputs/commit.json', purpose: 'input-commit' },
      ...(parsed.available && existsSync(path.join(inputsDir, 'diff.txt'))
        ? [{ path: 'inputs/diff.txt', purpose: 'input-diff' }]
        : []),
      { path: 'inputs/diff-stat.json', purpose: 'input-diff-stat' },
    ];
  } catch (err) {
    console.warn(
      `[run-engine] ignoring malformed recent review-input provenance at ${diffStatPath}: ${(err as Error).message.slice(0, 200)}`,
    );
    return null;
  }
}

export async function readReviewInputSnapshot(
  taskFile: string | null | undefined,
): Promise<{ snapshot?: ReviewDiffSnapshot; artifactPaths: string[] }> {
  if (!taskFile) return { artifactPaths: [] };
  const inputsDir = path.join(path.dirname(taskFile), 'inputs');
  const commitPath = path.join(inputsDir, 'commit.json');
  const statPath = path.join(inputsDir, 'diff-stat.json');
  const diffPath = path.join(inputsDir, 'diff.txt');
  const artifactPaths: string[] = [];
  try {
    const commitRaw = existsSync(commitPath) ? await readFile(commitPath, 'utf-8') : '';
    const statRaw = existsSync(statPath) ? await readFile(statPath, 'utf-8') : '';
    const commit = commitRaw ? (JSON.parse(commitRaw) as FamilyInputCommitMetadata) : null;
    const stat = statRaw ? (JSON.parse(statRaw) as FamilyDiffProvenance) : null;
    if (existsSync(commitPath)) artifactPaths.push('inputs/commit.json');
    if (existsSync(diffPath)) artifactPaths.push('inputs/diff.txt');
    if (existsSync(statPath)) artifactPaths.push('inputs/diff-stat.json');
    if (!commit && !stat) return { artifactPaths };
    const diffText = existsSync(diffPath) ? await readFile(diffPath, 'utf-8') : '';
    const source =
      commit?.source === 'github-pr' || stat?.source === 'artifact'
        ? 'github-pr'
        : commit?.source === 'local-git'
          ? 'local-git'
          : 'unavailable';
    return {
      artifactPaths,
      snapshot: {
        source,
        baseRef: commit?.baseRef ?? stat?.baseRef ?? null,
        baseSha: commit?.baseSha ?? stat?.baseSha ?? null,
        headRef: commit?.headRef ?? stat?.headRef ?? null,
        headSha: commit?.headSha ?? stat?.headSha ?? null,
        diffPath: existsSync(diffPath) ? 'inputs/diff.txt' : null,
        diffHash: existsSync(diffPath) ? sha256Text(diffText) : null,
        diffStat: stat
          ? { files: stat.files, additions: stat.additions, deletions: stat.deletions }
          : undefined,
        capturedAt: commit?.capturedAt ?? stat?.capturedAt ?? new Date().toISOString(),
        missingReason: commit?.missingReason ?? stat?.missingReason,
        error: commit?.error ?? stat?.error,
      },
    };
  } catch (err) {
    return {
      artifactPaths,
      snapshot: {
        source: 'unavailable',
        capturedAt: new Date().toISOString(),
        missingReason: 'review-input-snapshot-read-failed',
        error: (err as Error).message.slice(0, 500),
      },
    };
  }
}

export async function captureReviewInputArtifactsForRun(
  run: Run,
  deps: ReviewInputCaptureDeps = defaultReviewInputCaptureDeps,
): Promise<ArtifactRef[]> {
  return withRunArtifactMutation(run.id, () =>
    captureReviewInputArtifactsForRunUnlocked(run, deps),
  );
}

async function captureReviewInputArtifactsForRunUnlocked(
  run: Run,
  deps: ReviewInputCaptureDeps,
): Promise<ArtifactRef[]> {
  if (!run.taskFile || !['review-pr', 'pr-complete'].includes(run.flowType)) return [];
  const taskDir = path.dirname(run.taskFile);
  const inputsDir = path.join(taskDir, 'inputs');
  await mkdir(inputsDir, { recursive: true });
  const now = new Date().toISOString();
  const prRef = await resolveRunPrRef(run);
  if (!prRef) {
    const existing = await readExistingAvailableReviewInputArtifacts(inputsDir);
    if (existing) return existing;
    const unavailable: FamilyInputCommitMetadata = {
      capturedAt: now,
      source: 'unavailable',
      missingReason: 'missing-pr-ref',
    };
    await atomicWriteTextFile(path.join(inputsDir, 'commit.json'), JSON.stringify(unavailable));
    await rm(path.join(inputsDir, 'diff.txt'), { force: true });
    await atomicWriteTextFile(
      path.join(inputsDir, 'diff-stat.json'),
      JSON.stringify(unavailableInputDiff('missing-pr-ref', now)),
    );
    return [
      { path: 'inputs/commit.json', purpose: 'input-commit' },
      { path: 'inputs/diff-stat.json', purpose: 'input-diff-stat' },
    ];
  }
  const freshExisting = await readFreshReviewInputArtifacts(inputsDir, prRef);
  if (freshExisting) return freshExisting;
  const captureState: { fetchedPrMetadata?: ReviewInputPRMetadata } = {};
  try {
    const sourceFilterSettings = await resolveProjectSourceDiffFilter(run.project);
    const projectJsonForTimeout =
      (await loadProjectVarsOrNull(run.project, 'run recovery', run.id))?.projectJson ?? null;
    const captureTimeoutMs = resolveReviewInputCaptureTimeoutMs(projectJsonForTimeout);
    const controller = new AbortController();
    const { pr, files } = await withTimeout(
      (async () => {
        const fetchedPr = await deps.fetchGitHubPR(`${prRef.repo}#${prRef.prNumber}`, {
          signal: controller.signal,
        });
        captureState.fetchedPrMetadata = fetchedPr;
        const fetchedFiles = await deps.fetchPRDiffFiles(prRef.repo, prRef.prNumber, {
          signal: controller.signal,
        });
        return { pr: fetchedPr, files: fetchedFiles };
      })(),
      captureTimeoutMs,
      'review input capture',
      { onTimeout: () => controller.abort() },
    );
    const inputCommit: FamilyInputCommitMetadata = {
      repository: prRef.repo,
      prNumber: prRef.prNumber,
      baseRef: pr.baseRef,
      baseSha: pr.baseSha,
      headRef: pr.branch,
      headSha: pr.headSha,
      capturedAt: now,
      source: 'github-pr',
    };
    const sourceFiles = filterSourceDiffFiles(files, sourceFilterSettings.sourceFilter);
    const stat = sourceFiles.reduce(
      (acc, file) => {
        acc.files += 1;
        acc.additions += file.additions;
        acc.deletions += file.deletions;
        return acc;
      },
      { files: 0, additions: 0, deletions: 0 },
    );
    const inputDiff: FamilyDiffProvenance = {
      source: 'artifact',
      available: stat.files > 0,
      ...stat,
      kind: 'review-input',
      filter: 'source-code',
      ...(stat.files > 0 ? { artifactPath: 'inputs/diff.txt' } : {}),
      repository: prRef.repo,
      prNumber: prRef.prNumber,
      baseRef: pr.baseRef,
      baseSha: pr.baseSha,
      headRef: pr.branch,
      headSha: pr.headSha,
      capturedAt: now,
      configSource: sourceFilterSettings.configSource,
      ...(sourceFilterSettings.configFallbackReason
        ? { configFallbackReason: sourceFilterSettings.configFallbackReason }
        : {}),
      ...(sourceFilterSettings.configFallbackError
        ? { configFallbackError: sourceFilterSettings.configFallbackError }
        : {}),
      ...(stat.files === 0 ? { missingReason: 'no-source-diff' } : {}),
    };
    await atomicWriteTextFile(path.join(inputsDir, 'commit.json'), JSON.stringify(inputCommit));
    if (stat.files > 0) {
      await atomicWriteTextFile(path.join(inputsDir, 'diff.txt'), renderPrInputDiff(sourceFiles));
    } else {
      await rm(path.join(inputsDir, 'diff.txt'), { force: true });
    }
    await atomicWriteTextFile(path.join(inputsDir, 'diff-stat.json'), JSON.stringify(inputDiff));
    return [
      { path: 'inputs/commit.json', purpose: 'input-commit' },
      ...(stat.files > 0 ? [{ path: 'inputs/diff.txt', purpose: 'input-diff' }] : []),
      { path: 'inputs/diff-stat.json', purpose: 'input-diff-stat' },
    ];
  } catch (err) {
    const existing = await readExistingAvailableReviewInputArtifacts(inputsDir);
    if (existing) return existing;
    const pr = captureState.fetchedPrMetadata ?? null;
    const missingReason = pr ? 'github-pr-input-partial' : 'github-pr-input-unavailable';
    const unavailable: FamilyInputCommitMetadata = {
      repository: prRef.repo,
      prNumber: prRef.prNumber,
      ...(pr
        ? {
            baseRef: pr.baseRef,
            baseSha: pr.baseSha,
            headRef: pr.branch,
            headSha: pr.headSha,
          }
        : {}),
      capturedAt: now,
      source: 'unavailable',
      missingReason,
      error: (err as Error).message.slice(0, 500),
    };
    await atomicWriteTextFile(path.join(inputsDir, 'commit.json'), JSON.stringify(unavailable));
    await rm(path.join(inputsDir, 'diff.txt'), { force: true });
    await atomicWriteTextFile(
      path.join(inputsDir, 'diff-stat.json'),
      JSON.stringify(
        unavailableInputDiff(missingReason, now, {
          repository: prRef.repo,
          prNumber: prRef.prNumber,
          ...(pr
            ? {
                baseRef: pr.baseRef,
                baseSha: pr.baseSha,
                headRef: pr.branch,
                headSha: pr.headSha,
              }
            : {}),
          error: (err as Error).message.slice(0, 500),
        }),
      ),
    );
    return [
      { path: 'inputs/commit.json', purpose: 'input-commit' },
      { path: 'inputs/diff-stat.json', purpose: 'input-diff-stat' },
    ];
  }
}
