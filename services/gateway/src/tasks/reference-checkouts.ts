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
    // Opt-in by design. Several farms declare reference_repos.mobile as the slot's
    // OWN Mobile checkout (metamask-recipe-perps-farm binds it as
    // vars.owned_mobile_repo and installs and boots it): telling that worker the
    // tree is read-only would contradict its own checklist.
    .filter(([name, reference]) => !isLibraryKey(name) && reference?.read_only === true)
    .flatMap(([name, reference]) => {
      const localName =
        typeof reference?.local_name === 'string' ? reference.local_name.trim() : '';
      // The one derivation of a reference path, shared with hooks and static review.
      return localName ? [{ name, path: referenceRepoPath(slotRepo, localName) }] : [];
    });
  if (!declared.length) return [];
  const command = declared
    .map((reference) => {
      const at = shellQuote(reference.path);
      const name = shellQuote(reference.name);
      // Publish a revision only when both reads succeed. A failed status read
      // must be unreadable, not indistinguishable from an empty clean tree.
      return [
        `if farmslot_ref_head=$(git -C ${at} rev-parse --verify HEAD 2>/dev/null) &&`,
        `farmslot_ref_status=$(git --no-optional-locks -C ${at} status --porcelain 2>/dev/null); then`,
        `printf 'head\\t%s\\t%s\\nstatus\\t%s\\t%s\\n' ${name} "$farmslot_ref_head" ${name} "\${farmslot_ref_status:+dirty}";`,
        'fi',
      ].join(' ');
    })
    .join('; ');
  const probe = await execOnSlot(slotVars, command, { timeout: 20_000 });
  const revisions = new Map<string, string>();
  const changed = new Set<string>();
  for (const line of probe.stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length !== 3) continue;
    const [kind, name, value] = parts;
    // Only a full revision counts: a truncated or non-revision line is not one.
    if (kind === 'head' && /^[0-9a-f]{40}$/.test(value.trim())) revisions.set(name, value.trim());
    if (kind === 'status' && value.trim()) changed.add(name);
  }
  // Driven by what the probe printed, not by its exit status: a command that failed
  // part way still printed real revisions for the checkouts it reached, and a probe
  // that printed nothing leaves every reference absent rather than claiming a
  // revision nobody read.
  return declared.map((reference) => {
    const headSha = revisions.get(reference.name);
    if (!headSha) return { ...reference, present: false };
    return {
      ...reference,
      present: true,
      headSha,
      ...(changed.has(reference.name) ? { dirty: true } : {}),
    };
  });
}
