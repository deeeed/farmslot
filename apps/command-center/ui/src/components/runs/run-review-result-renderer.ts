import { html, nothing } from 'lit';

import { parseGitHubRef, reviewResultForRun, type Run } from '@farmslot/protocol';

import '../progress-tracker/progress-tracker.js';

import type { RunEvidenceRenderContext } from './run-detail-renderers.js';

/** Optional explanation backed by the run's frozen inputs and existing progress/artifact viewers. */
export function renderReviewProcess(run: Run, ctx: RunEvidenceRenderContext) {
  const result = reviewResultForRun(run);
  const checklist = (result?.artifactManifest ?? []).filter((artifact) =>
    /(?:^|\/)review-checklist\.(?:md|json)$/.test(artifact.path),
  );
  const artifacts = checklist.map((artifact) => ({
    ...artifact,
    runId: run.id,
    familyId: run.familyId,
    source: 'artifact-manifest' as const,
  }));
  const current = run.steps.find((step) => step.status === 'running');
  const labels: Record<string, string> = {
    'find-slot': 'Allocate worktree and freeze the PR revision',
    'write-task': 'Prepare instructions and skills',
    prepare: 'Static review needs no app preparation',
    dispatch: 'Start reviewer',
    monitor: 'Inspect code and record findings',
    'human-gate': 'Wait for the publication decision',
    complete: 'Save the result and clean up',
  };
  return html`<details class="evidence-card" data-testid="review-process">
    <summary>
      Review process ·
      ${current
        ? (labels[current.name] ?? current.name)
        : run.status === 'done'
          ? 'Complete'
          : run.status}
    </summary>
    <p>
      Freeze the PR revision, apply the selected review skill, and save findings.
      ${run.reviewAutoFinish || run.prWork?.review?.options.autoFinish
        ? 'Automatic finish is enabled.'
        : 'Publication waits for your decision.'}
      Runtime validation belongs to QA.
    </p>
    <p>
      Revision: <code>${run.reviewWorkspaceSubject?.headSha?.slice(0, 12) ?? 'pending'}</code> ·
      Skills:
      ${run.reviewWorkspace?.support?.skills.map((skill) => skill.name).join(', ') ||
      'Project review instructions'}
    </p>
    <div class="evidence-title">Task progress</div>
    ${ctx.taskProgress
      ? html`<progress-tracker .structured=${ctx.taskProgress}></progress-tracker>`
      : html`<p>Waiting for task progress.</p>`}
    <p>
      The task checklist tracks the overall work. The detailed review checklist records what was
      inspected; checked items can still have findings.
    </p>
    ${artifacts.length
      ? html`<step-artifacts
          stepName="Detailed review checklist"
          status="done"
          default-open
          .artifacts=${artifacts}
          .artifactUrl=${ctx.artifactUrl}
          @step-artifact-click=${ctx.onEvidenceArtifactClick}
        ></step-artifacts>`
      : html`<p>The detailed checklist will be available with the saved review.</p>`}
  </details>`;
}

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
