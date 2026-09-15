import * as budgetGuardSmoke from './budget-guard-smoke.mjs';
import * as busyComposer from './busy-composer.mjs';
import * as copilotRuntimeSmoke from './copilot-runtime-smoke.mjs';
import * as dispatchModelFlag from './dispatch-model-flag.mjs';
import * as dispatchPromptDroppedEnter from './dispatch-prompt-dropped-enter.mjs';
import * as dispatchPromptMcpRace from './dispatch-prompt-mcp-race.mjs';
import * as dispatchPromptSmoke from './dispatch-prompt-smoke.mjs';
import * as dispatchPromptTrust from './dispatch-prompt-trust.mjs';
import * as fleetDeviceContention from './fleet-device-contention.mjs';
import * as hookSmoke from './hook-smoke.mjs';
import * as hostPressureAdmissionOptin from './host-pressure-admission-optin.mjs';
import * as interactionSmoke from './interaction-smoke.mjs';
import * as machinePauseRestoreSmoke from './machine-pause-restore-smoke.mjs';
import * as modeSwitch from './mode-switch.mjs';
import * as monitorStuckSmoke from './monitor-stuck-smoke.mjs';
import * as nativeAdditionalProfiles from './native-additional-profiles.mjs';
import * as nativeAdditionalRunners from './native-additional-runners.mjs';
import * as nativeAdditionalUi from './native-additional-ui.mjs';
import * as nativeAstraDefaultUi from './native-astra-default-ui.mjs';
import * as nativeAuthRevocation from './native-auth-revocation.mjs';
import * as nativeAuthSession from './native-auth-session.mjs';
import * as nativeCopilotWorkspace from './native-copilot-workspace.mjs';
import * as nativeNodeBrokerSmoke from './native-node-broker-smoke.mjs';
import * as nativeNodeInventory from './native-node-inventory.mjs';
import * as nativeNodeOwnerAssignment from './native-node-owner-assignment.mjs';
import * as nativeOwnerIngress from './native-owner-ingress.mjs';
import * as nativeOwnerTransitionUi from './native-owner-transition-ui.mjs';
import * as nativeOwnerUi from './native-owner-ui.mjs';
import * as nativeOwnerWorkerDenial from './native-owner-worker-denial.mjs';
import * as nativePrimaryReviewReuse from './native-primary-review-reuse.mjs';
import * as nativeProcessCensus from './native-process-census.mjs';
import * as nativeProfileNodeCompatibility from './native-profile-node-compatibility.mjs';
import * as nativeProfileRefreshUi from './native-profile-refresh-ui.mjs';
import * as nativeProfileRetirement from './native-profile-retirement.mjs';
import * as nativeProfileSession from './native-profile-session.mjs';
import * as nativeProfileStaleReplyUi from './native-profile-stale-reply-ui.mjs';
import * as nativeProfileUi from './native-profile-ui.mjs';
import * as nativeRemoteWorker from './native-remote-worker.mjs';
import * as nativeReviewerRecovery from './native-reviewer-recovery.mjs';
import * as nativeSessionAuthorizationSmoke from './native-session-authorization-smoke.mjs';
import * as nativeSessionCleanupConfirmation from './native-session-cleanup-confirmation.mjs';
import * as nativeSessionCleanupIsolation from './native-session-cleanup-isolation.mjs';
import * as nativeSessionDurability from './native-session-durability.mjs';
import * as nativeSessionEnsure from './native-session-ensure.mjs';
import * as nativeSessionErrorSmoke from './native-session-error-smoke.mjs';
import * as nativeSessionSmoke from './native-session-smoke.mjs';
import * as nativeSessionStartupClose from './native-session-startup-close.mjs';
import * as nativeSoloWorker from './native-solo-worker.mjs';
import * as nativeWorkerAdmissionRaces from './native-worker-admission-races.mjs';
import * as nativeWorkerCrossSlotParking from './native-worker-cross-slot-parking.mjs';
import * as nativeWorkerDispatchReply from './native-worker-dispatch-reply.mjs';
import * as nativeWorkerHistoryUi from './native-worker-history-ui.mjs';
import * as nativeWorkerLifecycle from './native-worker-lifecycle.mjs';
import * as nativeWorkerMachineEnv from './native-worker-machine-env.mjs';
import * as nativeWorkerParking from './native-worker-parking.mjs';
import * as nativeWorkerProfile from './native-worker-profile.mjs';
import * as nativeWorkerProfileUi from './native-worker-profile-ui.mjs';
import * as nativeWorkerQueue from './native-worker-queue.mjs';
import * as nativeWorkerResumeReply from './native-worker-resume-reply.mjs';
import * as nativeWorkerReviewRecovery from './native-worker-review-recovery.mjs';
import * as nativeWorkerUiDispatch from './native-worker-ui-dispatch.mjs';
import * as nativeWorkspaceSmoke from './native-workspace-smoke.mjs';
import * as paneSmoke from './pane-smoke.mjs';
import * as piAstraIntelligence from './pi-astra-intelligence.mjs';
import * as promptAccepted from './prompt-accepted.mjs';
import * as resourcePostureSmoke from './resource-posture-smoke.mjs';
import * as retainedHandoffSmoke from './retained-handoff-smoke.mjs';
import * as retainedSafeSendSmoke from './retained-safe-send-smoke.mjs';
import * as reviewRecoveryTerminalContract from './review-recovery-terminal-contract.mjs';
import * as runnerStopProcessScan from './runner-stop-process-scan.mjs';
import * as selfReviewFixTurnLease from './self-review-fix-turn-lease.mjs';
import * as sessionAttributionSmoke from './session-attribution-smoke.mjs';
import * as sessionReopenSmoke from './session-reopen-smoke.mjs';
import * as terminalFenceRestart from './terminal-fence-restart.mjs';
import * as terminalOrderSmoke from './terminal-order-smoke.mjs';
import * as tokenUsageSmoke from './token-usage-smoke.mjs';
import * as turnBoundary from './turn-boundary.mjs';
import * as warmReplacementSmoke from './warm-replacement-smoke.mjs';
import * as workspaceReviewLifecycle from './workspace-review-lifecycle.mjs';

