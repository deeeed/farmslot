// onboarding/pack.ts — project pack contract: validation, content hashing, and
// idempotency decisions for `farmslot project add` / `farmslot update`.
//
// A pack is a directory (local path or git clone) with a pack.json at its root
// and one or more project dirs in the standard projects/<name>/ layout.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface PackProject {
  /** Project dir inside the pack, e.g. "projects/example-app-farm". Basename = project name. */
  dir: string;
  /** Slot platform, e.g. "cli", "web". */
  platform: string;
  /** Default number of slots to create. */
  slots: number;
  /** Short name used in slot ids/sessions. Defaults to the project name without a -farm suffix. */
  short?: string;
  /** Product repo source to clone for each slot. Supports {{workspace}}. Overrides project.json repo_url. */
  repo_url?: string;
}

export interface PackHooks {
  /** Runs before product repos are cloned (e.g. seed a local fixture repo). */
  pre_add?: string;
  /** Runs after slots are created and validated. */
  post_add?: string;
  /** Runs on `farmslot update` when the pack content hash changed. */
  sync?: string;
  /** Pack smoke check; must exit 0 for `project add` to succeed. */
  smoke?: string;
}

export interface PackJson {
  name: string;
  description?: string;
  projects: PackProject[];
  hooks?: PackHooks;
  /** Printed after a successful add — operator next steps. */
  action_sheet?: string;
}

const HOOK_KEYS: ReadonlyArray<keyof PackHooks> = ['pre_add', 'post_add', 'sync', 'smoke'];

/** Structural validation of a parsed pack.json. Returns actionable errors; empty = valid. */
export function validatePackJson(pack: unknown): string[] {
  const errors: string[] = [];
  if (typeof pack !== 'object' || pack === null || Array.isArray(pack)) {
    return ['pack.json must be a JSON object'];
  }
  const p = pack as Record<string, unknown>;
  if (typeof p.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(p.name)) {
    errors.push(`'name' must be a lowercase kebab-case string`);
  }
  if (!Array.isArray(p.projects) || p.projects.length === 0) {
    errors.push(`'projects' must be a non-empty array`);
    return errors;
  }
  const projects: unknown[] = p.projects;
  projects.forEach((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`projects[${i}] must be an object`);
      return;
    }
    const proj = entry as Record<string, unknown>;
    if (typeof proj.dir !== 'string' || !proj.dir.startsWith('projects/')) {
      errors.push(
        `projects[${i}]: 'dir' must be a path under projects/ (got ${JSON.stringify(proj.dir)})`,
      );
    }
    if (typeof proj.platform !== 'string' || !/^[a-z][a-z0-9-]*$/.test(proj.platform as string)) {
      errors.push(`projects[${i}]: 'platform' must be a lowercase identifier`);
    }
    if (typeof proj.slots !== 'number' || !Number.isInteger(proj.slots) || proj.slots < 1) {
      errors.push(`projects[${i}]: 'slots' must be a positive integer`);
    }
  });
  if (p.hooks !== undefined) {
    if (typeof p.hooks !== 'object' || p.hooks === null) {
      errors.push(`'hooks' must be an object`);
    } else {
      for (const key of Object.keys(p.hooks)) {
        if (!HOOK_KEYS.includes(key as keyof PackHooks)) {
          errors.push(`hooks.${key}: unknown hook (expected one of ${HOOK_KEYS.join(', ')})`);
        }
      }
    }
  }
  if (p.action_sheet !== undefined && typeof p.action_sheet !== 'string') {
    errors.push(`'action_sheet' must be a string`);
  }
  return errors;
}

/** Validate the pack directory itself: pack.json parses, project dirs + project.json exist. */
export function validatePackDir(packDir: string): { pack: PackJson | null; errors: string[] } {
  const packJsonPath = join(packDir, 'pack.json');
  if (!existsSync(packJsonPath)) {
    return { pack: null, errors: [`no pack.json found at ${packJsonPath}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packJsonPath, 'utf-8'));
  } catch (err) {
    return {
      pack: null,
      errors: [`pack.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const errors = validatePackJson(parsed);
  if (errors.length > 0) return { pack: null, errors };
  const pack = parsed as PackJson;
  for (const proj of pack.projects) {
    const projDir = join(packDir, proj.dir);
    if (!existsSync(join(projDir, 'project.json'))) {
      errors.push(`${proj.dir}/project.json not found in pack`);
      continue;
    }
    const name = projectName(proj);
    const declared = JSON.parse(readFileSync(join(projDir, 'project.json'), 'utf-8')) as {
      name?: string;
    };
    if (declared.name !== name) {
      errors.push(
        `${proj.dir}/project.json: 'name' is ${JSON.stringify(declared.name)} but must match the dir name '${name}'`,
      );
    }
  }
  return errors.length > 0 ? { pack: null, errors } : { pack, errors: [] };
}

export function projectName(proj: PackProject): string {
  return proj.dir.split('/').filter(Boolean).pop() ?? '';
}

export function projectShortName(proj: PackProject): string {
  if (proj.short) return proj.short;
  const name = projectName(proj);
  return name.endsWith('-farm') ? name.slice(0, -'-farm'.length) : name;
}

/** Deterministic content hash of a pack directory (path + bytes of every file, sorted). */
export function hashPackDir(packDir: string): string {
  const hash = createHash('sha256');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === '.git' || entry === 'node_modules') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(packDir);
  for (const file of files) {
    hash.update(relative(packDir, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export type AddDecision = 'add' | 'noop' | 'repair';

/**
 * Idempotency decision for re-running `project add` on an already-registered pack:
 * unknown pack → add; same content hash → noop (verify only); changed hash → repair.
 */
export function decideAddAction(existingHash: string | undefined, newHash: string): AddDecision {
  if (existingHash === undefined) return 'add';
  return existingHash === newHash ? 'noop' : 'repair';
}

/** Expand onboarding template vars ({{workspace}}) in pack-declared strings. */
export function expandPackVars(text: string, vars: { workspace: string }): string {
  return text.replaceAll('{{workspace}}', vars.workspace);
}
