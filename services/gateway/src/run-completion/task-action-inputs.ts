import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
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

/** False is only a missing root. An existing but changed/partial input is a hard failure. */
export async function taskActionInputsAvailable(
  taskDir: string,
  actions: readonly TaskActionInputLibrary[],
): Promise<boolean> {
  if (!actions.length) return true;
  const root = path.join(taskDir, TASK_DIRECTORY_LAYOUT.taskActions.relativePath);
  const names = [...new Set(actions.flatMap(({ actionNames }) => actionNames))].join(', ');
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
  const expected = new Set(actions.map(({ expectedLibraryDigest }) => expectedLibraryDigest));
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
  return true;
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
