// onboarding/pack.ts — project pack contract: validation, content hashing, and
// idempotency decisions for `farmslot project add` / `farmslot update`.
//
// A pack is a directory (local path or git clone) with a pack.json at its root
// and one or more project dirs in the standard projects/<name>/ layout.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
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
    // Single path segment under projects/ — never a traversal like projects/../..
    if (typeof proj.dir !== 'string' || !/^projects\/[a-z][a-z0-9-]*$/.test(proj.dir)) {
      errors.push(
        `projects[${i}]: 'dir' must be projects/<kebab-case-name> (got ${JSON.stringify(proj.dir)})`,
      );
    }
    if (typeof proj.platform !== 'string' || !/^[a-z][a-z0-9-]*$/.test(proj.platform as string)) {
      errors.push(`projects[${i}]: 'platform' must be a lowercase identifier`);
    }
    if (typeof proj.slots !== 'number' || !Number.isInteger(proj.slots) || proj.slots < 1) {
      errors.push(`projects[${i}]: 'slots' must be a positive integer`);
    }
    if (
      proj.short !== undefined &&
      (typeof proj.short !== 'string' || !/^[a-z][a-z0-9-]*$/.test(proj.short))
    ) {
      errors.push(`projects[${i}]: 'short' must be a lowercase kebab-case identifier`);
    }
    if (
      proj.repo_url !== undefined &&
      (typeof proj.repo_url !== 'string' || proj.repo_url.length === 0)
    ) {
      errors.push(`projects[${i}]: 'repo_url' must be a non-empty string`);
    }
  });
  if (p.hooks !== undefined) {
    if (typeof p.hooks !== 'object' || p.hooks === null) {
      errors.push(`'hooks' must be an object`);
    } else {
      for (const [key, value] of Object.entries(p.hooks)) {
        if (!HOOK_KEYS.includes(key as keyof PackHooks)) {
          errors.push(`hooks.${key}: unknown hook (expected one of ${HOOK_KEYS.join(', ')})`);
        } else if (typeof value !== 'string' || value.length === 0) {
          errors.push(`hooks.${key}: must be a non-empty shell command string`);
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
    let declared: { name?: string };
    try {
      declared = JSON.parse(readFileSync(join(projDir, 'project.json'), 'utf-8')) as {
        name?: string;
      };
    } catch (err) {
      errors.push(
        `${proj.dir}/project.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (declared.name !== name) {
      errors.push(
        `${proj.dir}/project.json: 'name' is ${JSON.stringify(declared.name)} but must match the dir name '${name}'`,
      );
    }
    const setupScript = join(projDir, 'setup', `${proj.platform}.sh`);
    if (!existsSync(setupScript)) {
      errors.push(
        `${proj.dir}/setup/${proj.platform}.sh not found in pack (project add runs setup-slot.sh for every declared platform)`,
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

/**
 * Deterministic content hash of a pack directory (path + bytes of every file,
 * sorted). Symlinks are hashed by their target path, not followed — packs must
 * be self-contained and link-following could escape the pack or loop.
 */
export function hashPackDir(packDir: string): string {
  const hash = createHash('sha256');
  const entries: Array<{ rel: string; content: Buffer | string }> = [];
  const isGitPack = existsSync(join(packDir, '.git'));
  const isIgnored = (rel: string): boolean => {
    if (!isGitPack) return false;
    const result = spawnSync('git', ['-C', packDir, 'check-ignore', '--quiet', '--', rel]);
    return result.status === 0;
  };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === '.git' || entry === 'node_modules') continue;
      const full = join(dir, entry);
      const rel = relative(packDir, full);
      if (isIgnored(rel)) continue;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        entries.push({ rel, content: `symlink:${readlinkSync(full)}` });
      } else if (stat.isDirectory()) {
        walk(full);
      } else {
        entries.push({ rel, content: readFileSync(full) });
      }
    }
  };
  walk(packDir);
  for (const entry of entries) {
    hash.update(entry.rel);
    hash.update('\0');
    hash.update(entry.content);
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
