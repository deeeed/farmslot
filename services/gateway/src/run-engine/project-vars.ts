import { loadProjectVars } from '../core/config.js';

type LoadedProjectVars = Awaited<ReturnType<typeof loadProjectVars>>;

export async function loadProjectVarsOrNull(
  project: string,
  context: string,
  runId?: string,
): Promise<LoadedProjectVars | null> {
  try {
    return await loadProjectVars(project);
  } catch (err) {
    const runLabel = runId ? ` run ${runId.slice(0, 8)}` : '';
    console.warn(
      `[run-engine] ${context} project config unavailable for ${project}${runLabel}: ${(err as Error).message.slice(0, 200)}`,
    );
    return null;
  }
}
