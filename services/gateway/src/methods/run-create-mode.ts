import {
  catalogDefaultRunMode,
  type ProjectConfig,
  resolveRunCreateMode,
  type RunCreateParams,
} from '@farmslot/protocol';

import { loadProjectVars } from '../core/config.js';
import { listWorkerTemplateOptions } from '../tasks/worker-template-options.js';

/** Apply dispatch-wizard mode defaults when CLI/API omit `mode`. */
export async function normalizeRunCreateMode(
  params: RunCreateParams,
  projectConfig: ProjectConfig | null,
): Promise<void> {
  if (params.mode) return;
  // Mode refinement reads the project's worker templates. A project with no config
  // on disk (example/test projects) has no templates to consult, so leave mode unset
  // and let downstream resolution proceed as before — the dispatch wizard likewise
  // can't pick a mode without templates. Real dispatch always has a config, and
  // runCreate already passes the same nullable config it loaded once.
  if (!projectConfig) return;
  const projectVars = await loadProjectVars(params.project);
  // A catalog project selects its checklist from `execution_templates.defaults`,
  // so the same rules decide the omitted mode; the worker template files may be
  // gone once a flow runs on a shared checklist. An explicit task template still
  // decides below.
  const catalogDefaults = projectVars.projectJson.execution_templates?.defaults;
  if (catalogDefaults && !params.taskTemplate?.fileName) {
    const catalogMode = catalogDefaultRunMode(params.flowType, catalogDefaults);
    if (catalogMode) {
      params.mode = catalogMode;
      return;
    }
  }
  const templateOptions = await listWorkerTemplateOptions(projectVars, params.flowType);
  params.mode = resolveRunCreateMode({
    flowType: params.flowType,
    taskTemplateFileName: params.taskTemplate?.fileName,
    templateOptions,
  });
}
