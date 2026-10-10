import { getNode } from '../fleet/machine-registry.js';

import type { ProjectVars, RawProjectJson, SlotVars } from './config.js';
import { isLocal } from './exec.js';
import { expandTemplate } from './hooks.js';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNRESOLVED_PLACEHOLDER_RE = /\{\{[^{}\n]+\}\}/;

export interface ProjectCommandEnvOptions {
  domain?: string;
  /** Slot-aware expansion for domain values only. Base values remain literal. */
  expandDomainValue?: (value: string) => string;
  /** Frozen launch bindings replace project values before placeholder validation. */
  overrides?: Record<string, string>;
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
  const finish = (unset: string[], set: Record<string, string>) => ({
    unset: unset.filter((name) => !Object.hasOwn(options.overrides ?? {}, name)),
    set: { ...set, ...options.overrides },
  });
  if (!raw || typeof raw !== 'object') return finish([], {});
  const rawUnset = Array.isArray(raw.unset) ? raw.unset : [];
  const unset = rawUnset.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  const rawSet = raw.set && typeof raw.set === 'object' && !Array.isArray(raw.set) ? raw.set : {};
  const set = Object.fromEntries(
    Object.entries(rawSet).map(([key, value]) => [key.trim(), String(value)]),
  );
  const domainMutation = options.domain ? raw.domains?.[options.domain] : undefined;
  if (!domainMutation) return finish(unset, set);

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
    if (Object.hasOwn(options.overrides ?? {}, name)) continue;
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
  return finish([...mergedUnset], mergedSet);
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

/**
 * `export` prefix for a machine's pool `env`. Applied to every shell Farmslot
 * runs on that machine (runner launches, prepare hooks, recipe runs) so a
 * machine-specific tool location reaches the worker the same way on a local
 * and an SSH slot. Names were validated when the pool loaded.
 */
export function buildMachineEnvPrefix(machineEnv: Record<string, string> | undefined): string {
  return Object.entries(machineEnv ?? {})
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
    .join(' && ');
}

/**
 * Pool `env` plus GW_URL for a remote node: the URL that node itself uses to
 * reach this gateway, so `farmslot` run from a slot targets the dispatching
 * gateway instead of the machine's operator profile (which may name a tunnel
 * that only exists elsewhere). Pool values win. No credential is added.
 */
export function machineShellEnv(vars: {
  machine?: string;
  host?: string;
  machineEnv?: Record<string, string>;
}): Record<string, string> {
  const gatewayUrl =
    vars.machine && vars.host && !isLocal(vars.host, vars.machine)
      ? getNode(vars.machine)?.gatewayUrl
      : undefined;
  return { ...(gatewayUrl ? { GW_URL: gatewayUrl } : {}), ...vars.machineEnv };
}

/** `&&`-joined so a guard before the command (for example `cd repo &&`) still gates it. */
export function withMachineEnv(
  command: string,
  vars: { machine?: string; host?: string; machineEnv?: Record<string, string> },
): string {
  const prefix = buildMachineEnvPrefix(machineShellEnv(vars));
  return prefix ? `${prefix} && ${command}` : command;
}

/** Project/domain defaults first, then the selected node's pool environment. */
export function withProjectMachineEnv(
  command: string,
  vars: SlotVars,
  projectJson: RawProjectJson,
  projectVars?: ProjectVars,
  domain = vars.domain,
): string {
  return applyProjectCommandEnv(
    projectJson,
    withMachineEnv(command, {
      ...vars,
      machineEnv: { ...vars.machineEnv, FARMSLOT_MACHINE: vars.machine },
    }),
    {
      ...(domain ? { domain } : {}),
      expandDomainValue: (value) =>
        expandTemplate(value, vars, projectVars, { domain: domain ?? '' }),
    },
  );
}
