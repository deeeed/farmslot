export async function notifyNightlyFailure(github, context) {
  const title = 'CI: nightly parity audit failed';
  const url = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  const body = `The nightly monolithic parity audit failed.\n\nRun: ${url}\nCommit: ${context.sha}\n\nThe workflow remains red. Check the failing job and repair parity before relying on the next audit.`;
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...context.repo,
    state: 'open',
    per_page: 100,
  });
  const existing = issues.find((issue) => !issue.pull_request && issue.title === title);
  if (existing)
    return github.rest.issues.createComment({
      ...context.repo,
      issue_number: existing.number,
      body,
    });
  return github.rest.issues.create({ ...context.repo, title, body });
}
