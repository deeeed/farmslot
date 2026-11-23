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

/**
 * One skill's checkout-relative files: its declared files, and its review pack
 * when it declares one. The single place that knows a required skill's layout.
 */
function skillFilePaths(
  config: RequiredSkillsConfig,
  skill: SelectedRequiredSkill,
): { files: string[]; pack?: string } {
  return {
    files: skill.files.map((file) => skillPath(config, skill.name, file)),
    ...(skill.review ? { pack: skillPath(config, skill.name, skill.review.pack) } : {}),
  };
}

/**
 * Every checkout-relative file a selection requires, in selection order: each
 * skill's declared files, then its review pack when it declares one.
 *
 * `freezeRequiredSkills` below freezes exactly these, and prepare's
 * `required_skills_present` requirement asks whether they exist before a profile
 * that skips the install phase is chosen. Both reach them through
 * `skillFilePaths`, so a new kind of declared file cannot be frozen by one and
 * ignored by the other.
 */
export function requiredSkillPaths(
  config: RequiredSkillsConfig,
  selection: RequiredSkillSelection,
): string[] {
  return selection.skills.flatMap((skill) => {
    const paths = skillFilePaths(config, skill);
    return [...paths.files, ...(paths.pack ? [paths.pack] : [])];
  });
}

function digest(repoRoot: string, relative: string): string | null {
  const file = path.join(repoRoot, relative);
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Why the bytes of a declared rule pack cannot be used, or null when they are a
 * valid pack. The one validator for every declaration route: a required skill's
 * pack and a static review's pack. A declared pack that cannot be used never
 * falls back to the generic review.
 */
export function reviewRulePackProblem(bytes: Buffer): string | null {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    parseReviewRulePack(value);
    return null;
  } catch (error) {
    return `is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Digest and validate a declared pack from one read, or null when it is not installed. */
function readPack(
  repoRoot: string,
  relative: string,
): { sha256: string; problem: string | null } | null {
  const file = path.join(repoRoot, relative);
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  const bytes = readFileSync(file);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    problem: reviewRulePackProblem(bytes),
  };
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
    const paths = skillFilePaths(config, skill);
    const files = paths.files.map((relative) => {
      const sha256 = digest(repoRoot, relative);
      if (sha256 === null) missing.push(relative);
      return { path: relative, sha256: sha256 ?? '' };
    });
    let review: FrozenRequiredSkill['review'];
    if (skill.review && paths.pack) {
      const relative = paths.pack;
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
