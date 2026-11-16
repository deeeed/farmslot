import path from 'node:path';

import type { ReferenceCheckout } from '@farmslot/agent-runtime';

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
  parentDir: string,
): Promise<ReferenceCheckout[]> {
  const declared = Object.entries(referenceRepos ?? {})
    .filter(([name]) => !isLibraryKey(name))
    .flatMap(([name, reference]) => {
      const localName =
        typeof reference?.local_name === 'string' ? reference.local_name.trim() : '';
      return localName ? [{ name, path: path.join(parentDir, localName) }] : [];
    });
  if (!declared.length) return [];
  const command = declared
    .map(
      (reference) =>
        `printf '%s\\t' ${shellQuote(reference.name)}; git -C ${shellQuote(reference.path)} rev-parse HEAD 2>/dev/null || printf '\\n'`,
    )
    .join('; ');
  const probe = await execOnSlot(slotVars, command, { cwd: parentDir, timeout: 20_000 });
  const revisions = new Map(
    probe.stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((parts) => parts.length === 2)
      .map(([name, sha]) => [name, sha.trim()] as const),
  );
  // A probe that could not run at all leaves every revision unread: report the
  // checkouts absent rather than claim a revision nobody read.
  return declared.map((reference) => {
    const headSha = revisions.get(reference.name);
    return headSha ? { ...reference, present: true, headSha } : { ...reference, present: false };
  });
}