export const SCENARIOS = {
  [nativeAdditionalProfiles.SCENARIO_ID]: nativeAdditionalProfiles,
  'native-additional-runners': nativeAdditionalRunners,
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
  'runner-stop-process-scan': runnerStopProcessScan,
  'self-review-fix-turn-lease': selfReviewFixTurnLease,
  'retained-handoff-smoke': retainedHandoffSmoke,
  'retained-safe-send-smoke': retainedSafeSendSmoke,
  'resource-posture-smoke': resourcePostureSmoke,
  'fleet-device-contention': fleetDeviceContention,
  'host-pressure-admission-optin': hostPressureAdmissionOptin,
  'turn-boundary': turnBoundary,
  'busy-composer': busyComposer,
  'copilot-runtime-smoke': copilotRuntimeSmoke,
  'budget-guard-smoke': budgetGuardSmoke,
  'mode-switch': modeSwitch,
  'monitor-stuck-smoke': monitorStuckSmoke,
  'native-copilot-workspace': nativeCopilotWorkspace,
  'native-node-broker-smoke': nativeNodeBrokerSmoke,
  'native-node-inventory': nativeNodeInventory,
  'native-workspace-smoke': nativeWorkspaceSmoke,
  'workspace-review-lifecycle': workspaceReviewLifecycle,
  'native-worker-lifecycle': nativeWorkerLifecycle,
  [nativeWorkerProfile.SCENARIO_ID]: nativeWorkerProfile,
  [nativeWorkerProfileUi.SCENARIO_ID]: nativeWorkerProfileUi,
  'native-worker-admission-races': nativeWorkerAdmissionRaces,
  'native-solo-worker': nativeSoloWorker,
  'native-worker-machine-env': nativeWorkerMachineEnv,
  'native-worker-queue': nativeWorkerQueue,
  'native-remote-worker': nativeRemoteWorker,
  'native-auth-session': nativeAuthSession,
  'native-auth-revocation': nativeAuthRevocation,
  'native-worker-history-ui': nativeWorkerHistoryUi,
  'native-node-owner-assignment': nativeNodeOwnerAssignment,
  'native-owner-ingress': nativeOwnerIngress,
  [nativeAdditionalUi.SCENARIO_ID]: nativeAdditionalUi,
  [nativeAstraDefaultUi.SCENARIO_ID]: nativeAstraDefaultUi,
  [nativeOwnerTransitionUi.SCENARIO_ID]: nativeOwnerTransitionUi,
  'native-owner-worker-denial': nativeOwnerWorkerDenial,
  'native-owner-ui': nativeOwnerUi,
  'native-profile-session': nativeProfileSession,
  [nativeProfileStaleReplyUi.SCENARIO_ID]: nativeProfileStaleReplyUi,
  [nativeProfileRetirement.SCENARIO_ID]: nativeProfileRetirement,
  [nativeProfileRefreshUi.SCENARIO_ID]: nativeProfileRefreshUi,
  [nativeProfileNodeCompatibility.SCENARIO_ID]: nativeProfileNodeCompatibility,
  [nativeProfileUi.SCENARIO_ID]: nativeProfileUi,
  'pi-astra-intelligence': piAstraIntelligence,
  'native-worker-parking': nativeWorkerParking,
  'native-worker-cross-slot-parking': nativeWorkerCrossSlotParking,
  'native-process-census': nativeProcessCensus,
  'native-worker-ui-dispatch': nativeWorkerUiDispatch,
  'native-worker-review-recovery': nativeWorkerReviewRecovery,
  'native-reviewer-recovery': nativeReviewerRecovery,
  'native-worker-resume-reply': nativeWorkerResumeReply,
  'native-primary-review-reuse': nativePrimaryReviewReuse,
  'native-worker-dispatch-reply': nativeWorkerDispatchReply,
  'native-session-durability': nativeSessionDurability,
  'native-session-error-smoke': nativeSessionErrorSmoke,
  'native-session-ensure': nativeSessionEnsure,
  'native-session-cleanup-isolation': nativeSessionCleanupIsolation,
  [nativeSessionCleanupConfirmation.SCENARIO_ID]: nativeSessionCleanupConfirmation,
  'native-session-smoke': nativeSessionSmoke,
  'native-session-authorization-smoke': nativeSessionAuthorizationSmoke,
  'native-session-startup-close': nativeSessionStartupClose,
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
