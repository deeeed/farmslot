// ADR-049 Amendment 3: select, freeze and check the one required skill set.
// Selection is deterministic over pack rules; the frozen set is written once
// into the task handoff and read unchanged by the dev worker and its review.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  type FrozenRequiredSkill,
  parseReviewRulePack,
  type RequiredSkillReview,
  type RequiredSkillRule,
  type RequiredSkillsConfig,
  type RequiredSkillSelectionInput,
  type RequiredSkillSet,
} from '@farmslot/protocol';

export interface SelectedRequiredSkill {
  name: string;
  rules: string[];
  files: string[];
  review?: RequiredSkillReview;
}

export interface RequiredSkillSelection {
  rules: string[];
  skills: SelectedRequiredSkill[];
}

export interface RequiredSkillGap {
  skill: string;
  path: string;
  reason: 'missing' | 'changed';
}

export interface RequiredSkillsCheck {
  status: 'pass' | 'missing';
  missing: RequiredSkillGap[];
}

/** The one repair instruction for a missing or changed required skill. */
export const REQUIRED_SKILLS_REPAIR = 'Refresh the slot skills, then prepare again.';

export class RequiredSkillsError extends Error {
  override name = 'RequiredSkillsError';
  readonly code = 'REQUIRED_SKILL_MISSING';
  readonly exitCode = 5;
}

function matches(rule: RequiredSkillRule, input: RequiredSkillSelectionInput): boolean {
  const when = rule.when ?? {};
  if (when.flows && !when.flows.includes(input.flow)) return false;
  if (when.platforms && !when.platforms.includes(input.platform)) return false;
  if (when.domains && !(input.domain && when.domains.includes(input.domain))) return false;
  return true;
}

/** Union of matching rules in pack order; a skill named twice keeps one entry. */
export function selectRequiredSkills(
  config: RequiredSkillsConfig,
  input: RequiredSkillSelectionInput,
): RequiredSkillSelection {
  const rules: string[] = [];
  const skills = new Map<string, SelectedRequiredSkill>();
  for (const rule of config.rules) {
    if (!matches(rule, input)) continue;
    rules.push(rule.id);
    for (const skill of rule.skills) {
      const entry = skills.get(skill.name) ?? { name: skill.name, rules: [], files: [] };
      if (!entry.rules.includes(rule.id)) entry.rules.push(rule.id);
      for (const file of skill.files) if (!entry.files.includes(file)) entry.files.push(file);
      if (skill.review) {
        if (entry.review && JSON.stringify(entry.review) !== JSON.stringify(skill.review))
          throw new RequiredSkillsError(
            `Required skill ${skill.name} declares two different review packs (rules ${[...entry.rules].join(', ')}). Declare one in project.json required_skills.`,
          );
        entry.review = skill.review;
      }
      skills.set(skill.name, entry);
    }
  }
  return { rules, skills: [...skills.values()] };
}

function skillPath(config: RequiredSkillsConfig, skill: string, file: string): string {
  return path.posix.join(config.root, skill, file);
}

function digest(repoRoot: string, relative: string): string | null {
  const file = path.join(repoRoot, relative);
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Digest and validate a declared pack from one read, or null when it is not
 * installed. A declared pack that cannot be used never falls back to the
 * generic review.
 */
function readPack(
  repoRoot: string,
  relative: string,
): { sha256: string; problem: string | null } | null {
  const file = path.join(repoRoot, relative);
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  const bytes = readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return {
      sha256,
      problem: `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    parseReviewRulePack(value);
    return { sha256, problem: null };
  } catch (error) {
    return {
      sha256,
      problem: `is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Freeze the selection against the checkout; refuses when any required file is absent. */
export function freezeRequiredSkills(
  repoRoot: string,
  config: RequiredSkillsConfig,
  input: RequiredSkillSelectionInput,
): RequiredSkillSet {
  const selection = selectRequiredSkills(config, input);
  const packs = selection.skills.filter((skill) => skill.review).map((skill) => skill.name);
  if (packs.length > 1)
    throw new RequiredSkillsError(
      `Required skills ${packs.join(', ')} each declare a review pack, and one review runs one pack. Declare the pack on one skill in project.json required_skills.`,
    );
  const gaps: string[] = [];
  const skills: FrozenRequiredSkill[] = selection.skills.map((skill) => {
    const missing: string[] = [];
    const files = skill.files.map((file) => {
      const relative = skillPath(config, skill.name, file);
      const sha256 = digest(repoRoot, relative);
      if (sha256 === null) missing.push(relative);
      return { path: relative, sha256: sha256 ?? '' };
    });
    let review: FrozenRequiredSkill['review'];
    if (skill.review) {
      const relative = skillPath(config, skill.name, skill.review.pack);
      const pack = readPack(repoRoot, relative);
      if (pack === null) missing.push(relative);
      else {
        if (pack.problem)
          gaps.push(`Required skill ${skill.name} review pack ${relative} ${pack.problem}.`);
        review = {
          pack: { path: relative, sha256: pack.sha256 },
          client: skill.review.client,
          level: skill.review.level,
        };
      }
    }
    if (missing.length)
      gaps.push(
        `Required skill ${skill.name} (rule ${skill.rules.join(', ')}) is not installed: missing ${missing.join(', ')}.`,
      );
    return { name: skill.name, rules: skill.rules, files, ...(review ? { review } : {}) };
  });
  if (gaps.length) throw new RequiredSkillsError(`${gaps.join(' ')} ${REQUIRED_SKILLS_REPAIR}`);
  return {
    schemaVersion: 1,
    selection: { flow: input.flow, platform: input.platform, domain: input.domain ?? '' },
    rules: selection.rules,
    skills,
  };
}

/** Read-only check of a frozen set: every file still present with its frozen bytes. */
export function checkRequiredSkills(repoRoot: string, set: RequiredSkillSet): RequiredSkillsCheck {
  const missing: RequiredSkillGap[] = [];
  for (const skill of set.skills)
    for (const file of skill.review ? [...skill.files, skill.review.pack] : skill.files) {
      const sha256 = digest(repoRoot, file.path);
      if (sha256 !== file.sha256)
        missing.push({
          skill: skill.name,
          path: file.path,
          reason: sha256 === null ? 'missing' : 'changed',
        });
    }
  return { status: missing.length ? 'missing' : 'pass', missing };
}

/** TASK.md section naming the frozen files; empty when nothing is required. */
export function requiredSkillsTaskSection(set: RequiredSkillSet): string {
  if (set.skills.length === 0) return '';
  return [
    '## Required skills',
    '',
    'Frozen for this task in `inputs/handoff.json` (`requiredSkills`); its review checks against the same set. Read every file below after marking step 1, and before the work it governs. Do not substitute repository docs.',
    '',
    ...set.skills.map(
      (skill) =>
        `- \`${skill.name}\` (rule ${skill.rules.map((rule) => `\`${rule}\``).join(', ')}): ${skill.files.map((file) => `\`${file.path}\``).join(', ')}`,
    ),
    '',
  ].join('\n');
}
