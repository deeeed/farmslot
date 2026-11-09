import { createHash } from 'node:crypto';

import type { ReadyGatePrPackage, Run } from '@farmslot/protocol';

import { stablePatchId } from '../../evals/blind-inputs.js';
import type { ghRequest } from '../../integrations/github-client.js';
import { readVerifiedSnapshotDiff } from '../../run-engine/review-diff-refresh.js';

/** Beyond this many files the comparison refuses rather than spawning git per file. */
const MAX_COMPARED_FILES = 300;

export type PublishedContentComparison =
  | { differingFiles: string[] }
  | { unavailable: string; differingFiles?: string[] };

/** `a -> b` for a rename or copy, otherwise the one path the section changes. */
function sectionKey(section: string): string {
  const from = /^rename from (.+)$/m.exec(section)?.[1] ?? /^copy from (.+)$/m.exec(section)?.[1];
  const to = /^rename to (.+)$/m.exec(section)?.[1] ?? /^copy to (.+)$/m.exec(section)?.[1];
  if (from && to) return `${from} -> ${to}`;
  const header = /^diff --git a\/(.+) b\/(.+)$/m.exec(section);
  if (!header) throw new Error('Unrecognised diff section header');
  return header[2] === '/dev/null' ? header[1]! : header[2]!;
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

/** Text hunks compare by stable patch-id (line offsets and blob ids ignored); a section with no hunk
 * (binary, mode-only, pure rename) compares by its header with the display-only index line dropped,
 * except for binaries, whose blob ids are their content. */
async function sectionIdentity(section: string): Promise<string> {
  if (/^@@ /m.test(section)) return `patch:${await stablePatchId(section)}`;
  const binary = /^(GIT binary patch|Binary files .* differ)$/m.test(section);
  const header = binary ? section : section.replace(/^index [^\n]*\n/gm, '');
  return `header:${createHash('sha256').update(header).digest('hex')}`;
}

/** Files whose change differs between two unified diffs, sorted; empty when they carry the same patch. */
export async function differingPatchFiles(reviewed: string, published: string): Promise<string[]> {
  const left = splitDiff(reviewed);
  const right = splitDiff(published);
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  if (keys.length > MAX_COMPARED_FILES)
    throw new Error(`the patches touch ${keys.length} files (limit ${MAX_COMPARED_FILES})`);
  const differing: string[] = [];
  for (const key of keys) {
    const a = left.get(key);
    const b = right.get(key);
    if (!a || !b || (await sectionIdentity(a)) !== (await sectionIdentity(b))) differing.push(key);
  }
  return differing;
}

/** Compare the run's reviewed, hash-verified patch with the PR's change vs its base on GitHub. */
export async function comparePublishedContent(
  run: Run,
  prepared: ReadyGatePrPackage | undefined,
  repository: string,
  prNumber: number,
  github: typeof ghRequest,
): Promise<PublishedContentComparison> {
  const snapshot = prepared?.reviewSnapshot;
  if (!snapshot?.diffHash || !snapshot.diffPath)
    return { unavailable: 'the run has no recorded reviewed patch' };
  const reviewed = await readVerifiedSnapshotDiff(run, snapshot);
  if (reviewed === undefined)
    return { unavailable: 'the reviewed patch could not be verified against its recorded hash' };
  const published = (
    await github(
      ['api', `repos/${repository}/pulls/${prNumber}`, '-H', 'Accept: application/vnd.github.diff'],
      { force: true },
    )
  ).stdout;
  let differingFiles: string[];
  try {
    differingFiles = await differingPatchFiles(reviewed, published);
  } catch (error) {
    // An unparseable or oversized diff proves nothing either way: report it, never a match.
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
