import { withNativeProcessCensusMeasure } from '@farmslot/agent-runtime/native/process-tree';

import {
  measureManagedOperation,
  registerHostOperations,
  withHostOperation,
} from '../observability/performance.js';

const operation = 'nativeProcess.census';
registerHostOperations([operation]);

/** Local account probes start native children here; native supervisor processes own their own reads. */
export function withMeasuredNativeProcessCensus<T>(run: () => T): T {
  return withHostOperation(operation, () =>
    withNativeProcessCensusMeasure((read) => measureManagedOperation('exec', 'other', read), run),
  );
}
