import { html, nothing } from 'lit';

import type { DevInteractiveProfile, FlowType } from '@farmslot/protocol';

import { colors, fonts } from '../../styles/theme-tokens.js';
import {
  EFFORT_BY_RUNNER,
  type EffortLevel,
  MODELS_BY_RUNNER,
  RUNNER_OPTIONS,
} from '../../utils/runner-options.js';

import type { PrepareProfileOption } from './dispatch-wizard-draft.js';

type DispatchMode = 'interactive' | 'autonomous';
type ReviewTier = '' | 'light' | 'standard' | 'full';

interface FlowOption {
  type: FlowType;
  label: string;
  key: string;
}

const FLOW_OPTIONS: readonly FlowOption[] = [
  { type: 'fix-bug', label: 'Fix Bug', key: 'B' },
  { type: 'review-pr', label: 'Review PR', key: 'R' },
  { type: 'dev', label: 'Dev', key: 'D' },
  { type: 'pr-complete', label: 'PR Complete', key: 'C' },
];

const REVIEW_TIER_HELP: Record<ReviewTier, string> = {
  '': 'Auto — LLM picks evidence depth from the PR diff; you confirm at the gate.',
  light: 'Smoke only — backend regression test, no UI evidence.',
  standard: 'Targeted evidence — smoke + screenshots for changed UI surfaces.',
  full: 'Full QA — screenshots plus opt-in video when motion proof helps.',
};

export interface DispatchWizardPrimaryControlsRenderContext {
  ticketId: string;
  matchingProject: boolean;
  issueType: string;
  autoFlowType: boolean;
  flowType: FlowType | null;
  autoProject: string;
  availableProjects: readonly string[];
  project: string;
  projectApps: readonly string[];
  selectedDispatchApp: string | undefined;
  interstitialContent: unknown;
  taskTemplateSelector: unknown;
  runner: string;
  model: string;
  effort: EffortLevel;
  reviewTier: ReviewTier;
  skipPrepare: boolean;
  prepareProfiles: readonly PrepareProfileOption[];
  prepareProfile: string;
  mode: DispatchMode;
  devInteractiveProfile: DevInteractiveProfile;
  appLabel: (app: string) => string;
  setTicket: (value: string) => void;
  submitTicket: () => void;
  selectFlowType: (flowType: FlowType) => void;
  selectProject: (project: string) => void;
  setApp: (app: string) => void;
  setRunner: (runner: string) => void;
  setModel: (model: string) => void;
  setEffort: (effort: EffortLevel) => void;
  setReviewTier: (reviewTier: ReviewTier) => void;
  setSkipPrepare: (skipPrepare: boolean) => void;
  setPrepareProfile: (prepareProfile: string) => void;
  setDevInteractiveProfile: (profile: DevInteractiveProfile) => void;
}

export function renderDispatchWizardPrimaryControls(
  ctx: DispatchWizardPrimaryControlsRenderContext,
) {
  return html`
    ${renderTicketInput(ctx)} ${ctx.interstitialContent} ${renderFlowSelector(ctx)}
    ${renderProjectSelector(ctx)} ${renderAppSelector(ctx)} ${ctx.taskTemplateSelector}
    ${renderRunnerModelConfig(ctx)} ${renderReviewTierSelector(ctx)} ${renderPrepareToggle(ctx)}
    ${renderInteractiveDevProfile(ctx)}
  `;
}

function renderTicketInput(ctx: DispatchWizardPrimaryControlsRenderContext) {
  return html`
    <div>
      <div class="section-label">
        Ticket /
        PR${ctx.matchingProject
          ? html` <span
              style="color:${colors.textMuted}; text-transform:none; letter-spacing:normal"
              >detecting...</span
            >`
          : ctx.issueType
            ? html` <span
                style="color:${colors.statusOk}; text-transform:none; letter-spacing:normal"
                >${ctx.issueType}</span
              >`
            : ''}
      </div>
      <input
        class="ticket-input"
        type="text"
        placeholder="PROJ-2368, PR #123, or paste Jira/GitHub URL"
        .value=${ctx.ticketId}
        @input=${(event: InputEvent) => ctx.setTicket((event.target as HTMLInputElement).value)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === 'Enter') ctx.submitTicket();
        }}
      />
    </div>
  `;
}

