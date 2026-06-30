import { resolveRunCreateMode, type RunCreateParams } from '@farmslot/protocol';

import { loadProjectVars } from '../core/config.js';
import { listWorkerTemplateOptions } from '../tasks/worker-template-options.js';

/** Apply dispatch-wizard mode defaults when CLI/API omit `mode`. */
export async function normalizeRunCreateMode(params: RunCreateParams): Promise<void> {
  if (params.mode) return;
  const projectVars = await loadProjectVars(params.project);
  const templateOptions = await listWorkerTemplateOptions(projectVars, params.flowType);
  params.mode = resolveRunCreateMode({
    flowType: params.flowType,
    taskTemplateFileName: params.taskTemplate?.fileName,
    templateOptions,
  });
}
