import { reviewPublicationPolicyForRun, type Run } from '@farmslot/protocol';

export function reviewPublicationView(run: Run) {
  const policy = reviewPublicationPolicyForRun(run);
  const receipt = run.reviewPublication?.receipt;
  if (!policy && !receipt) return null;
  const published = receipt?.state === 'published';
  return {
    label: published
      ? 'Published to PR'
      : policy?.enabled
        ? 'Publish review to PR'
        : 'Farmslot results only',
    source: policy?.source,
    account: receipt?.account.login ?? policy?.account?.login,
    state: receipt?.state,
    url: published ? receipt.url : undefined,
    error: published ? undefined : run.reviewPublication?.error,
    canRetry: run.status === 'done' && policy?.enabled === true && !published,
  };
}

/** Equal-timestamp run.list projections must not replace full historical payloads. */
export function reviewRunForDisplay(run: Run | null, stored: Run | undefined): Run | null {
  if (!run || !stored || stored.id !== run.id || stored.updatedAt < run.updatedAt) return run;
  if (
    stored.updatedAt === run.updatedAt &&
    stored.decisions.some((decision) => decision.payloadTrimmed?.length)
  )
    return run;
  return stored;
}
