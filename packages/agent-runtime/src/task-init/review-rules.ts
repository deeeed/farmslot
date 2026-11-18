// ADR-0073 Amendment 1: review levels and selection on the existing checklist.
// A required review skill that declares a rule pack sets the review level; a
// family the selection leaves out becomes an `[OPTIONAL: ...]` step, so the
// existing `mark N --skip` records it with its reason and checklistTiming times
// every family. No new marking tool or store.

import {
  enumerateChecklistCheckboxes,
  type FrozenRequiredSkill,
  parseReviewRuleSelection,
  type RequiredSkillReviewLevel,
  type RequiredSkillSet,
  type ReviewRuleFamily,
  type ReviewRulePack,
} from '@farmslot/protocol';

import { RequiredSkillsError } from './required-skills.js';

export type ReviewRuleLevel =
  | { level: 'generic' }
  | { level: RequiredSkillReviewLevel; skill: string; client: string; pack: string };

/**
 * The review level of a frozen skill set: `generic` (level 1) when no required
 * skill declares a pack, otherwise that skill's declared level. Freezing
 * already refuses two pack-declaring skills; a handoff edited to carry two is
 * refused the same way.
 */
export function reviewRuleLevel(set: RequiredSkillSet): ReviewRuleLevel {
  const declared = set.skills.filter((skill) => skill.review);
  if (declared.length === 0) return { level: 'generic' };
  if (declared.length > 1)
    throw new RequiredSkillsError(
      `Required skills ${declared.map((skill) => skill.name).join(', ')} each declare a review pack, and one review runs one pack.`,
    );
  const [skill] = declared;
  const review = skill!.review!;
  return { level: review.level, skill: skill!.name, client: review.client, pack: review.pack.path };
}

function linksFamily(text: string, family: ReviewRuleFamily): boolean {
  const link = `${family.file}#${family.id}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s(\`])${link}($|[\\s).,;\`])`).test(text);
}

/**
 * Mark each family the selection leaves out as an optional step carrying the
 * selector's reason. The selection must have been computed for the frozen pack
 * digest and declared client, and covers exactly the families that client's
 * review carries.
 *
 * Steps come from the shared checklist parser, and a step is its row plus its
 * detail lines. Each step links at most one family, each family is linked by
 * at most one step, and every family in the selection must have its step: the
 * checklist and its pack disagree otherwise. Rows are only annotated, never
 * added or renumbered, so step numbers and the template's instructions stay
 * exactly as written.
 */
export function markUnselectedFamilies(
  checklist: string,
  pack: ReviewRulePack,
  review: NonNullable<FrozenRequiredSkill['review']>,
  selectionValue: unknown,
): string {
  const selection = parseReviewRuleSelection(selectionValue, pack, {
    sha256: review.pack.sha256,
    client: review.client,
  });
  const steps = new Map<string, { stepNumber: number; lineIndex: number }>();
  for (const item of enumerateChecklistCheckboxes(checklist)) {
    const text = `${item.rawLabel}\n${item.detail ?? ''}`;
    const linked = pack.families.filter((family) => linksFamily(text, family));
    if (linked.length > 1)
      throw new Error(
        `Checklist step ${item.stepNumber} links families ${linked.map((family) => family.id).join(', ')}; a step covers one family.`,
      );
    const [family] = linked;
    if (!family) continue;
    const owner = steps.get(family.id);
    if (owner)
      throw new Error(
        `Family ${family.id} is linked by checklist steps ${owner.stepNumber} and ${item.stepNumber}; one step covers a family.`,
      );
    steps.set(family.id, { stepNumber: item.stepNumber, lineIndex: item.lineIndex });
  }

  const lines = checklist.split('\n');
  const families = new Map(pack.families.map((family) => [family.id, family]));
  for (const entry of selection.families) {
    const family = families.get(entry.id)!;
    const step = steps.get(entry.id);
    if (!step)
      throw new Error(
        `The checklist has no step linking ${family.file}#${family.id}, which the ${selection.client} review carries.`,
      );
    if (!entry.selected)
      lines[step.lineIndex] =
        `${lines[step.lineIndex]!.trimEnd()} [OPTIONAL: not selected: ${entry.reason}]`;
  }
  return lines.join('\n');
}
