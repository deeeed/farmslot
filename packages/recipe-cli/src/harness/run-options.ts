// The options of one recipe run (`run`, `call`) from the command line: ports,
// slot, video, HUD, trust input, and what the platform adds.
import type { RecipeRunOptions } from '@farmslot/adapter-sdk';

import { harnessAdapter } from './adapters.js';
import { type CliOptions, optionString } from './parse-args.js';
import { explicitRecipeTrustOptions } from './trust.js';

export function recipeTrustOptionsFromCli(
  options: CliOptions,
): ReturnType<typeof explicitRecipeTrustOptions> {
  return explicitRecipeTrustOptions({
    sourceTrust: optionString(options, 'sourceTrust'),
    sourceKind: optionString(options, 'sourceKind'),
    sourceName: optionString(options, 'sourceName'),
    sourceDigest: optionString(options, 'sourceDigest'),
    approvalDigest: optionString(options, 'approvePlan'),
  });
}

export function recipeRunOptionsFromCli(adapter: string, options: CliOptions): RecipeRunOptions {
  const recordVideo = options.recordVideo;
  const hud = optionString(options, 'hud');
  const platform = harnessAdapter(adapter).run?.platformOptions?.(options);
  return {
    cdpPort: optionString(options, 'cdpPort'),
    watcherPort: optionString(options, 'watcherPort'),
    slot: optionString(options, 'slot'),
    validationRuntimeDir: optionString(options, 'validationRuntimeDir'),
    recordVideo: recordVideo === 'full-run' ? 'full-run' : false,
    autoHud: hud === 'show' ? true : hud === 'hide' ? false : undefined,
    ...(platform ? { platform } : {}),
    ...recipeTrustOptionsFromCli(options),
  };
}
