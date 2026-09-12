import assert from 'node:assert/strict';

import { createCopilotRunnerVars } from '../../../services/gateway/src/copilot-runtime/launcher.js';
import { getRunnerObservability } from '../../../services/gateway/src/runners/registry.js';

// Read the same native signals as delivery, including on gateways without a node daemon.
const { checkout, runner, target, sinceMs, timeoutMs } = JSON.parse(process.argv[2]);
assert.ok(typeof checkout === 'string' && typeof target === 'string');
assert.ok(Number.isSafeInteger(sinceMs) && Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
const vars = createCopilotRunnerVars(checkout);
const observer = getRunnerObservability(runner);
assert.ok(observer, 'Runner has no structured observability');
const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  const [activity, completed] = await Promise.all([
    observer.getActivity(vars, target),
    observer.lastTurnCompletedAt(vars, target),
  ]);
  if (
    activity?.value === 'idle' &&
    activity.confidence === 'high' &&
    completed?.confidence === 'high' &&
    completed.value >= sinceMs
  ) {
    console.log(JSON.stringify({ activity, completed }));
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
throw new Error('Timed out waiting for native completion and idle on the Co-Pilot pane');
