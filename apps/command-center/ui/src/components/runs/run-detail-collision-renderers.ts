import DOMPurify from 'dompurify';
import { html, nothing } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { marked } from 'marked';

import type {
  CollisionPayload,
  ReviewContinuationPayload,
  Run,
  RunDecision,
} from '@farmslot/protocol';

import './run-pipeline-mini.js';

import { colors } from '../../styles/theme-tokens.js';

import { runStatusColor } from './run-utils.js';

/** Render relative time ("5m ago"). Hoisted to module scope so the closure is
 * not rebuilt on every render of the collision panel. */
export function formatRelativeFromNow(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function collisionLastStepLabel(run: Run): string {
  // Surface where the run stopped: failed > running > last done > created.
  // Single linear walk: failed/running short-circuit immediately; otherwise
  // track the last done step seen. Cheaper than three Array.find passes when
  // many prior runs are rendered.
  // Defensive `?? []` — hydration edge cases (mid-recovery snapshots) have
  // shipped Run records without a steps array.
  let lastDone: string | null = null;
  for (const step of run.steps ?? []) {
    if (step.status === 'failed') return `failed at ${step.name}`;
    if (step.status === 'running') return `running ${step.name}`;
    if (step.status === 'done') lastDone = step.name;
  }
  return lastDone != null ? `last: ${lastDone}` : 'not started';
}

export function resolveCollisionDirOwners(
  payload: CollisionPayload,
  runs: readonly Run[],
  currentProject: string,
): Map<string, Run> {
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const dirToRun = new Map<string, Run>();
  if (payload.dirOwners) {
    for (const [dir, runId] of Object.entries(payload.dirOwners)) {
      const owner = runsById.get(runId);
      if (owner) dirToRun.set(dir, owner);
    }
    return dirToRun;
  }

  // Sort newest-first to match the gateway-resolved dirOwners contract
  // (handleCollisionDecision sorts candidates by createdAt desc). Without
  // this, fallback chip links would pick whichever same-dir run state happens
  // to surface first in the un-sorted runs array.
  const dirsSet = new Set(payload.existingDirs);
  const sorted = [...runs]
    .filter((run) => run.project === currentProject && run.taskFile != null)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  for (const run of sorted) {
    for (const dir of dirsSet) {
      if (dirToRun.has(dir)) continue;
      // No inner break — one run that owns several colliding dirs (rare but
      // possible) should claim all of them, matching the gateway's
      // handleCollisionDecision dirOwners builder.
      if (run.taskFile?.includes(`/${dir}/`)) dirToRun.set(dir, run);
    }
    if (dirToRun.size === dirsSet.size) break;
  }
  return dirToRun;
}

export function renderCollisionDescription(
  decision: RunDecision,
  currentProject: string,
  runs: readonly Run[],
) {
  const payload = decision.payload as CollisionPayload | undefined;
  if (!payload) {
    return html`
      <div class="gate-description md-body">
        ${unsafeHTML(
          DOMPurify.sanitize(marked.parse(decision.description ?? '', { async: false }) as string),
        )}
      </div>
    `;
  }
  // Prefer the gateway-resolved dirOwners (project-scoped, race-free) when
  // present; fall back to a state-side lookup for legacy decisions persisted
  // before dirOwners shipped. The fallback is also project-scoped: without it,
  // two projects with the same task-dir slug schema could let a foreign-project
  // run claim a chip link.
  const dirToRun = resolveCollisionDirOwners(payload, runs, currentProject);
  return html`
    <div class="cdesc-line">
      Task dir collision for <span class="cdesc-slug">${payload.ticketSlug}</span>:
      ${payload.existingDirs.map((dir, index) => {
        const owner = dirToRun.get(dir);
        return html`${index > 0 ? html`, ` : nothing}${owner
          ? html`<a
              class="cdesc-dir"
              href=${`#run/${owner.id}`}
              title="Open prior run ${owner.id.slice(0, 8)}"
              >${dir}</a
            >`
          : html`<span class="cdesc-dir unlinked" title="No matching run found in current state"
              >${dir}</span
            >`}`;
      })}
    </div>
  `;
}

export function renderCollisionPriorRuns(decision: RunDecision, runs: readonly Run[]) {
  const payload = decision.payload as CollisionPayload | undefined;
  const priorIds = payload?.priorRunIds ?? [];
  if (priorIds.length === 0) {
    return html`
      <div style="font-size:11px;color:${colors.textMuted};padding:6px 0 10px">
        No prior runs resolved for ${payload?.existingDirs.join(', ') ?? 'colliding dirs'} — they
        may have been pruned. Pick an action below.
      </div>
    `;
  }
  // O(N) build of id→run map so resolving M priorIds stays linear in M instead
  // of O(N*M) for each render of the panel.
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const priorRuns = priorIds.map((id) => runsById.get(id)).filter((run): run is Run => !!run);
  const missingCount = priorIds.length - priorRuns.length;

  return html`
    <div class="cpr-wrap">
      <div class="cpr-label">
        ${priorRuns.length} prior run${priorRuns.length === 1 ? '' : 's'} on this ticket — click one
        to navigate there and retry from its existing controls:
      </div>
      ${priorRuns.map((run) => {
        const runner = run.metrics?.runner ?? '';
        const model = run.metrics?.model ?? '';
        const runnerModel = [runner, model].filter(Boolean).join('/');
        const updatedTs = run.updatedAt ?? run.completedAt ?? run.createdAt;
        const stepLabel = collisionLastStepLabel(run);
        const isFailedStep = stepLabel.startsWith('failed');
        return html`
          <a class="cpr-row" href=${`#run/${run.id}`}>
            <span class="cpr-status" style="color:${runStatusColor(run.status)}"
              >${run.status}</span
            >
            <div style="min-width:0">
              <div class="cpr-flow">
                ${run.flowType}${run.lane !== 'production'
                  ? html` · <span class="cpr-meta">${run.lane}</span>`
                  : nothing}${run.variant
                  ? html` · <span class="cpr-meta">${run.variant}</span>`
                  : nothing}
                ${run.grade
                  ? html`<span
                      class="cpr-grade"
                      title=${`difficulty=${run.grade.difficulty}, model=${run.grade.modelRecommendation}`}
                      >${run.grade.difficulty}</span
                    >`
                  : nothing}
                ${run.redirectedToRunId
                  ? html`<span
                      class="cpr-redirect"
                      title="Redirected to ${run.redirectedToRunId.slice(0, 8)}"
                      >redirected</span
                    >`
                  : nothing}
              </div>
              <div class="cpr-meta">
                <span class="cpr-id">${run.id.slice(0, 8)}</span>
                ${runnerModel ? html` · ${runnerModel}` : nothing}
                ${run.slotId ? html` · ${run.slotId}` : nothing}
              </div>
              <div class="cpr-pipeline-row">
                <run-pipeline-mini
                  .run=${run}
                  .steps=${run.steps}
                  .flowType=${run.flowType}
                ></run-pipeline-mini>
                <span class="cpr-meta" style=${isFailedStep ? `color:${colors.statusFail}` : ''}
                  >${stepLabel}</span
                >
              </div>
            </div>
            <div style="min-width:0">
              ${run.branch
                ? html`<div class="cpr-branch" title=${run.branch}>${run.branch}</div>`
                : nothing}
              ${run.prNumber ? html`<div class="cpr-meta">PR #${run.prNumber}</div>` : nothing}
              ${run.error
                ? html`<div class="cpr-error" title=${run.error}>${run.error}</div>`
                : nothing}
            </div>
            <div>
              <div class="cpr-time">${formatRelativeFromNow(run.createdAt)}</div>
              ${updatedTs && updatedTs !== run.createdAt
                ? html`<div class="cpr-time" style="font-size:10px">
                    upd ${formatRelativeFromNow(updatedTs)}
                  </div>`
                : nothing}
            </div>
          </a>
        `;
      })}
      ${missingCount > 0
        ? html`
            <div style="font-size:10px;color:${colors.textMuted};padding:4px 0">
              ${missingCount} prior run id${missingCount === 1 ? '' : 's'} not in current state
              (pruned or out of window)
            </div>
          `
        : nothing}
    </div>
  `;
}

export function reviewContinuationSummary(payload: ReviewContinuationPayload): string[] {
  const prior = payload.prior;
  return [
    `Generation ${prior.generation} · prior run ${prior.priorRunId.slice(0, 8)}`,
    `Reviewed head ${prior.priorReviewedHeadSha?.slice(0, 12) ?? 'unavailable'} → current ${prior.currentHeadSha.slice(0, 12)}`,
    `Prior verdict: ${prior.verdict} · ${prior.unresolvedFindings.length} unresolved`,
    prior.farmslotEvidenceRefs.length > 0
      ? `${prior.farmslotEvidenceRefs.length} frozen Farmslot evidence reference${prior.farmslotEvidenceRefs.length === 1 ? '' : 's'}`
      : 'External PR: no frozen Farmslot evidence linked',
  ];
}

export function renderReviewContinuation(decision: RunDecision) {
  const payload = decision.payload as ReviewContinuationPayload | undefined;
  if (!payload || payload.kind !== 'review_continuation') return nothing;
  return html`
    <div class="cpr-wrap">
      <div class="cpr-label">
        Recommended: <strong>${payload.recommendedActionId.replace(/-/g, ' ')}</strong>
      </div>
      ${reviewContinuationSummary(payload).map(
        (line) => html`<div class="cdesc-line">${line}</div>`,
      )}
      ${payload.prior.incrementalUnavailableReason
        ? html`<div class="cdesc-line" style="color:${colors.statusWarn}">
            ${payload.prior.incrementalUnavailableReason}
          </div>`
        : nothing}
      ${payload.prior.artifactRefs.length > 0
        ? html`<div class="cdesc-line">
            Prior artifacts:
            ${payload.prior.artifactRefs.map(
              (artifact) => html`<code title=${artifact.purpose}>${artifact.path}</code>`,
            )}
          </div>`
        : nothing}
    </div>
  `;
}
