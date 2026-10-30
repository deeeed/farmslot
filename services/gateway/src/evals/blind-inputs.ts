import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  type EvalBlindTrial,
  type EvalComparisonEligibility,
  type ResultPackageManifest,
} from '@farmslot/protocol';
import { parseUnifiedDiff } from '@farmslot/protocol/client-cache';

import { shSingleQuote } from '../../../../scripts/lib/shell-quote.mjs';
import { isSourceCodePath, type SourceDiffFilter } from '../core/source-diff-filter.js';

const auditScript = readFileSync(new URL('./blind-inputs.py', import.meta.url), 'utf8');
export const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function stablePatchId(diff: string): Promise<string> {
  if (!diff.trim()) return Promise.resolve('');
  if (!diff.startsWith('diff --git '))
    throw new Error('A native contribution diff is required for comparison.');
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['patch-id', '--stable'], { signal: AbortSignal.timeout(30_000) });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.resume();
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.once('close', (code) => {
      const lines = output.trim().split('\n');
      const id = lines[0]?.split(/\s+/)[0] ?? '';
      if (code !== 0 || lines.length !== 1 || !FULL_COMMIT.test(id))
        reject(new Error('Could not compute a single stable contribution patch identity.'));
      else resolve(id);
    });
    child.stdin.end(diff);
  });
}

/** Apply the contribution filter to native reference sections without rewriting hunks. */
export function sourceComparisonDiff(diff: string, filter: SourceDiffFilter): string {
  if (!diff.startsWith('diff --git '))
    throw new Error('A native reference contribution diff is required for comparison.');
  return diff
    .split(/(?=^diff --git )/m)
    .filter((section) => {
      const files = parseUnifiedDiff(section);
      const file = files[0];
      if (files.length !== 1 || !file || file.malformed || (!file.oldPath && !file.newPath))
        throw new Error('The reference contribution diff cannot be parsed.');
      return [file.oldPath, file.newPath].some((name) => name && isSourceCodePath(name, filter));
    })
    .join('');
}

export function referenceCommits(reference: ResultPackageManifest): string[] {
  const source = reference.source;
  const candidates = [
    reference.diff.headSha,
    reference.head?.headSha,
    ...(source.kind === 'merged-pr' ? [source.headSha, source.mergeCommitSha] : []),
    ...(source.kind === 'git-ref' ? [source.headSha] : []),
  ];
  return [
    ...new Set(
      candidates.filter(
        (value): value is string => typeof value === 'string' && FULL_COMMIT.test(value),
      ),
    ),
  ];
}

export function referenceInputMarkers(
  reference: ResultPackageManifest,
  manifestPath: string,
  packagePath: string,
): string[] {
  const commits = referenceCommits(reference);
  const source = reference.source;
  return [
    ...new Set(
      [
        manifestPath,
        packagePath,
        reference.packageId,
        reference.packageHash,
        ...commits.flatMap((sha) => [sha, sha.slice(0, 7)]),
        ...(source.kind === 'merged-pr'
          ? [
              source.url ?? '',
              `${source.repo}#${source.prNumber}`,
              `#${source.prNumber}`,
              `/pull/${source.prNumber}`,
            ]
          : []),
        ...(source.kind === 'prior-run' ? [source.runId] : []),
      ].filter(Boolean),
    ),
  ];
}

export function assertBlindProblem(
  problem: string | undefined,
  markers: readonly string[],
): string {
  const text = problem?.trim();
  if (!text)
    throw new Error(
      'A blind eval requires explicit ticket/problem text. Set the experiment objective; PR descriptions are not used.',
    );
  if (
    /^diff --git |^@@ /m.test(text) ||
    markers.some((marker) => text.toLowerCase().includes(marker.toLowerCase()))
  )
    throw new Error(
      'The problem statement contains reference material. Supply the ticket problem text only.',
    );
  return text;
}

export function buildBlindInputAuditCommand(root: string, markers: readonly string[]): string {
  return `python3 - ${shSingleQuote(JSON.stringify({ root, markers }))} <<'FARMSLOT_BLIND_INPUTS_PY'\n${auditScript}\nFARMSLOT_BLIND_INPUTS_PY`;
}

export function blindTrialEligibility(
  blind: EvalBlindTrial | undefined,
): EvalComparisonEligibility {
  if (!blind?.isolation?.verifiedAt || !blind.firstOutput)
    return { status: 'invalid', reason: 'Blind trial provenance or first output is missing.' };
  if (blind.invalidReason) return { status: 'invalid', reason: blind.invalidReason };
  const identity = {
    firstOutputHeadSha: blind.firstOutput.headSha,
    candidatePatchId: blind.firstOutput.patchId,
    referencePatchId: blind.referencePatchId,
  };
  return blind.firstOutput.patchId && blind.firstOutput.patchId === blind.referencePatchId
    ? { ...identity, status: 'contaminated', reason: 'First output matches the reference patch.' }
    : { ...identity, status: 'eligible' };
}
