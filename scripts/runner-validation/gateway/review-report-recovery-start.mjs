// Mirror the gateway signal validator’s transport-specific accepted timestamp.
// Keep this proof helper in sync if the gateway adds another transport.
export function acceptedReviewStartAt(run) {
  const context = run.agentContexts?.find((candidate) => candidate.id === 'review');
  return run.transport === 'tmux'
    ? context?.promptDeliveryStartedAt
    : context?.nativeSession?.acceptedAt;
}
