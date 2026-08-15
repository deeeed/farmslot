import { html, nothing } from 'lit';

import type { CiCheckUpdatedPayload, PRStatus, Run, RunDecision } from '@farmslot/protocol';

import { colors, fonts } from '../../styles/theme-tokens.js';

import { readCiWatchOutputs } from './run-detail-model.js';
import { formatDuration, isCIWatchWorkerFixActive } from './run-utils.js';

export interface RunCiStatusRenderContext {
  ci: CiCheckUpdatedPayload | null;
  timeoutDecision: RunDecision | null;
  liveTimeoutPrStatus: PRStatus | null;
  prStatus: PRStatus | null;
  liveTimeoutPrStatusRefreshing: boolean;
  liveTimeoutPrStatusFailed: boolean;
  poking: boolean;
  pokeStatus: { ok: boolean; msg: string } | null;
  onPokeNow: () => void;
  now: number;
}

export function renderRunCiStatus(run: Run, ctx: RunCiStatusRenderContext): unknown {
  const ci = ctx.ci;
  if (!ci) return nothing;
  const ciStep = run.steps.find((step) => step.name === 'ci-watch');
  const timeoutDecision = ctx.timeoutDecision;
  const livePR = timeoutDecision ? ctx.liveTimeoutPrStatus : ctx.prStatus;
  const liveSummary = livePR?.checkSummary;
  const livePassedNames =
    livePR?.checks
      .filter((check) => check.status === 'pass')
      .map((check) => check.watchName || check.name) ?? [];
  const livePendingNames =
    livePR?.checks
      .filter((check) => check.status === 'pending')
      .map((check) => check.watchName || check.name) ?? [];
  const liveFailedNames =
    livePR?.checks
      .filter((check) => check.status === 'fail')
      .map((check) => check.watchName || check.name) ?? [];
  const displaySummary = liveSummary ?? ci.checkSummary;
  const displayPassedNames = livePR ? livePassedNames : ci.passedNames;
  const displayPendingNames = livePR ? livePendingNames : ci.pendingNames;
  const displayFailedNames = livePR ? liveFailedNames : ci.failedNames;
  const allSummary = livePR?.allCheckSummary;
  const displayRecommendation = livePR?.recommendation ?? ci.recommendation;
  const elapsed = ciStep?.startedAt
    ? formatDuration(Date.now() - new Date(ciStep.startedAt).getTime())
    : '';
  const out = readCiWatchOutputs(ciStep?.outputs);
  const inlineAttempts = out?.inlineFixAttempts ?? 0;
  const inlineTotalAttempts = out?.inlineFixTotalAttempts ?? 0;
  const phase = ci.phase ?? out?.phase;
  const activeTask = (ci.activeTaskFile ?? out?.activeTaskFile ?? '').split('/').pop() || '';
  const fixInProgress = isCIWatchWorkerFixActive(phase, ci.fixInProgress ?? out?.fixInProgress);
  const canPoke = ciStep?.status === 'running' && !fixInProgress;
  const pollIntervalMs = ci.pollIntervalMs ?? out?.pollIntervalMs ?? 60_000;
  const lastCheckedAt =
    ci.lastCheckedAt ??
    out?.lastCheckedAt ??
    (out?.checkTimeline?.length
      ? out.checkTimeline[out.checkTimeline.length - 1]?.timestamp
      : undefined);
  const nextPollAt = ci.nextPollAt ?? out?.nextPollAt;
  const nextCheckMs = fixInProgress
    ? null
    : nextPollAt
      ? Math.max(0, new Date(nextPollAt).getTime() - ctx.now)
      : lastCheckedAt
        ? Math.max(0, new Date(lastCheckedAt).getTime() + pollIntervalMs - ctx.now)
        : null;
  const nextCheck = nextCheckMs !== null ? formatDuration(nextCheckMs) : '';
  const nextCheckColor =
    nextCheckMs === null
      ? colors.textMuted
      : nextCheckMs <= 10_000
        ? colors.statusFail
        : nextCheckMs <= 30_000
          ? colors.statusWarn
          : colors.textMuted;

  return html`
    <div
      style="padding:12px 16px; background:${colors.bgCard}; border-radius:6px; margin-top:8px; font-family:${fonts.mono}; font-size:${fonts.sizeSm}"
    >
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px; flex-wrap:wrap">
        <span style="font-weight:600; color:${colors.textPrimary}"
          >${livePR ? 'Current Watched GitHub Checks' : 'Watched CI Checks'}</span
        >
        <span style="color:${colors.textMuted}">poll #${ci.pollCount}</span>
        ${timeoutDecision
          ? html`
              <span
                style="padding:4px 10px; border-radius:999px; border:1px solid ${colors.statusWarn}; background:${colors.statusWarn}22; color:${colors.statusWarn}; font-weight:800; font-size:${fonts.sizeXs};"
              >
                timeout decision pending
              </span>
            `
          : nothing}
        ${ctx.liveTimeoutPrStatusRefreshing
          ? html`<span style="color:${colors.textMuted}; font-size:${fonts.sizeXs}"
              >refreshing live status…</span
            >`
          : nothing}
        ${ctx.liveTimeoutPrStatusFailed
          ? html`<span style="color:${colors.statusWarn}; font-size:${fonts.sizeXs}"
              >live refresh failed</span
            >`
          : nothing}
        ${nextCheck
          ? html`
              <span
                style="padding:4px 10px; border-radius:999px; border:1px solid ${nextCheckColor}; background:${nextCheckColor ===
                colors.textMuted
                  ? colors.bgSurface
                  : `${nextCheckColor}33`}; color:${nextCheckColor === colors.textMuted
                  ? colors.textPrimary
                  : nextCheckColor}; font-weight:800; font-size:${fonts.sizeXs}; letter-spacing:0.02em; box-shadow: inset 0 0 0 1px ${nextCheckColor}22;"
              >
                next check in ${nextCheck}
              </span>
            `
          : nothing}
        ${fixInProgress
          ? html`
              <span
                style="padding:4px 10px; border-radius:999px; border:1px solid ${colors.accent}; background:${colors.accent}22; color:${colors.accent}; font-weight:800; font-size:${fonts.sizeXs}; letter-spacing:0.02em;"
              >
                worker fixing now
              </span>
            `
          : nothing}
        ${canPoke
          ? html`
              <button
                type="button"
                ?disabled=${ctx.poking}
                @click=${ctx.onPokeNow}
                title="Wake CI-watch and check GitHub now"
                style="padding:4px 10px; border-radius:4px; border:1px solid ${colors.accent}; background:${colors.accent}18; color:${colors.accent}; font:inherit; font-size:${fonts.sizeXs}; font-weight:800; cursor:${ctx.poking
                  ? 'wait'
                  : 'pointer'}; opacity:${ctx.poking ? '0.65' : '1'};"
              >
                ${ctx.poking ? 'Checking…' : 'Check now'}
              </button>
            `
          : nothing}
        ${ctx.pokeStatus
          ? html`<span
              style="color:${ctx.pokeStatus.ok
                ? colors.statusOk
                : colors.statusFail}; font-size:${fonts.sizeXs}"
              >${ctx.pokeStatus.msg}</span
            >`
          : nothing}
        ${elapsed
          ? html`<span style="color:${colors.textMuted}; margin-left:auto"
              >${elapsed} elapsed</span
            >`
          : nothing}
      </div>
      <div style="display:flex; gap:16px; margin-bottom:6px">
        <span style="color:${colors.statusOk}">${displaySummary.passed} passed</span>
        <span style="color:${displaySummary.failed > 0 ? colors.statusFail : colors.textMuted}"
          >${displaySummary.failed} failed</span
        >
        <span style="color:${displaySummary.pending > 0 ? colors.statusWarn : colors.textMuted}"
          >${displaySummary.pending} pending</span
        >
        <span style="color:${colors.textMuted}">/ ${displaySummary.total} total</span>
      </div>
      ${displayPassedNames?.length > 0
        ? html`<div style="color:${colors.statusOk}; font-size:${fonts.sizeXs}; margin-bottom:2px">
            Passed: ${displayPassedNames.join(', ')}
          </div>`
        : nothing}
      ${displayPendingNames?.length > 0
        ? html`<div
            style="color:${colors.statusWarn}; font-size:${fonts.sizeXs}; margin-bottom:2px"
          >
            Pending: ${displayPendingNames.join(', ')}
          </div>`
        : nothing}
      ${displayFailedNames?.length > 0
        ? html`<div
            style="color:${colors.statusFail}; font-size:${fonts.sizeXs}; margin-bottom:2px"
          >
            Failed: ${displayFailedNames.join(', ')}
          </div>`
        : nothing}
      ${livePR
        ? html`<div style="color:${colors.textMuted}; font-size:${fonts.sizeXs}; margin-top:4px">
            Monitor snapshot: ${ci.checkSummary.passed}/${ci.checkSummary.total} passed
            ${ci.checkSummary.failed ? html` · ${ci.checkSummary.failed} failed` : nothing}
            ${ci.checkSummary.pending ? html` · ${ci.checkSummary.pending} pending` : nothing}
          </div>`
        : nothing}
      ${allSummary && allSummary.total !== displaySummary.total
        ? html`
            <div style="color:${colors.textMuted}; font-size:${fonts.sizeXs}; margin-top:4px">
              All GitHub checks: ${allSummary.passed} passed
              ${allSummary.failed
                ? html` ·
                    <span style="color:${colors.statusFail}">${allSummary.failed} failed</span>`
                : nothing}
              ${allSummary.pending
                ? html` ·
                    <span style="color:${colors.statusWarn}">${allSummary.pending} pending</span>`
                : nothing}
              ${allSummary.skipped ? html` · ${allSummary.skipped} skipped` : nothing} ·
              ${allSummary.total} total
            </div>
            ${(livePR.allPendingNames?.length ?? 0) > 0
              ? html`<div
                  style="color:${colors.statusWarn}; font-size:${fonts.sizeXs}; margin-top:2px"
                >
                  GitHub pending: ${livePR.allPendingNames!.join(', ')}
                </div>`
              : nothing}
            ${(livePR.allFailedNames?.length ?? 0) > 0
              ? html`<div
                  style="color:${colors.statusFail}; font-size:${fonts.sizeXs}; margin-top:2px"
                >
                  GitHub failed: ${livePR.allFailedNames!.join(', ')}
                </div>`
              : nothing}
          `
        : nothing}
      ${inlineTotalAttempts > 0
        ? html`<div style="color:${colors.textMuted}; font-size:${fonts.sizeXs}; margin-top:4px">
            CI loop attempts: ${inlineAttempts} current / ${inlineTotalAttempts} total
            ${activeTask ? html` · active task: <code>${activeTask}</code>` : nothing}
            ${ci.fixProgress
              ? html` · progress
                ${ci.fixProgress.completed}/${ci.fixProgress.total}${ci.fixProgress.currentLabel
                  ? ` · ${ci.fixProgress.currentLabel}`
                  : ''}`
              : nothing}
          </div>`
        : activeTask
          ? html`<div style="color:${colors.textMuted}; font-size:${fonts.sizeXs}; margin-top:4px">
              Active task: <code>${activeTask}</code>
            </div>`
          : nothing}
      ${lastCheckedAt
        ? html`<div
            style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:${fonts.sizeXs}; margin-top:6px"
          >
            <span style="color:${colors.textMuted}"
              >Last checked: ${new Date(lastCheckedAt).toLocaleTimeString()}</span
            >
          </div>`
        : nothing}
      ${ci.lastProgressAt
        ? html`<div style="color:${colors.textMuted}; font-size:${fonts.sizeXs}; margin-top:4px">
            Last progress:
            ${new Date(ci.lastProgressAt).toLocaleTimeString()}${ci.lastProgressReason
              ? ` · ${ci.lastProgressReason}`
              : ''}
          </div>`
        : nothing}
      <div style="color:${colors.textMuted}; font-size:${fonts.sizeXs}; margin-top:4px">
        ${displayRecommendation}
      </div>
    </div>
  `;
}
