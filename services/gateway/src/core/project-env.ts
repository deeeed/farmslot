import type { RawProjectJson } from './config.js';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readCommandEnv(projectJson: RawProjectJson): {
  unset: string[];
  set: Record<string, string>;
} {
  const raw = projectJson.command_env;
  if (!raw || typeof raw !== 'object') return { unset: [], set: {} };
  const rawUnset = Array.isArray(raw.unset) ? raw.unset : [];
  const unset = rawUnset.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  const rawSet = raw.set && typeof raw.set === 'object' && !Array.isArray(raw.set) ? raw.set : {};
  const set = Object.fromEntries(
    Object.entries(rawSet).map(([key, value]) => [key.trim(), String(value)]),
  );
  return { unset, set };
}

export function buildProjectCommandEnvPrefix(projectJson: RawProjectJson): string {
  const { unset, set } = readCommandEnv(projectJson);
  const invalidNames = [...unset, ...Object.keys(set)].filter((name) => !ENV_NAME_RE.test(name));
  if (invalidNames.length > 0) {
    throw new Error(
      `project command_env contains invalid variable name(s): ${invalidNames.join(', ')}`,
    );
  }

  const parts: string[] = [];
  if (unset.length > 0) parts.push(`unset ${unset.join(' ')}`);
  for (const [name, value] of Object.entries(set)) {
    parts.push(`export ${name}=${shellQuote(value)}`);
  }
  return parts.join(' && ');
}

export function applyProjectCommandEnv(projectJson: RawProjectJson, command: string): string {
  const prefix = buildProjectCommandEnvPrefix(projectJson);
  return prefix ? `${prefix} && ${command}` : command;
}
