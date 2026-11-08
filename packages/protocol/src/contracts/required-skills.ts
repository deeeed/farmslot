/**
 * ADR-049 Amendment 3: the one required skill set a pack selects for a task.
 * Pack rules live in `project.json` `required_skills`; task init freezes the
 * selection into `inputs/handoff.json` `requiredSkills`, which the dev worker
 * and its pipeline review both read.
 */

export interface RequiredSkillRuleMatch {
  flows?: string[];
  platforms?: string[];
  domains?: string[];
}

export interface RequiredSkillDeclaration {
  /** Installed skill directory name under `required_skills.root`. */
  name: string;
  /** Files the worker must load, relative to the installed skill directory. */
  files: string[];
}

export interface RequiredSkillRule {
  id: string;
  when?: RequiredSkillRuleMatch;
  skills: RequiredSkillDeclaration[];
}

export interface RequiredSkillsConfig {
  /** Checkout-relative directory holding installed skills, e.g. `.agents/skills`. */
  root: string;
  rules: RequiredSkillRule[];
}

export interface RequiredSkillSelectionInput {
  flow: string;
  platform: string;
  domain?: string;
}

export interface RequiredSkillFile {
  /** Checkout-relative path. */
  path: string;
  sha256: string;
}

export interface FrozenRequiredSkill {
  name: string;
  /** Rule ids that required this skill. */
  rules: string[];
  files: RequiredSkillFile[];
}

/** The frozen set, recorded once at task init. */
export interface RequiredSkillSet {
  schemaVersion: 1;
  /** Selection inputs. */
  selection: { flow: string; platform: string; domain: string };
  /** Matched rule ids, in pack order. */
  rules: string[];
  skills: FrozenRequiredSkill[];
}

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function relativeSafe(value: string): boolean {
  if (!value || value.startsWith('/') || value.includes('\\')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function stringList(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || !entry.trim())
  )
    throw new Error(`${field} must be a non-empty array of non-empty strings`);
  return value as string[];
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length) throw new Error(`${field} has unsupported properties: ${extra.join(', ')}`);
}

/** Validates pack `required_skills`; throws with the offending field. */
export function parseRequiredSkillsConfig(
  value: unknown,
  field = 'required_skills',
): RequiredSkillsConfig {
  const config = record(value, field);
  onlyKeys(config, ['root', 'rules'], field);
  if (typeof config.root !== 'string' || !relativeSafe(config.root))
    throw new Error(`${field}.root must be a checkout-relative directory`);
  if (!Array.isArray(config.rules) || config.rules.length === 0)
    throw new Error(`${field}.rules must be a non-empty array`);
  const ids = new Set<string>();
  const rules = config.rules.map((raw, index): RequiredSkillRule => {
    const ruleField = `${field}.rules[${index}]`;
    const rule = record(raw, ruleField);
    onlyKeys(rule, ['id', 'when', 'skills'], ruleField);
    if (typeof rule.id !== 'string' || !SAFE_NAME.test(rule.id))
      throw new Error(`${ruleField}.id must be a simple name`);
    if (ids.has(rule.id)) throw new Error(`${field} has duplicate rule id "${rule.id}"`);
    ids.add(rule.id);
    let when: RequiredSkillRuleMatch | undefined;
    if (rule.when !== undefined) {
      const match = record(rule.when, `${ruleField}.when`);
      onlyKeys(match, ['flows', 'platforms', 'domains'], `${ruleField}.when`);
      when = {};
      for (const key of ['flows', 'platforms', 'domains'] as const) {
        if (match[key] !== undefined)
          when[key] = stringList(match[key], `${ruleField}.when.${key}`);
      }
    }
    if (!Array.isArray(rule.skills) || rule.skills.length === 0)
      throw new Error(`${ruleField}.skills must be a non-empty array`);
    const skills = rule.skills.map((rawSkill, skillIndex): RequiredSkillDeclaration => {
      const skillField = `${ruleField}.skills[${skillIndex}]`;
      const skill = record(rawSkill, skillField);
      onlyKeys(skill, ['name', 'files'], skillField);
      if (typeof skill.name !== 'string' || !SAFE_NAME.test(skill.name))
        throw new Error(`${skillField}.name must be an installed skill directory name`);
      const files = stringList(skill.files, `${skillField}.files`);
      for (const file of files)
        if (!relativeSafe(file))
          throw new Error(`${skillField}.files entry "${file}" must be skill-relative`);
      return { name: skill.name, files };
    });
    return { id: rule.id, ...(when ? { when } : {}), skills };
  });
  return { root: config.root, rules };
}

/** Shape check for a frozen set read back from a task handoff. */
export function isRequiredSkillSet(value: unknown): value is RequiredSkillSet {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const set = value as Record<string, unknown>;
  const selection = set.selection as Record<string, unknown> | undefined;
  if (
    set.schemaVersion !== 1 ||
    !selection ||
    typeof selection.flow !== 'string' ||
    typeof selection.platform !== 'string' ||
    typeof selection.domain !== 'string' ||
    !Array.isArray(set.rules) ||
    !Array.isArray(set.skills)
  )
    return false;
  return set.skills.every((entry: unknown) => {
    const skill = entry as Record<string, unknown> | null;
    return (
      !!skill &&
      typeof skill.name === 'string' &&
      Array.isArray(skill.rules) &&
      Array.isArray(skill.files) &&
      skill.files.every(
        (file: unknown) =>
          !!file &&
          typeof (file as RequiredSkillFile).path === 'string' &&
          relativeSafe((file as RequiredSkillFile).path) &&
          /^[0-9a-f]{64}$/.test((file as RequiredSkillFile).sha256),
      )
    );
  });
}
