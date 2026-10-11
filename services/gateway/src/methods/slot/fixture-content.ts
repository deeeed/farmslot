import path from 'node:path';

import type { SlotVars } from '../../core/config.js';

const SOURCE_KEYS = new Set(['CONSENSYS_SKILLS_DIR', 'METAMASK_SKILLS_DIR']);

// Git's local exclude file is additive: skills sync and operators append rules.
export function ignoreFixtureMatches(seed: string, actual: string): boolean {
  const rules = (text: string) =>
    text.split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
  const expected = rules(seed);
  const installed = rules(actual);
  if (!expected.length) return false;
  if (installed.some((rule) => rule.startsWith('!') && !expected.includes(rule))) return false;
  let index = 0;
  for (const rule of installed) if (rule === expected[index]) index++;
  return index === expected.length;
}

function settings(text: string): Map<string, string> | null {
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match || result.has(match[1])) return null;
    const value = match[2].trim();
    result.set(match[1], value.replace(/^(["'])(.*)\1$/, '$2'));
  }
  return result;
}

// The skills installer owns additional source/target settings after the farm
// seeds this file. Compare configuration, not the seed's comments or path form.
export function skillsFixtureMatches(
  seed: string,
  actual: string,
  vars: Pick<SlotVars, 'remoteRepo' | 'machineEnv'>,
  repositoryUrl: string,
): boolean {
  const expected = settings(seed);
  const installed = settings(actual);
  if (!expected?.size || !installed) return false;
  const sourcePath = (value: string) => path.posix.resolve(vars.remoteRepo, value);
  for (const [key, value] of expected) {
    const got = installed.get(key);
    if (got === undefined) return false;
    if (SOURCE_KEYS.has(key)) {
      const configured = vars.machineEnv?.[key] ?? value;
      if (sourcePath(got) !== sourcePath(configured)) return false;
    } else if (got !== value) return false;
    installed.delete(key);
  }
  for (const [key, value] of installed) {
    if (key === 'METAMASK_SKILLS_TARGET_REPO') {
      if (value !== path.posix.basename(repositoryUrl).replace(/\.git$/, '')) return false;
    } else if (key === 'METAMASK_SKILLS_DIR') {
      const configured = vars.machineEnv?.[key] ?? '.skills-cache/metamask-skills';
      if (sourcePath(value) !== sourcePath(configured)) return false;
    } else return false;
  }
  return true;
}
