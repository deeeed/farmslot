import * as budgetGuardSmoke from './budget-guard-smoke.mjs';
import * as busyComposer from './busy-composer.mjs';
import * as copilotRuntimeSmoke from './copilot-runtime-smoke.mjs';
import * as dispatchModelFlag from './dispatch-model-flag.mjs';
import * as dispatchPromptDroppedEnter from './dispatch-prompt-dropped-enter.mjs';
import * as dispatchPromptMcpRace from './dispatch-prompt-mcp-race.mjs';
import * as dispatchPromptSmoke from './dispatch-prompt-smoke.mjs';
import * as dispatchPromptTrust from './dispatch-prompt-trust.mjs';
import * as hookSmoke from './hook-smoke.mjs';
import * as interactionSmoke from './interaction-smoke.mjs';
import * as machinePauseRestoreSmoke from './machine-pause-restore-smoke.mjs';
import * as modeSwitch from './mode-switch.mjs';
import * as monitorStuckSmoke from './monitor-stuck-smoke.mjs';
import * as paneSmoke from './pane-smoke.mjs';
import * as promptAccepted from './prompt-accepted.mjs';
import * as resourcePostureSmoke from './resource-posture-smoke.mjs';
import * as retainedHandoffSmoke from './retained-handoff-smoke.mjs';
import * as retainedSafeSendSmoke from './retained-safe-send-smoke.mjs';
import * as reviewRecoveryTerminalContract from './review-recovery-terminal-contract.mjs';
import * as selfReviewFixTurnLease from './self-review-fix-turn-lease.mjs';
import * as sessionAttributionSmoke from './session-attribution-smoke.mjs';
import * as sessionReopenSmoke from './session-reopen-smoke.mjs';
import * as terminalFenceRestart from './terminal-fence-restart.mjs';
import * as terminalOrderSmoke from './terminal-order-smoke.mjs';
import * as tokenUsageSmoke from './token-usage-smoke.mjs';
import * as turnBoundary from './turn-boundary.mjs';
import * as warmReplacementSmoke from './warm-replacement-smoke.mjs';

export const SCENARIOS = {
  'hook-smoke': hookSmoke,
  'pane-smoke': paneSmoke,
  'interaction-smoke': interactionSmoke,
  'machine-pause-restore-smoke': machinePauseRestoreSmoke,
  'dispatch-model-flag': dispatchModelFlag,
  'dispatch-prompt-smoke': dispatchPromptSmoke,
  'dispatch-prompt-dropped-enter': dispatchPromptDroppedEnter,
  'dispatch-prompt-mcp-race': dispatchPromptMcpRace,
  'dispatch-prompt-trust': dispatchPromptTrust,
  'prompt-accepted': promptAccepted,
  'review-recovery-terminal-contract': reviewRecoveryTerminalContract,
  'self-review-fix-turn-lease': selfReviewFixTurnLease,
  'retained-handoff-smoke': retainedHandoffSmoke,
  'retained-safe-send-smoke': retainedSafeSendSmoke,
  'resource-posture-smoke': resourcePostureSmoke,
  'turn-boundary': turnBoundary,
  'busy-composer': busyComposer,
  'copilot-runtime-smoke': copilotRuntimeSmoke,
  'budget-guard-smoke': budgetGuardSmoke,
  'mode-switch': modeSwitch,
  'monitor-stuck-smoke': monitorStuckSmoke,
  'session-attribution-smoke': sessionAttributionSmoke,
  'session-reopen-smoke': sessionReopenSmoke,
  'terminal-order-smoke': terminalOrderSmoke,
  'terminal-fence-restart': terminalFenceRestart,
  'token-usage-smoke': tokenUsageSmoke,
  'warm-replacement-smoke': warmReplacementSmoke,
};

export function listScenarios() {
  return Object.keys(SCENARIOS);
}
