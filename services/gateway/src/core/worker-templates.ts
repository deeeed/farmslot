import path from 'node:path';

import { projectPackRoot } from '@farmslot/slot-config';

import { farmslotRoot } from './config.js';

/** Gateway reads template bytes from the run's pack; legacy work keeps its original root. */
export async function projectWorkerTemplatePath(project: string, name: string): Promise<string> {
  return path.join(
    await projectPackRoot(project, path.join(farmslotRoot, 'projects', project)),
    'templates',
    'worker',
    name,
  );
}
