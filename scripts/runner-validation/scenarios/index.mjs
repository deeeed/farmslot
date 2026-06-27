import * as busyComposer from './busy-composer.mjs';
import * as hookSmoke from './hook-smoke.mjs';
import * as modeSwitch from './mode-switch.mjs';
import * as promptAccepted from './prompt-accepted.mjs';
import * as turnBoundary from './turn-boundary.mjs';

export const SCENARIOS = {
  'hook-smoke': hookSmoke,
  'prompt-accepted': promptAccepted,
  'turn-boundary': turnBoundary,
  'busy-composer': busyComposer,
  'mode-switch': modeSwitch,
};

export function listScenarios() {
  return Object.keys(SCENARIOS);
}