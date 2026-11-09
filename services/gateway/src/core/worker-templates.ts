import path from 'node:path';

import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { projectPackRoot } from '@farmslot/slot-config';

/** Gateway reads template bytes from the run's pack; legacy work keeps its original root. */
export async function projectWorkerTemplatePath(project: string, name: string): Promise<string> {
  return path.join(
    await projectPackRoot(
      project,
      path.join(currentFarmPaths('gateway').templateProjects, project),
    ),
    'templates',
    'worker',
    name,
  );
}
