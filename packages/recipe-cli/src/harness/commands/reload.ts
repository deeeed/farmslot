// reload — reload the connected app runtime through the platform's `reload`.

import { adapterDetectNext, harnessAdapter, undetectedAdapterMessage } from '../adapters.js';
import { harnessHost } from '../host.js';
import { flag, parseFlags, resolveFlagsAdapter, targetOf, usageOut } from '../shared.js';

const RELOAD_BOOLEANS = new Set(['json']);

export async function handleReload(argv: string[]): Promise<number> {
  const { options } = parseFlags(argv, RELOAD_BOOLEANS);
  const json = flag(options, 'json');
  const target = targetOf(options);
  const adapter = resolveFlagsAdapter(options, target);
  if (!adapter) {
    return usageOut(json, 'reload', undetectedAdapterMessage(target), adapterDetectNext());
  }
  const surface = harnessAdapter(adapter);
  if (surface.headless) {
    return usageOut(
      json,
      'reload',
      `${adapter} is headless; there is no app runtime to reload.`,
      `${harnessHost().name} run <${adapter}-recipe>`,
    );
  }
  if (!surface.reload) {
    return usageOut(
      json,
      'reload',
      `reload does not support the ${adapter} adapter.`,
      surface.hints.launch,
    );
  }

  surface.resolveSlotPorts(target);
  return surface.reload(target, json);
}
