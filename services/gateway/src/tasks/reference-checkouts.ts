import type { ReferenceCheckout } from '@farmslot/agent-runtime';
import { referenceRepoPath } from '@farmslot/slot-config';

import { execOnSlot, type RawProjectJson, type SlotVars } from '../core/index.js';
import { shellQuote } from '../core/tmux.js';

/** A recipe library bound through the support environment, not a codebase to compare against. */
const isLibraryKey = (name: string) => name.endsWith('_library');

/**
 * Resolve every declared reference checkout on the machine that runs the task.
 *
 * Each `reference_repos` key names a sibling of the slot checkout. The probe runs
 * there rather than on the gateway, because a remote slot's siblings are not this
 * host's, and it reads the revision the worker will cite. A key that machine has not
 * cloned is reported absent — never substituted with that project's slot checkout,
 * which is a working tree other runs branch-switch and rewrite.
 *
 * One command, so a remote slot costs one round trip.
 */
export async function resolveReferenceCheckouts(
  slotVars: SlotVars,
  referenceRepos: RawProjectJson['reference_repos'],
  /** The slot checkout on the machine that runs the task; references are its siblings. */
  slotRepo: string,
): Promise<ReferenceCheckout[]> {
  const declared = Object.entries(referenceRepos ?? {})
    .filter(([name]) => !isLibraryKey(name))
    .flatMap(([name, reference]) => {
      const localName =
        typeof reference?.local_name === 'string' ? reference.local_name.trim() : '';
      // The one derivation of a reference path, shared with hooks and static review.
      return localName ? [{ name, path: referenceRepoPath(slotRepo, localName) }] : [];
    });
  if (!declared.length) return [];
  const command = declared
    .map(
      (reference) =>
        // --verify prints nothing when there is no commit yet: a repository without
        // one must not report the literal 'HEAD' that plain rev-parse echoes.
        `printf '%s\\t' ${shellQuote(reference.name)}; git -C ${shellQuote(reference.path)} rev-parse --verify HEAD 2>/dev/null || printf '\\n'`,
    )
    .join('; ');
  const probe = await execOnSlot(slotVars, command, { timeout: 20_000 });
  const revisions = new Map(
    probe.stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((parts) => parts.length === 2)
      // Only a full revision counts: a truncated or non-revision line is not one.
      .map(([name, sha]) => [name, /^[0-9a-f]{40}$/.test(sha.trim()) ? sha.trim() : ''] as const)
      .filter(([, sha]) => sha !== ''),
  );
  // A probe that could not run at all leaves every revision unread: report the
  // checkouts absent rather than claim a revision nobody read.
  return declared.map((reference) => {
    const headSha = revisions.get(reference.name);
    return headSha ? { ...reference, present: true, headSha } : { ...reference, present: false };
  });
}
