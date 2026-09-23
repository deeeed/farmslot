// Use the same accepted worker timestamp as the static-review signal validator.
export function acceptedReviewStartAt(run) {
  const context = run.agentContexts?.find((candidate) => candidate.id === 'review');
  return run.transport === 'tmux'
    ? context?.promptDeliveryStartedAt
    : context?.nativeSession?.acceptedAt;
}
