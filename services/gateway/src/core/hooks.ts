// core/hooks.ts — extraction shim. Hook/template expansion moved to
// @farmslot/slot-config (see core/config.ts shim for rationale).
export * from '@farmslot/slot-config';

import {
  assertNoUnknownPlaceholders,
  collectPlaceholderTokens,
  renderTemplatePlaceholders,
} from '@farmslot/protocol';
import {
  expandTemplateWithReservedLast as expandReservedTemplate,
  knownTemplatePlaceholders,
} from '@farmslot/slot-config';

/** Role templates use the same part renderer as task init, preserving opaque values. */
export const expandTemplateWithReservedLast: typeof expandReservedTemplate = (
  template,
  vars,
  projectVars,
  reserved,
) => {
  if (!template.includes('{{CI_PARITY_STEP}}')) {
    return expandReservedTemplate(template, vars, projectVars, reserved);
  }
  assertNoUnknownPlaceholders(
    template,
    [...knownTemplatePlaceholders(vars, projectVars), ...Object.keys(reserved)],
    'Role template',
  );
  const values = Object.fromEntries(
    [...collectPlaceholderTokens(template)]
      .filter((token) => token !== '{{CI_PARITY_STEP}}')
      .map((token) => [
        token.slice(2, -2),
        expandReservedTemplate(token, vars, projectVars, reserved),
      ]),
  );
  const ci = projectVars?.projectJson.ci as { local_check?: string } | undefined;
  return renderTemplatePlaceholders(
    template,
    {
      ...values,
      TASK_DIR: expandReservedTemplate('{{TASK_DIR}}', vars, projectVars, reserved),
      'ci.local_check': ci?.local_check ?? '',
      CI_PARITY_CHECKLIST: reserved.CI_PARITY_CHECKLIST ?? '',
    },
    'Role template',
  );
};
