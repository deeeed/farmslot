// ADR-049 Amendment 3: select, freeze and check the one required skill set.
// Selection is deterministic over pack rules; the frozen set is written once
// into the task handoff and read unchanged by the dev worker and its review.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  compileGlob,
  type FrozenRequiredSkill,
  type RequiredSkillRule,
  type RequiredSkillsConfig,
  type RequiredSkillSelectionInput,
  type RequiredSkillSet,
} from '@farmslot/protocol';

export interface SelectedRequiredSkill {
  name: string;
  rules: string[];
  files: string[];
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
  status: 'pass' | 'missing' | 'scope-changed';
  missing: RequiredSkillGap[];
  scopeChanged: Array<{ skill: string; rules: string[] }>;
}

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
  if (when.paths) {
    const globs = when.paths.map(
      (glob) => compileGlob(glob, { anchoring: 'anchored', caseSensitive: true }).regex,
    );
    if (!(input.paths ?? []).some((file) => globs.some((glob) => glob.test(file)))) return false;
  }
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

/** Freeze the selection against the checkout; refuses when any required file is absent. */
export function freezeRequiredSkills(
  repoRoot: string,
  config: RequiredSkillsConfig,
  input: RequiredSkillSelectionInput,
): RequiredSkillSet {
  const selection = selectRequiredSkills(config, input);
  const gaps: string[] = [];
  const skills: FrozenRequiredSkill[] = selection.skills.map((skill) => {
    const missing: string[] = [];
    const files = skill.files.map((file) => {
      const relative = skillPath(config, skill.name, file);
      const sha256 = digest(repoRoot, relative);
      if (sha256 === null) missing.push(relative);
      return { path: relative, sha256: sha256 ?? '' };
    });
    if (missing.length)
      gaps.push(
        `Required skill ${skill.name} (rule ${skill.rules.join(', ')}) is not installed: missing ${missing.join(', ')}.`,
      );
    return { name: skill.name, rules: skill.rules, files };
  });
  if (gaps.length)
    throw new RequiredSkillsError(`${gaps.join(' ')} Refresh the slot skills, then prepare again.`);
  return {
    schemaVersion: 1,
    selection: {
      flow: input.flow,
      platform: input.platform,
      domain: input.domain ?? '',
      paths: [...(input.paths ?? [])],
    },
    rules: selection.rules,
    skills,
    config,
  };
}

/**
 * Read-only check of a frozen set: every file still present with its frozen bytes,
 * and (given the current changed paths) no rule outside the set now applies.
 */
export function checkRequiredSkills(
  repoRoot: string,
  set: RequiredSkillSet,
  changedPaths?: readonly string[],
): RequiredSkillsCheck {
  const missing: RequiredSkillGap[] = [];
  for (const skill of set.skills)
    for (const file of skill.files) {
      const sha256 = digest(repoRoot, file.path);
      if (sha256 !== file.sha256)
        missing.push({
          skill: skill.name,
          path: file.path,
          reason: sha256 === null ? 'missing' : 'changed',
        });
    }
  const scopeChanged: RequiredSkillsCheck['scopeChanged'] = [];
  if (changedPaths) {
    const frozen = new Set(set.skills.map((skill) => skill.name));
    const current = selectRequiredSkills(set.config, {
      flow: set.selection.flow,
      platform: set.selection.platform,
      ...(set.selection.domain ? { domain: set.selection.domain } : {}),
      paths: [...set.selection.paths, ...changedPaths],
    });
    for (const skill of current.skills)
      if (!frozen.has(skill.name)) scopeChanged.push({ skill: skill.name, rules: skill.rules });
  }
  return {
    status: missing.length ? 'missing' : scopeChanged.length ? 'scope-changed' : 'pass',
    missing,
    scopeChanged,
  };
}

/** TASK.md section naming the frozen files; empty when nothing is required. */
export function requiredSkillsTaskSection(set: RequiredSkillSet): string {
  if (set.skills.length === 0) return '';
  return [
    '## Required skills',
    '',
    'Frozen for this task in `inputs/handoff.json` (`requiredSkills`); its review checks against the same set. Load every file below before the first checklist step. Do not substitute repository docs.',
    '',
    ...set.skills.map(
      (skill) =>
        `- \`${skill.name}\` (rule ${skill.rules.map((rule) => `\`${rule}\``).join(', ')}): ${skill.files.map((file) => `\`${file.path}\``).join(', ')}`,
    ),
    '',
  ].join('\n');
}
