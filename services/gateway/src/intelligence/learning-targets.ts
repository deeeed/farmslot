// Where a checked (v1) lesson lands, and the rule proposal it becomes (ADR-026 Amendment 4).
import path from 'node:path';

import {
  type KnowledgeDestination,
  type LearningRuleKind,
  learningSectionAnchor,
  type LearningV1Entry,
  parseReviewRuleProposal,
  type ReviewRuleProposal,
} from '@farmslot/protocol';

import type { CuratedLearning, LearningDocument } from './learning-curation.js';

export type LearningTarget = { path: string; section?: string } | { hold: string };

/** Section anchors of a rules file's `##`/`###` headings. */
function sectionAnchors(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/^#{2,3} +(.+?) *#*$/gm)].map((match) => learningSectionAnchor(match[1]!)),
  );
}

/**
 * A tightening targets the cited family's file and section. A new rule targets
 * the client file when the project maps every evidence repo to one client
 * (`vars.knowledge_clients`, `metamask-mobile` → `mobile` → `antipatterns.mobile.md`),
 * else the shared file. Requirements are read for coverage and never edited; a
 * lesson without a clear target is held for a person.
 */
export function learningTarget(
  entry: LearningV1Entry,
  kind: LearningRuleKind,
  library: LearningDocument[],
  destination: KnowledgeDestination,
): LearningTarget {
  const dir = path.posix.dirname(destination.path);
  const file = (name: string) => (dir === '.' ? name : `${dir}/${name}`);
  if (kind !== 'add') {
    if (!entry.family) return { hold: `A ${kind} names no family` };
    const ref = `${entry.family.file}#${entry.family.anchor}`;
    if (/^requirements\b/.test(entry.family.file))
      return { hold: `${ref} is a requirement; requirements are never edited` };
    const rules = library.find((doc) => doc.path === file(entry.family!.file));
    if (!rules) return { hold: `No rules file ${entry.family.file} in the library` };
    if (!sectionAnchors(rules.text).has(entry.family.anchor))
      return { hold: `No section ${entry.family.anchor} in ${entry.family.file}` };
    return { path: rules.path, section: entry.family.anchor };
  }
  const base = path.posix.basename(destination.path, '.md');
  const clients = new Set((entry.evidence ?? []).map((ref) => destination.clients?.[ref.repo]));
  const [client] = clients;
  const clientFile = client && file(`${base}.${client}.md`);
  if (clients.size === 1 && clientFile && library.some((doc) => doc.path === clientFile))
    return { path: clientFile };
  return { path: destination.path };
}

/**
 * The kept lesson as a review rule proposal, pending a person's decision. It is
 * validated by the same parser every proposal goes through, and throws when the
 * lesson cannot make a valid one.
 */
export function learningRuleProposal(
  entry: LearningV1Entry,
  decision: { kind: LearningRuleKind; basis: 'results' | 'claim' },
  curated: Pick<CuratedLearning, 'instruction' | 'recurrence'>,
  runId: string,
  destination: KnowledgeDestination,
): ReviewRuleProposal {
  const { kind } = decision;
  let recurrence: CuratedLearning['recurrence'];
  if (kind !== 'retire') {
    // A receipt from before the bar was recorded cannot say which bar the keep met.
    recurrence = curated.recurrence;
    if (!recurrence) throw new Error('the curation recorded no recurrence bar');
  }
  const examined =
    kind === 'add'
      ? (entry.examined ?? []).map((ref) => ref.anchor)
      : entry.family
        ? [entry.family.anchor]
        : [];
  return parseReviewRuleProposal({
    schemaVersion: 1,
    pack: destination.library ?? path.posix.basename(destination.repo, '.git'),
    kind,
    ...(kind === 'add' ? {} : { family: entry.family?.anchor }),
    // A rule that recorded PASS on the problem missed it.
    source: decision.basis === 'results' ? 'miss' : 'finding',
    evidence: (entry.evidence ?? []).map((ref) => ({
      ref: `${ref.repo} (run ${runId})`,
      location: `${ref.path}:${ref.line}${ref.end ? `-${ref.end}` : ''}`,
    })),
    confirmation: entry.confirmation?.kind === 'fix' ? 'fix' : 'second-check',
    ...(recurrence ? { bar: { recurrence, examined } } : {}),
    change: curated.instruction ?? entry.text,
    netRuleDelta: kind === 'add' ? 1 : kind === 'retire' ? -1 : 0,
    decision: { status: 'pending' },
  });
}