function renderFlowSelector(ctx: DispatchWizardPrimaryControlsRenderContext) {
  return html`
    <div>
      <div class="section-label">
        Flow${ctx.autoFlowType
          ? html` <span style="color:${colors.accent}; text-transform:none; letter-spacing:normal"
              >auto</span
            >`
          : ''}
      </div>
      <div class="pill-row">
        ${FLOW_OPTIONS.map(
          (option) => html`
            <button
              class="pill ${ctx.flowType === option.type ? 'selected' : ''}"
              @click=${() => ctx.selectFlowType(option.type)}
            >
              ${option.label}<span class="pill-key">${option.key}</span>
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

function renderProjectSelector(ctx: DispatchWizardPrimaryControlsRenderContext) {
  return html`
    <div>
      <div class="section-label">
        Project${ctx.autoProject
          ? html` <span style="color:${colors.accent}; text-transform:none; letter-spacing:normal"
              >auto</span
            >`
          : ''}
      </div>
      <div class="pill-row">
        ${ctx.availableProjects.map(
          (project) => html`
            <button
              class="pill ${ctx.project === project ? 'selected' : ''}"
              @click=${() => ctx.selectProject(project)}
            >
              ${project}
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

function renderAppSelector(ctx: DispatchWizardPrimaryControlsRenderContext) {
  if (!ctx.project || ctx.projectApps.length <= 1) return nothing;
  return html`
    <div>
      <div class="section-label">App</div>
      <div class="pill-row">
        ${ctx.projectApps.map(
          (app) => html`
            <button
              class="pill ${ctx.selectedDispatchApp === app ? 'selected' : ''}"
              title=${app}
              @click=${() => ctx.setApp(app)}
            >
              ${ctx.appLabel(app)}
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

function renderRunnerModelConfig(ctx: DispatchWizardPrimaryControlsRenderContext) {
  return html`
    <div class="config-row">
      <div class="config-group">
        <div class="section-label">Runner</div>
        <div class="pill-row">
          ${RUNNER_OPTIONS.map(
            (runner) => html`
              <button
                class="pill ${ctx.runner === runner ? 'selected' : ''}"
                @click=${() => ctx.setRunner(runner)}
              >
                ${runner}
              </button>
            `,
          )}
        </div>
      </div>
      <div class="config-group">
        <div class="section-label">Model</div>
        <div class="pill-row">
          ${(MODELS_BY_RUNNER[ctx.runner] ?? []).map(
            (model) => html`
              <button
                class="pill ${ctx.model === model ? 'selected' : ''}"
                @click=${() => ctx.setModel(model)}
              >
                ${model}
              </button>
            `,
          )}
        </div>
        ${ctx.runner === 'cursor'
          ? html`
              <div style="font-size:${fonts.sizeXs}; color:${colors.textMuted}; margin-top:4px;">
                Pilot UI exposes the default only; gateway/admin dispatch may pass any Cursor
                account model.
              </div>
            `
          : ctx.runner === 'claude' && ctx.model === 'fable'
            ? html`
                <div style="font-size:${fonts.sizeXs}; color:${colors.statusWarn}; margin-top:4px;">
                  Fable is a heavyweight Claude model; select it only for very complex tasks.
                </div>
              `
            : nothing}
      </div>
      ${renderEffortSelector(ctx)}
    </div>
  `;
}

function renderEffortSelector(ctx: DispatchWizardPrimaryControlsRenderContext) {
  const options = EFFORT_BY_RUNNER[ctx.runner] ?? [];
  if (options.length === 0) return nothing;
  return html`
    <div class="config-group">
      <div class="section-label">Effort</div>
      <div class="pill-row">
        <button
          class="pill ${ctx.effort === '' ? 'selected' : ''}"
          @click=${() => ctx.setEffort('')}
        >
          default
        </button>
        ${options.map(
          (effort) => html`
            <button
              class="pill ${ctx.effort === effort ? 'selected' : ''}"
              @click=${() => ctx.setEffort(effort)}
            >
              ${effort}
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

function renderReviewTierSelector(ctx: DispatchWizardPrimaryControlsRenderContext) {
  if (ctx.flowType !== 'review-pr') return nothing;
  return html`
    <div class="config-group">
      <div class="section-label">Review Tier</div>
      <div class="pill-row">
        ${(['', 'light', 'standard', 'full'] as ReviewTier[]).map(
          (tier) => html`
            <button
              class="pill ${ctx.reviewTier === tier ? 'selected' : ''}"
              @click=${() => ctx.setReviewTier(tier)}
            >
              ${tier || 'auto'}
            </button>
          `,
        )}
      </div>
      <div class="section-help">${REVIEW_TIER_HELP[ctx.reviewTier]}</div>
    </div>
  `;
}

function renderPrepareToggle(ctx: DispatchWizardPrimaryControlsRenderContext) {
  const profiles = ctx.prepareProfiles;
  const profileSelected = (profile: PrepareProfileOption): boolean =>
    !ctx.skipPrepare &&
    (ctx.prepareProfile ? ctx.prepareProfile === profile.name : profile.isDefault);
  return html`
    <div class="config-group" style="margin-top: 4px">
      ${profiles.length > 0 ? html`<div class="section-label">Prepare</div>` : nothing}
      <div class="pill-row">
        ${profiles.length === 0
          ? html`
              <button
                class="pill ${!ctx.skipPrepare ? 'selected' : ''}"
                @click=${() => ctx.setSkipPrepare(false)}
              >
                Full Prepare
              </button>
            `
          : profiles.map(
              (profile) => html`
                <button
                  class="pill ${profileSelected(profile) ? 'selected' : ''}"
                  title=${profile.label}
                  @click=${() => {
                    ctx.setSkipPrepare(false);
                    ctx.setPrepareProfile(profile.isDefault ? '' : profile.name);
                  }}
                >
                  ${profile.name}${profile.isDefault ? ' ★' : ''}
                </button>
              `,
            )}
        <button
          class="pill ${ctx.skipPrepare ? 'selected' : ''}"
          @click=${() => ctx.setSkipPrepare(true)}
          title="Run no preparation at all — operator owns slot state"
        >
          Skip Prepare
        </button>
      </div>
    </div>
  `;
}

function renderInteractiveDevProfile(ctx: DispatchWizardPrimaryControlsRenderContext) {
  if (ctx.flowType !== 'dev' || ctx.mode !== 'interactive') return nothing;
  return html`
    <div class="config-group">
      <div class="section-label">Interactive dev</div>
      <div class="pill-row">
        <button
          class="pill ${ctx.devInteractiveProfile === 'lightweight' ? 'selected' : ''}"
          title="Skip self-review and human gate by default; finish through operator actions."
          @click=${() => ctx.setDevInteractiveProfile('lightweight')}
        >
          Lightweight
        </button>
        <button
          class="pill ${ctx.devInteractiveProfile === 'reviewed' ? 'selected' : ''}"
          title="Run the normal review checkpoints for this dev task."
          @click=${() => ctx.setDevInteractiveProfile('reviewed')}
        >
          Reviewed
        </button>
      </div>
      <div class="section-help">
        ${ctx.devInteractiveProfile === 'lightweight'
          ? 'Initial context accepted; self-review and human gate are recorded as policy skips.'
          : 'Uses the dev lane with interactive review checkpoints enabled.'}
      </div>
    </div>
  `;
}
