// core/hooks.ts — extraction shim. Hook/template expansion moved to
// @farmslot/slot-config (see core/config.ts shim for rationale).
export * from '@farmslot/slot-config';

import {
  currentProjectSources,
  expandSourceBindings,
  expandTemplateWithReservedLast as expandReservedTemplate,
} from '@farmslot/slot-config';

/** Role templates use the same part renderer as task init, preserving opaque values. */
export const expandTemplateWithReservedLast: typeof expandReservedTemplate = (
  template,
  vars,
  projectVars,
  reserved,
  extraVars,
) => {
  template = expandSourceBindings(template, currentProjectSources() ?? projectVars?.sourceContext);
  return expandReservedTemplate(
    template.replace(/^[ \t]*\{\{CI_PARITY_STEP\}\}|\{\{CI_PARITY_STEP\}\}/gm, ''),
    vars,
    projectVars,
    reserved,
    extraVars,
  );
};
