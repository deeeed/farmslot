import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { isRecord, TASK_DIRECTORY_LAYOUT, type TaskActionInputLibrary } from '@farmslot/protocol';
import { digestRecipeLibrary, readRecipeLibraryManifest } from '@farmslot/recipe-runner';

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

/** Every action name the retained library's own action manifests declare. */
async function declaredTaskActionNames(root: string): Promise<Set<string>> {
  const manifest = await readRecipeLibraryManifest(root);
  const declaredFiles = Object.values(manifest?.actions ?? {});
  const files = declaredFiles.length
    ? declaredFiles.map((file) => path.join(root, file))
    : await actionManifestFiles(root);
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

/** Convention fallback for a library with no `recipe-library.json` actions map. */
async function actionManifestFiles(root: string): Promise<string[]> {
  const manifests = path.join(root, 'manifests');
  try {
    return (await readdir(manifests, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(manifests, entry.name));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
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
