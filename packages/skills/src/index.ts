export const FARMSLOT_SKILLS_PACKAGE = '@farmslot/skills';

export const FARMSLOT_SKILL_NAMES = [
  'recipe-cook',
  'recipe-quality',
  'recipe-doctor',
  'recipe-harness',
  'project-adopt',
  'interactive-operator-packets',
] as const;

export type FarmslotSkillName = (typeof FARMSLOT_SKILL_NAMES)[number];

export const FARMSLOT_SKILL_INSTALL_LAYOUTS = ['agents', 'claude', 'codex', 'cursor'] as const;

export type FarmslotSkillInstallLayout = (typeof FARMSLOT_SKILL_INSTALL_LAYOUTS)[number];
