import { html, nothing } from 'lit';

import type { RunStep } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

import { formatDuration, isCIWatchWorkerFixActive, prRecommendationLabel } from './run-utils.js';

export interface StepInspectorCiWatchBannerContext {
  tickNow: number;
  poking: boolean;
  pokeStatus: { ok: boolean; msg: string } | null;
  onPokeNow: () => void | Promise<void>;
}

export function renderStepInspectorCiWatchBanner(
  step: RunStep,
  ctx: StepInspectorCiWatchBannerContext,
): unknown {
  if (step.name !== 'ci-watch') return nothing;
  const out = (step.outputs ?? {}) as Record<string, unknown>;
  const summary = out.checkSummary as
    | { passed?: number; failed?: number; pending?: number; total?: number }
    | undefined;
  const recommendation = typeof out.recommendation === 'string' ? out.recommendation : undefined;
  const botCount =
    typeof out.actionableBotCommentCount === 'number' ? out.actionableBotCommentCount : 0;
  const inlineAttempts = typeof out.inlineFixAttempts === 'number' ? out.inlineFixAttempts : 0;
  const inlineTotal =
    typeof out.inlineFixTotalAttempts === 'number' ? out.inlineFixTotalAttempts : 0;
  const phase = out.phase;
  const activeTaskFile =
    typeof out.activeTaskFile === 'string' ? (out.activeTaskFile.split('/').pop() ?? '') : '';
  const fixProgress = out.fixProgress as
    | { completed?: number; total?: number; currentLabel?: string | null }
    | undefined;
  const fixInProgress = isCIWatchWorkerFixActive(phase, out.fixInProgress);
  const pollIntervalMs = typeof out.pollIntervalMs === 'number' ? out.pollIntervalMs : undefined;
  const lastCheckedAt = typeof out.lastCheckedAt === 'string' ? out.lastCheckedAt : undefined;
  const nextPollAt = typeof out.nextPollAt === 'string' ? out.nextPollAt : undefined;

  if (step.status !== 'running') {
    if (step.status === 'done') {
      const result = typeof out.result === 'string' ? out.result : 'done';
      const label =
        result === 'passed'
          ? 'CI watch finished: passed'
          : result === 'failed'
            ? 'CI watch finished: failed'
            : result === 'comments'
              ? 'CI watch finished: bot comments handled'
              : result === 'timeout'
                ? 'CI watch finished: timeout'
                : result === 'aborted'
                  ? 'CI watch finished: aborted'
                  : `CI watch finished: ${result}`;
      return html`
        <div class="ci-wait-done-banner">
          <div class="ci-wait-done-title">${label}</div>
          ${summary
            ? html`
                <div class="ci-wait-detail">
                  ${summary.passed ?? 0}/${summary.total ?? 0} checks passed
                  ${summary.failed
                    ? html` · <span class="ci-wait-warn">${summary.failed} failed</span>`
                    : nothing}
                </div>
              `
            : nothing}
        </div>
      `;
    }
    return nothing;
  }

  // Derive the thing being waited on
  const pending = summary?.pending ?? 0;
  const failed = summary?.failed ?? 0;
  let waitingLabel = 'Next poll';
  let waitingTag = 'poll';
  if (phase === 'fixing' || phase === 'waiting_for_worker') {
    waitingLabel = 'Worker inline fix';
    waitingTag = 'fix loop';
  } else if (phase === 'deduped') {
    waitingLabel =
      typeof out.dedupReason === 'string' ? `Deduped: ${out.dedupReason}` : 'Deduped inline fix';
    waitingTag = 'deduped';
  } else if (phase === 'decision_required') {
    waitingLabel = 'Operator decision';
    waitingTag = 'decision';
  } else if (failed > 0) {
    waitingLabel = `Inline fix for ${failed} failed check${failed > 1 ? 's' : ''}`;
    waitingTag = 'fix loop';
  } else if (botCount > 0 && recommendation === 'NEEDS_ATTENTION') {
    waitingLabel =
      inlineTotal > 0
        ? `Inline fix for bot comments · loop ${inlineAttempts}/${inlineTotal}`
        : `Inline fix for ${botCount} bot comment${botCount > 1 ? 's' : ''}`;
    waitingTag = 'fix loop';
  } else if (pending > 0) {
    waitingLabel = `${pending} CI check${pending > 1 ? 's' : ''} still pending`;
    waitingTag = 'ci';
  } else if (
    recommendation === 'READY_TO_MERGE' ||
    (summary && (summary.passed ?? 0) > 0 && failed === 0 && pending === 0 && botCount === 0)
  ) {
    waitingLabel = 'PR to merge or close';
    waitingTag = 'merge';
  }

  let nextPollLine: unknown = nothing;
  if (nextPollAt || (pollIntervalMs && lastCheckedAt)) {
    const nextAt = nextPollAt
      ? Date.parse(nextPollAt)
      : Date.parse(lastCheckedAt!) + pollIntervalMs!;
    const remainMs = Math.max(0, nextAt - ctx.tickNow);
    nextPollLine = html`
      <div class="ci-wait-detail">
        Next check in <span class="ci-wait-count">${formatDuration(remainMs)}</span>
        ${pollIntervalMs
          ? html`<span style="color:${colors.textMuted}">
              · poll every ${formatDuration(pollIntervalMs)}</span
            >`
          : nothing}
      </div>
    `;
  } else if (pollIntervalMs) {
    nextPollLine = html`
      <div class="ci-wait-detail">
        <span style="color:${colors.textMuted}">Poll every ${formatDuration(pollIntervalMs)}</span>
      </div>
    `;
  }

  return html`
    <div class="ci-wait-banner">
      <div class="ci-wait-title">
        <span class="ci-wait-tag">${waitingTag}</span>
        <span>Waiting for: ${waitingLabel}</span>
      </div>
      ${summary
        ? html`
            <div class="ci-wait-detail">
              Checks: ${summary.passed ?? 0}/${summary.total ?? 0}
              passed${summary.failed
                ? html` · <span class="ci-wait-warn">${summary.failed} failed</span>`
                : nothing}${summary.pending ? html` · ${summary.pending} pending` : nothing}
              ${recommendation
                ? html`<span
                    style="color:${colors.textMuted}"
                    title="PR recommendation from ci-watch — independent of the step state"
                  >
                    · PR: ${prRecommendationLabel(recommendation)}</span
                  >`
                : nothing}
            </div>
          `
        : nothing}
      ${botCount > 0
        ? html`
            <div class="ci-wait-detail">
              <span class="ci-wait-warn">${botCount}</span> actionable bot
              comment${botCount > 1 ? 's' : ''}${inlineTotal > 0
                ? html` · inline fix ${inlineAttempts}/${inlineTotal}`
                : nothing}
            </div>
          `
        : nothing}
      ${fixInProgress
        ? html`
            <div class="ci-wait-detail">
              <span class="ci-wait-count">Worker fix in progress</span>${activeTaskFile
                ? html` · active task: <code>${activeTaskFile}</code>`
                : nothing}
              ${fixProgress?.total
                ? html` · progress
                  ${fixProgress.completed ?? 0}/${fixProgress.total}${fixProgress.currentLabel
                    ? ` · ${fixProgress.currentLabel}`
                    : ''}`
                : nothing}
            </div>
          `
        : nothing}
      ${nextPollLine}
      <div class="ci-wait-actions">
        <button
          class="ci-wait-poke"
          ?disabled=${ctx.poking}
          @click=${ctx.onPokeNow}
          title="Wake the CI monitor sleep and run the next poll immediately"
        >
          ${ctx.poking ? 'Checking…' : 'Check now'}
        </button>
        ${ctx.pokeStatus
          ? html`
              <span
                class="ci-wait-poke-status ${ctx.pokeStatus.ok
                  ? 'ci-wait-poke-ok'
                  : 'ci-wait-poke-err'}"
              >
                ${ctx.pokeStatus.msg}
              </span>
            `
          : nothing}
      </div>
    </div>
  `;
}
