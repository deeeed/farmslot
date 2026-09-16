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
