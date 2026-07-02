import * as busyComposer from './busy-composer.mjs';
import * as dispatchPromptMcpRace from './dispatch-prompt-mcp-race.mjs';
import * as dispatchPromptSmoke from './dispatch-prompt-smoke.mjs';
import * as hookSmoke from './hook-smoke.mjs';
import * as interactionSmoke from './interaction-smoke.mjs';
import * as modeSwitch from './mode-switch.mjs';
import * as paneSmoke from './pane-smoke.mjs';
import * as promptAccepted from './prompt-accepted.mjs';
import * as sessionAttributionSmoke from './session-attribution-smoke.mjs';
import * as tokenUsageSmoke from './token-usage-smoke.mjs';
import * as turnBoundary from './turn-boundary.mjs';

export const SCENARIOS = {
  'hook-smoke': hookSmoke,
  'pane-smoke': paneSmoke,
  'interaction-smoke': interactionSmoke,
  'dispatch-prompt-smoke': dispatchPromptSmoke,
  'dispatch-prompt-mcp-race': dispatchPromptMcpRace,
  'prompt-accepted': promptAccepted,
  'turn-boundary': turnBoundary,
  'busy-composer': busyComposer,
  'mode-switch': modeSwitch,
  'session-attribution-smoke': sessionAttributionSmoke,
  'token-usage-smoke': tokenUsageSmoke,
};

export function listScenarios() {
  return Object.keys(SCENARIOS);
}
