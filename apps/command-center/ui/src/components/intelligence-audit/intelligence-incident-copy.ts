import type { IntelligenceAction } from '@farmslot/protocol';

export function categoryToTrigger(record: IntelligenceAction): string {
  const cat = record.verdict.category;
  const pattern = record.verdict.patternId;
  if (record.verdict.rationale) return record.verdict.rationale;
  if (pattern === 'worker-idle') return 'Monitor detected idle worker during active session';
  if (pattern === 'worker-waiting') return 'Monitor detected worker waiting for input';
  if (pattern === 'worker-stale') return 'Monitor detected stale worker output';
  if (pattern === 'worker-error') return 'Monitor detected worker error state';
  if (cat === 'flake') return 'Transient/flaky failure detected';
  if (cat === 'infra') return 'Infrastructure failure detected';
  if (cat === 'env-drift') return 'Environment drift detected';
  if (cat === 'timeout' && record.actor === 'auto-nudge') {
    return 'Monitor idle/stale signal (not a pipeline step timeout)';
  }
  if (cat === 'timeout') return 'Step timed out';
  if (pattern) return `Pattern matched: ${pattern}`;
  return 'Monitor signal triggered';
}

export function actionToHuman(record: IntelligenceAction): string {
  const action = record.appliedAction;
  if (!action) {
    if (record.outcome === 'skipped') {
      return record.outcomeReason ? `No action taken — ${record.outcomeReason}` : 'No action taken';
    }
    return 'Decision recorded; no action proposed';
  }
  switch (action.type) {
    case 'tmux.send':
      if (record.outcome === 'skipped') {
        return 'Proposed tmux nudge (not applied)';
      }
      if (record.outcome === 'proposed') {
        return `Would send ${action.tmuxKeys ? `\`${action.tmuxKeys}\`` : 'keys'} to tmux pane${
          action.stepName ? ` (step: ${action.stepName})` : ''
        }`;
      }
      return `Sent ${action.tmuxKeys ? `\`${action.tmuxKeys}\`` : 'keys'} to tmux pane${
        action.stepName ? ` (step: ${action.stepName})` : ''
      }`;
    case 'run.replayStep':
      if (record.outcome === 'skipped') {
        return `Proposed replay of step \`${action.stepName ?? '?'}\` (not applied)`;
      }
      return `Replayed step \`${action.stepName ?? '?'}\``;
    case 'slot.reset':
      return record.outcome === 'applied'
        ? 'Reset slot to clean state'
        : 'Proposed slot reset (not applied)';
    case 'slot.cleanupProcesses':
      return record.outcome === 'applied'
        ? 'Cleaned up stale processes on slot'
        : 'Proposed process cleanup (not applied)';
    case 'slot.fixtureRefresh':
      return record.outcome === 'applied'
        ? 'Refreshed fixtures on slot'
        : 'Proposed fixture refresh (not applied)';
    default:
      return action.type;
  }
}
