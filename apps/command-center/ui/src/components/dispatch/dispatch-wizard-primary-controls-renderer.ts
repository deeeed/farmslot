import { html, nothing } from 'lit';

import type { DevInteractiveProfile, FlowType } from '@farmslot/protocol';

import '../shared/runner-model-effort-picker.js';
import '../shared/slot-prepare-options.js';

import { colors } from '../../styles/theme-tokens.js';
import { type EffortLevel } from '../../utils/runner-options.js';
import type { RunnerModelEffortChangeDetail } from '../shared/runner-model-effort-picker.js';
import type { SlotPrepareOptionsChangeDetail } from '../shared/slot-prepare-options.js';

import type { PrepareProfileOption } from './dispatch-wizard-draft.js';
import { DISPATCH_HELP } from './dispatch-wizard-help.js';

type DispatchMode = 'interactive' | 'autonomous';

interface FlowOption {
  type: FlowType;
  label: string;
  key: string;
}

const FLOW_OPTIONS: readonly FlowOption[] = [
  { type: 'fix-bug', label: 'Fix Bug', key: 'B' },
  { type: 'review-pr', label: 'Review', key: 'R' },
  { type: 'qa', label: 'QA', key: 'Q' },
  { type: 'dev', label: 'Dev', key: 'D' },
  { type: 'pr-complete', label: 'PR Complete', key: 'C' },
];

export interface DispatchWizardPrimaryControlsRenderContext {
  transport: 'tmux' | 'native';
  nativeWorkerAvailable: boolean;
  nativeCatalogError: string;
  nativeProfileControl: unknown;
  setTransport: (transport: 'tmux' | 'native') => void;
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
  workflowControls: unknown;
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
    ${ctx.workflowControls}
    <details class="config-group" data-testid="dispatch-execution-options">
      <summary data-testid="dispatch-execution-summary">
        Execution options · ${ctx.runner} / ${ctx.model}
      </summary>
      ${renderRunnerModelConfig(ctx)}
      ${html`<div>
          <div
            class="section-label"
            id="worker-interface-label"
            title=${DISPATCH_HELP.interface.text}
          >
            Worker interface
          </div>
          <div
            class="pill-row"
            role="group"
            aria-labelledby="worker-interface-label"
            data-testid="dispatch-transport"
          >
            <button
              type="button"
              class="pill ${ctx.transport === 'tmux' ? 'selected' : ''}"
              data-transport="tmux"
              aria-pressed=${ctx.transport === 'tmux'}
              @click=${() => ctx.setTransport('tmux')}
            >
              Terminal
            </button>
            <button
              type="button"
              class="pill ${ctx.transport === 'native' ? 'selected' : ''}"
              data-transport="native"
              aria-pressed=${ctx.transport === 'native'}
              ?disabled=${!ctx.nativeWorkerAvailable}
              title=${ctx.nativeWorkerAvailable
                ? 'Messages, tools and approvals in Farmslot'
                : 'Native workers are unavailable for this runner'}
              @click=${() => ctx.setTransport('native')}
            >
              Conversation
            </button>
          </div>
        </div>
        ${ctx.nativeCatalogError
          ? html`<p class="section-help" role="status">${ctx.nativeCatalogError}</p>`
          : nothing}
        ${ctx.transport === 'native'
          ? html`<p class="section-help" data-testid="dispatch-interface-help">
              Messages, tools and approvals appear in Farmslot. The selected runner keeps its own
              login and model.
            </p>`
          : nothing}
        ${ctx.transport === 'native' ? ctx.nativeProfileControl : nothing}`}
    </details>
    ${renderPrepareToggle(ctx)} ${renderInteractiveDevProfile(ctx)}
  `;
}

function renderTicketInput(ctx: DispatchWizardPrimaryControlsRenderContext) {
  return html`
    <div>
      <div class="section-label" title=${DISPATCH_HELP.ticket.text}>
        ${ctx.flowType === 'qa' ? 'Validation context' : 'Ticket / PR'}${ctx.matchingProject
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
        data-testid="dispatch-ticket"
        type="text"
        placeholder=${ctx.flowType === 'qa'
          ? 'PR URL, release or change window'
          : 'PROJ-2368, PR #123, or paste Jira/GitHub URL'}
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
      <div class="section-label" title=${DISPATCH_HELP.flow.text}>
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
              data-testid=${`dispatch-flow-${option.type}`}
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
      <div class="section-label" title=${DISPATCH_HELP.project.text}>
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
              data-testid=${`dispatch-project-${project}`}
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
      <div class="section-label" title=${DISPATCH_HELP.project.text}>App</div>
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
    <runner-model-effort-picker
      .runner=${ctx.runner}
      .model=${ctx.model}
      .effort=${ctx.effort}
      @runner-model-effort-change=${(event: CustomEvent<RunnerModelEffortChangeDetail>) => {
        ctx.setRunner(event.detail.runner);
        ctx.setModel(event.detail.model);
        ctx.setEffort(event.detail.effort);
      }}
    ></runner-model-effort-picker>
  `;
}

function renderPrepareToggle(ctx: DispatchWizardPrimaryControlsRenderContext) {
  if (ctx.flowType === 'review-pr') return nothing;
  const profiles = ctx.prepareProfiles;
  return html`
    <div class="config-group" style="margin-top: 4px" title=${DISPATCH_HELP.prepare.text}>
      ${profiles.length > 0 ? html`<div class="section-label">Prepare</div>` : nothing}
      <slot-prepare-options
        variant="dispatch"
        .project=${ctx.project}
        .prepareProfile=${ctx.prepareProfile}
        .skipPrepare=${ctx.skipPrepare}
        persist-prefs=${false}
        show-plan=${false}
        ?show-advanced=${false}
        @prepare-options-change=${(event: CustomEvent<SlotPrepareOptionsChangeDetail>) => {
          if (event.detail.skipPrepare) {
            ctx.setSkipPrepare(true);
            return;
          }
          ctx.setSkipPrepare(false);
          ctx.setPrepareProfile(event.detail.prepareProfile);
        }}
      ></slot-prepare-options>
    </div>
  `;
}

function renderInteractiveDevProfile(ctx: DispatchWizardPrimaryControlsRenderContext) {
  if (ctx.flowType !== 'dev' || ctx.mode !== 'interactive') return nothing;
  return html`
    <div class="config-group">
      <div class="section-label" title=${DISPATCH_HELP.interactive.text}>Interactive dev</div>
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
