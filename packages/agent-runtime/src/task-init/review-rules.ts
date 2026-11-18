// ADR-0073 Amendment 1: review levels and selection on the existing checklist.
// A required review skill that declares a rule pack sets the review level; a
// family the selection leaves out becomes an `[OPTIONAL: ...]` step, so the
// existing `mark N --skip` records it with its reason and checklistTiming times
// every family. No new marking tool or store.

import {
  type RequiredSkillReviewLevel,
  type RequiredSkillSet,
  type ReviewRulePack,
  type ReviewRuleSelection,
} from '@farmslot/protocol';

export type ReviewRuleLevel =
  | { level: 'generic' }
  | { level: RequiredSkillReviewLevel; skill: string; client: string; pack: string };

/**
 * The review level of a frozen skill set: `generic` (level 1) when no required
 * skill declares a pack, otherwise that skill's declared level. A set with two
 * pack-declaring skills is refused: one review runs one pack.
 */
export function reviewRuleLevel(set: RequiredSkillSet): ReviewRuleLevel {
  const declared = set.skills.filter((skill) => skill.review);
  if (declared.length === 0) return { level: 'generic' };
  if (declared.length > 1)
    throw new Error(
      `Required skills ${declared.map((skill) => skill.name).join(', ')} each declare a review pack; one review runs one pack.`,
    );
  const [skill] = declared;
  const review = skill!.review!;
  return { level: review.level, skill: skill!.name, client: review.client, pack: review.pack.path };
}

const CHECKBOX = /^\s*- \[[ xX]\] /;

/**
 * Mark each family the selection leaves out as optional, with the selector's
 * reason, on the checklist row that links `<file>#<id>`. A family with no such
 * row is refused: the checklist and its pack disagree.
 */
export function markUnselectedFamilies(
  checklist: string,
  pack: ReviewRulePack,
  selection: ReviewRuleSelection,
): string {
  const lines = checklist.split('\n');
  const families = new Map(pack.families.map((family) => [family.id, family]));
  for (const entry of selection.families) {
    if (entry.selected) continue;
    const family = families.get(entry.id);
    if (!family)
      throw new Error(`Selection names family "${entry.id}", which the pack does not have`);
    const link = `${family.file}#${family.id}`;
    const at = lines.findIndex((line) =>
      new RegExp(`(^|[\\s(])${escape(link)}($|[\\s).,;])`).test(line),
    );
    if (at === -1) throw new Error(`The checklist has no row linking ${link}`);
    let row = at;
    while (row >= 0 && !CHECKBOX.test(lines[row]!)) row -= 1;
    if (row === -1) throw new Error(`The checklist has no row linking ${link}`);
    lines[row] = `${lines[row]!.trimEnd()} [OPTIONAL: not selected: ${entry.reason}]`;
  }
  return lines.join('\n');
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
