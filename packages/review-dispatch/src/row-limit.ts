import type { ReviewValidationOptions } from './types.js';

/** PR execution alternatives retain the protocol's 20-model capacity. */
export function sequenceMaximumRows(options: ReviewValidationOptions): number {
  const limit =
    options.allowSequence === false
      ? 1
      : options.sequenceRole === 'execution-alternatives'
        ? 20
        : 5;
  return Math.min(options.maxRows ?? limit, limit);
}
