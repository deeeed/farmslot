import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** Gateway-written run task folders inside a project directory; never pack content. */
export const ORCHESTRATOR_TASK_DIR = 'tasks';

/** A Farmslot root's projects dir: `FARMSLOT_PROJECTS_DIR`, else `<root>/projects`. */
export function resolveProjectsDir(
  farmslotRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.FARMSLOT_PROJECTS_DIR
    ? path.resolve(env.FARMSLOT_PROJECTS_DIR)
    : path.join(farmslotRoot, 'projects');
}

export interface FarmLayout {
  farmslotRoot: string;
  /** Resolved with resolveProjectsDir. */
  projectsDir: string;
}

/**
 * Where the gateway keeps a project's run task folders. Mock-mode projects keep them in the
 * root's `.sandbox`, which a projects dir override never moves.
 */
export function orchestratorTaskRoot(
  layout: FarmLayout,
  projectName: string,
  mockMode = false,
): string {
  return mockMode
    ? path.join(layout.farmslotRoot, '.sandbox', projectName, ORCHESTRATOR_TASK_DIR)
    : path.join(layout.projectsDir, projectName, ORCHESTRATOR_TASK_DIR);
}

export interface ProjectTaskRoot {
  project: string;
  root: string;
}

/**
 * The task root of every project dir in the projects dir, linked ones included; files are
 * skipped and a missing projects dir has none. These are non-mock roots: mock-mode projects
 * keep theirs under `<root>/.sandbox`.
 */
export async function listProjectTaskRoots(layout: FarmLayout): Promise<ProjectTaskRoot[]> {
  let entries;
  try {
    entries = await readdir(layout.projectsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const roots: ProjectTaskRoot[] = [];
  for (const entry of entries) {
    const isDir =
      entry.isDirectory() ||
      (entry.isSymbolicLink() &&
        (await linkTarget(path.join(layout.projectsDir, entry.name)))?.isDirectory());
    if (isDir) roots.push({ project: entry.name, root: orchestratorTaskRoot(layout, entry.name) });
  }
  return roots;
}

/** A link's target, or null when the link dangles. */
async function linkTarget(link: string) {
  try {
    return await stat(link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
