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
