import type { RawProjectJson } from './config.js';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNRESOLVED_PLACEHOLDER_RE = /\{\{[^{}\n]+\}\}/;

export interface ProjectCommandEnvOptions {
  domain?: string;
  /** Slot-aware expansion for domain values only. Base values remain literal. */
  expandDomainValue?: (value: string) => string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function resolveProjectCommandEnv(
  projectJson: RawProjectJson,
  options: ProjectCommandEnvOptions = {},
): {
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
  const domainMutation = options.domain ? raw.domains?.[options.domain] : undefined;
  if (!domainMutation) return { unset, set };

  const mergedUnset = new Set(unset);
  const mergedSet = { ...set };
  for (const rawName of domainMutation.unset ?? []) {
    const name = String(rawName).trim();
    if (!name) continue;
    delete mergedSet[name];
    mergedUnset.add(name);
  }
  for (const [rawName, rawValue] of Object.entries(domainMutation.set ?? {})) {
    const name = rawName.trim();
    const value = options.expandDomainValue
      ? options.expandDomainValue(String(rawValue))
      : String(rawValue);
    if (UNRESOLVED_PLACEHOLDER_RE.test(value)) {
      throw new Error(
        `project command_env.domains.${options.domain}.set.${name} contains an unresolved placeholder`,
      );
    }
    mergedUnset.delete(name);
    mergedSet[name] = value;
  }
  return { unset: [...mergedUnset], set: mergedSet };
}

export function buildProjectCommandEnvPrefix(
  projectJson: RawProjectJson,
  options: ProjectCommandEnvOptions = {},
): string {
  const { unset, set } = resolveProjectCommandEnv(projectJson, options);
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

export function applyProjectCommandEnv(
  projectJson: RawProjectJson,
  command: string,
  options: ProjectCommandEnvOptions = {},
): string {
  const prefix = buildProjectCommandEnvPrefix(projectJson, options);
  return prefix ? `${prefix} && ${command}` : command;
}
