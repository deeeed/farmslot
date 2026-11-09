import { createHash } from 'node:crypto';

import type { ReadyGatePrPackage, Run } from '@farmslot/protocol';

import type { ghRequest } from '../../integrations/github-client.js';
import { readVerifiedSnapshotDiff } from '../../run-engine/review-diff-refresh.js';

/** Beyond this many files the comparison refuses rather than hashing an unbounded diff. */
const MAX_COMPARED_FILES = 300;

type PublishGate = NonNullable<NonNullable<Run['engineState']>['publishGate']>;

/** The PR side of the comparison, pinned to the SHAs read with the PR facts. */
export interface PublishedRange {
  repository: string;
  baseSha: string;
  headSha: string;
}

export type PublishedContentComparison =
  | { differingFiles: string[] }
  | { unavailable: string; differingFiles?: string[] };

/** `a -> b` for a rename or copy, otherwise the path the section changes. */
function sectionKey(section: string): string {
  const from = /^rename from (.+)$/m.exec(section)?.[1] ?? /^copy from (.+)$/m.exec(section)?.[1];
  const to = /^rename to (.+)$/m.exec(section)?.[1] ?? /^copy to (.+)$/m.exec(section)?.[1];
  if (from && to) return `${from} -> ${to}`;
  const header = /^diff --git a\/(.+) b\/(.+)$/m.exec(section);
  if (!header) throw new Error('Unrecognised diff section header');
  return header[2]!;
}

function splitDiff(diff: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const section of diff.split(/(?=^diff --git )/m)) {
    if (!section.startsWith('diff --git ')) continue;
    const key = sectionKey(section);
    if (files.has(key)) throw new Error(`The diff names ${key} twice`);
    files.set(key, section.endsWith('\n') ? section : `${section}\n`);
  }
  return files;
}

/** Every byte of the change counts, whitespace and file modes included. Only display data is dropped:
 * a text section's `index` line (abbreviated blob ids) and the hunk header's line numbers and function
 * context. A binary section keeps its index line, whose blob ids are its content. */
function sectionIdentity(section: string): string {
  const binary = /^(GIT binary patch|Binary files .* differ)$/m.test(section);
  const canonical = (binary ? section : section.replace(/^index [^\n]*\n/gm, '')).replace(
    /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@[^\n]*$/gm,
    '@@',
  );
  return createHash('sha256').update(canonical).digest('hex');
}

/** Files whose change differs between two unified diffs, sorted; empty when they carry the same patch. */
export function differingPatchFiles(reviewed: string, published: string): string[] {
  const left = splitDiff(reviewed);
  const right = splitDiff(published);
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  if (keys.length > MAX_COMPARED_FILES)
    throw new Error(`the patches touch ${keys.length} files (limit ${MAX_COMPARED_FILES})`);
  return keys.filter((key) => {
    const a = left.get(key);
    const b = right.get(key);
    return !a || !b || sectionIdentity(a) !== sectionIdentity(b);
  });
}

/** A content match needs a reviewed patch: the gate's current package, whose snapshot a passing review
 * covered exactly (same head, same diff hash). A captured package alone certifies nothing. */
function reviewedSnapshotOf(
  prepared: ReadyGatePrPackage | undefined,
  gate: PublishGate | undefined,
): { snapshot: NonNullable<ReadyGatePrPackage['reviewSnapshot']> } | { unavailable: string } {
  const snapshot = prepared?.reviewSnapshot;
  if (!prepared || !snapshot?.diffHash || !snapshot.diffPath || !snapshot.headSha)
    return { unavailable: 'the run has no recorded reviewed patch' };
  if (gate?.packageId !== prepared.id)
    return { unavailable: "the recorded patch is not the gate's current package" };
  const covered = (gate.reviews ?? []).some(
    (review) =>
      review.verdict === 'pass' &&
      review.reviewSnapshot?.headSha === snapshot.headSha &&
      review.reviewSnapshot?.diffHash === snapshot.diffHash,
  );
  if (!covered) return { unavailable: 'no passing review covers the recorded patch' };
  return { snapshot };
}

/** Compare the run's reviewed, hash-verified patch with the PR's change between the pinned SHAs. */
export async function comparePublishedContent(
  run: Run,
  prepared: ReadyGatePrPackage | undefined,
  range: PublishedRange,
  github: typeof ghRequest,
): Promise<PublishedContentComparison> {
  const reviewed = reviewedSnapshotOf(prepared, run.engineState?.publishGate);
  if ('unavailable' in reviewed) return reviewed;
  const { snapshot } = reviewed;
  let reviewedDiff: string | undefined;
  try {
    reviewedDiff = await readVerifiedSnapshotDiff(run, snapshot);
  } catch (error) {
    // A slot or file read failure proves nothing: report it, never a match.
    return { unavailable: `the reviewed patch could not be read: ${(error as Error).message}` };
  }
  if (reviewedDiff === undefined)
    return { unavailable: 'the reviewed patch could not be verified against its recorded hash' };
  let publishedDiff: string;
  try {
    publishedDiff = (
      await github(
        [
          'api',
          `repos/${range.repository}/compare/${range.baseSha}...${range.headSha}`,
          '-H',
          'Accept: application/vnd.github.diff',
        ],
        { force: true },
      )
    ).stdout;
  } catch (error) {
    return { unavailable: `the PR diff could not be read: ${(error as Error).message}` };
  }
  let differingFiles: string[];
  try {
    differingFiles = differingPatchFiles(reviewedDiff, publishedDiff);
  } catch (error) {
    return { unavailable: `the patches could not be compared: ${(error as Error).message}` };
  }
  // Untracked reviewed files are outside the diff text, so the PR cannot be shown to carry them.
  const untracked = (snapshot.untrackedFiles ?? []).map((file) => file.path);
  if (untracked.length)
    return {
      unavailable: `the reviewed patch includes untracked files: ${untracked.join(', ')}`,
      differingFiles: [...new Set([...differingFiles, ...untracked])].sort(),
    };
  return { differingFiles };
}
