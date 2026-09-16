import { html, nothing } from 'lit';

import { parseGitHubRef, reviewResultForRun, type Run } from '@farmslot/protocol';

/** Saved evidence remains readable after its worker and checkout are released. */
export function renderRunReviewResult(run: Run, openGate: () => void, disabled: boolean) {
  const result = reviewResultForRun(run);
  if (!result) return nothing;
  const pending = run.decisions.some(
    (decision) => decision.type === 'engine_review_posting' && !decision.resolvedAt,
  );
  if (pending) return nothing; // The shared publish gate already displays the full report.
  const published = run.reviewPublication?.receipt?.state === 'published';
  return html`
    <section class="review-result" data-testid="run-review-result">
      <div class="review-publication">
        <strong>Review outcome: ${result.recommendation}</strong>
        <span>${published ? 'Published to PR' : 'Not published to PR'}</span>
        ${result.reviewSnapshot?.headSha
          ? html`<span title=${result.reviewSnapshot.headSha}
              >Reviewed ${result.reviewSnapshot.headSha.slice(0, 8)}</span
            >`
          : nothing}
        ${run.reviewWorkspace && run.status === 'done' && !published
          ? html`<button ?disabled=${disabled} @click=${openGate}>Review and publish…</button>`
          : nothing}
      </div>
      <review-workspace
        .runId=${run.id}
        .readOnly=${true}
        .workspaceView=${Boolean(run.reviewWorkspace)}
        .decision=${{
          id: `saved-${run.id}`,
          type: 'engine_review_posting',
          title: 'Saved review',
          description: '',
          actions: [],
          createdAt: run.createdAt,
          payload: {
            kind: 'review',
            ...result,
            prNumber: run.prNumber,
            repo: parseGitHubRef(run.ticketOrPr)?.repo ?? null,
          },
        }}
      ></review-workspace>
    </section>
  `;
}
