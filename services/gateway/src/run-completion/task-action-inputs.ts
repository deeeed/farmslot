import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { isRecord, TASK_DIRECTORY_LAYOUT, type TaskActionInputLibrary } from '@farmslot/protocol';
import {
  digestRecipeLibrary,
  readRecipeLibraryManifest,
  type RecipeLibraryManifest,
} from '@farmslot/recipe-runner';

/** The convention discovery matches on; the capture group is the manifest's scope. */
const ACTION_MANIFEST_FILE = /^([^/]+)\.action-manifest\.json$/u;

export function taskActionInputReferences(summary: unknown): TaskActionInputLibrary[] {
  if (!isRecord(summary) || summary.taskActions === undefined) return [];
  if (!Array.isArray(summary.taskActions)) throw new Error('Recipe taskActions must be an array.');
  const libraries = new Map<string | null, string[]>();
  for (const value of summary.taskActions) {
    if (!isRecord(value) || typeof value.action !== 'string' || !value.action)
      throw new Error('Recipe taskActions contains an invalid action reference.');
    if (value.digest !== undefined && typeof value.digest !== 'string')
      throw new Error(`Recipe task action ${value.action} has an invalid library digest.`);
    const digest = typeof value.digest === 'string' ? value.digest : null;
    const names = libraries.get(digest) ?? [];
    if (!names.includes(value.action)) names.push(value.action);
    libraries.set(digest, names);
  }
  return [...libraries].map(([expectedLibraryDigest, actionNames]) => ({
    actionNames,
    expectedLibraryDigest,
  }));
}

/**
 * False is only a missing root. An existing but changed/partial input is a hard failure.
 *
 * `supersededActions` are claims from attempts the publication did not select.
 * One retained library tree carries one digest, so a superseded attempt that ran
 * before the library legitimately moved can never match it — and refusing on
 * that would reject a valid before/after pair. Those claims are therefore
 * checked for presence only, and only while the selected attempt's claim pins
 * the retained bytes: that claim is the integrity anchor, so corrupt bytes still
 * fail there. With no selected claim there is nothing to anchor to, so every
 * claim stays authoritative.
 */
export async function taskActionInputsAvailable(
  taskDir: string,
  actions: readonly TaskActionInputLibrary[],
  supersededActions: readonly TaskActionInputLibrary[] = [],
): Promise<boolean> {
  const anchored = actions.length > 0;
  const authoritative = anchored ? actions : [...actions, ...supersededActions];
  const referenced = anchored ? [...actions, ...supersededActions] : authoritative;
  if (!referenced.length) return true;
  const root = path.join(taskDir, TASK_DIRECTORY_LAYOUT.taskActions.relativePath);
  const names = [...new Set(referenced.flatMap(({ actionNames }) => actionNames))].join(', ');
  try {
    if (!(await lstat(root)).isDirectory())
      throw new Error(`Task-action inputs are not a directory for ${names}: ${root}.`);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
  const relative = path.relative(await realpath(taskDir), await realpath(root));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error(`Task-action inputs escape their task directory: ${names}.`);
  const digest = await digestRecipeLibrary(root, await readRecipeLibraryManifest(root));
  const expected = new Set(authoritative.map(({ expectedLibraryDigest }) => expectedLibraryDigest));
  if (expected.size !== 1 || !expected.has(digest))
    throw new Error(
      `Task-action implementation library digest does not match the recorded recipe: ${names}; expected ${[...expected].map((value) => value ?? 'unavailable').join(', ')}, found ${digest}.`,
    );
  const implementations = path.join(
    taskDir,
    TASK_DIRECTORY_LAYOUT.taskActionImplementations.relativePath,
  );
  let entries: Dirent[];
  try {
    entries = await readdir(implementations, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    throw new Error(`Task-action implementation is missing for ${names}.`);
  }
  if (!entries.some((entry) => entry.isFile()))
    throw new Error(`Task-action implementation is missing for ${names}.`);
  // "Some file exists under actions/" is not evidence that *this* action was
  // retained. An attempt that used two task actions, then had one and its
  // manifest entry deleted before the selected attempt ran, would otherwise
  // publish a before image whose implementation is gone: the selected digest
  // matches the smaller library and the other action's file satisfies the
  // presence check. Each referenced action has to be declared by the retained
  // library itself.
  const declared = await declaredTaskActionNames(root);
  const undeclared = [...new Set(referenced.flatMap(({ actionNames }) => actionNames))].filter(
    (action) => !declared.has(action),
  );
  if (undeclared.length)
    throw new Error(
      `Task-action implementation is missing for ${undeclared.join(', ')}: the retained library declares ${declared.size ? [...declared].join(', ') : 'no actions'}.`,
    );
  return true;
}

/**
 * Every action name the retained library's own action manifests declare.
 *
 * Exactly the files discovery would load, which is one manifest per scope:
 * `manifests/<scope>.action-manifest.json` by convention, and an `actions` entry
 * replaces that scope's file. Reading more than that lets a manifest the library
 * has already superseded keep declaring an action whose implementation is gone,
 * and turns an unrelated JSON file in the directory into a refusal.
 */
async function declaredTaskActionNames(root: string): Promise<Set<string>> {
  const manifest = await readRecipeLibraryManifest(root);
  const files = await actionManifestFiles(root, manifest);
  const names = new Set<string>();
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw new Error(
        `Task-action manifest ${path.basename(file)} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (isRecord(parsed) && isRecord(parsed.actions))
      for (const action of Object.keys(parsed.actions)) names.add(action);
  }
  return names;
}

/**
 * One action manifest per scope, as the harness's own library discovery selects
 * them (`packages/recipe-cli/src/libraries.ts`): the `<scope>.action-manifest.json`
 * convention, with an `actions` entry replacing its scope's file.
 *
 * Dotfiles never match the convention, which is also why `digestRecipeLibrary`
 * skips them: a half-written `.scratch.json` is not part of the library and must
 * not block a publication.
 */
async function actionManifestFiles(
  root: string,
  manifest: RecipeLibraryManifest | undefined,
): Promise<string[]> {
  const byScope = new Map<string, string>();
  const manifests = path.join(root, 'manifests');
  let entries: Dirent[] = [];
  try {
    entries = await readdir(manifests, { withFileTypes: true });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  for (const entry of entries) {
    // Dotfiles are invisible to discovery, to the library walker and to the
    // digest, so a half-written `.web.action-manifest.json` left beside the real
    // one is not part of the library — and must not be parsed, or claimed as a
    // scope's manifest, by a check that runs after the digest already matched.
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const scope = ACTION_MANIFEST_FILE.exec(entry.name)?.[1];
    if (scope) byScope.set(scope, path.join(manifests, entry.name));
  }
  for (const [scope, file] of Object.entries(manifest?.actions ?? {}))
    byScope.set(scope, path.resolve(root, file));
  return [...byScope.values()];
}

export async function assertTaskActionInputsComplete(
  taskDir: string,
  summaries: readonly unknown[],
): Promise<void> {
  const actions = summaries.flatMap(taskActionInputReferences);
  if (!(await taskActionInputsAvailable(taskDir, actions)))
    throw new Error(
      `Cannot publish recipe: task-action implementation is missing for ${actions.flatMap(({ actionNames }) => actionNames).join(', ')} at ${TASK_DIRECTORY_LAYOUT.taskActions.relativePath}.`,
    );
}
