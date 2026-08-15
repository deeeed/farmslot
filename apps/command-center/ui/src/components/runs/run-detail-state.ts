import { LitElement } from 'lit';
import { property, state } from 'lit/decorators.js';

import type {
  CiCheckUpdatedPayload,
  PRStatus,
  RecipeRunArtifactGroup,
  Run,
  RunStep,
  TaskProgressStructured,
} from '@farmslot/protocol';

import type { LightboxItem } from '../shared/media-lightbox-types.js';

export abstract class RunDetailState extends LitElement {
  @property() runId = '';
  @property({ type: Boolean }) embedded = false;
  @property({ type: Boolean, attribute: 'mock-data' }) mockData = false;
  @property({ attribute: false }) mockRun: Run | null = null;
  @property({ attribute: false }) mockArtifactTextLoader:
    | ((path: string) => Promise<string>)
    | null = null;
  @state() run: Run | null = null;
  @state() prStatus: PRStatus | null = null;
  @state() siblings: Run[] = [];
  @state() taskProgress: TaskProgressStructured | null = null;
  @state() ciStatus: CiCheckUpdatedPayload | null = null;
  @state() liveTimeoutPrStatus: PRStatus | null = null;
  @state() liveTimeoutPrStatusRefreshing = false;
  @state() liveTimeoutPrStatusFailed = false;
  @state() _ciPoking = false;
  @state() _ciPokeStatus: { ok: boolean; msg: string } | null = null;
  @state() _now = Date.now();
  @state() selectedStep: RunStep | null = null;
  @state() selectedStepProgress: TaskProgressStructured | null = null;
  _selectedStepProgressKey = '';
  @state() _pendingConfirm: string | null = null;
  @state() _rescueInProgress = false;
  @state() _interactiveDevActionInProgress: string | null = null;
  @state() _handoffSignalCheckBusy = false;
  @state() _handoffSignalCheckError: string | null = null;
  @state() _selectedSlotId: string | null = null;
  @state() _resetBranch = false;
  @state() _branchNudgeShowPicker = false;
  @state() _showTerminal = false;
  @state() _hydrating = false;
  @state() _bootstrapFailed = false;
  @state() _connectionStale = false;
  @state() _directRunRefreshing = false;
  @state() _directRunRefreshFailed = false;
  @state() _directRunUnavailable = false;
  @state() _evidenceLightboxOpen = false;
  @state() _evidenceLightboxItems: LightboxItem[] = [];
  @state() _evidenceLightboxIndex = 0;
  @state() _recipeRuns: RecipeRunArtifactGroup[] = [];
  @state() _selectedRecipeRunId = '';
  _confirmTimer?: ReturnType<typeof setTimeout>;
  _jumpTimer?: ReturnType<typeof setTimeout>;
  _recipeRunsRefreshToken = Symbol('run-detail-recipe-runs');
  _recipeRunsRefreshInFlight: Promise<void> | null = null;
  _recipeRunsRefreshInFlightRunId = '';
  _pendingRecipeRunSelectionId = '';
  _recipeRunsDelayedRefreshTimer?: ReturnType<typeof setTimeout>;
  _ciPokeStatusTimer?: ReturnType<typeof setTimeout>;
  _ciPokeRequestSeq = 0;
  _ciPokePollCount: number | null = null;
  unsub?: () => void;
  unsubProgress?: () => void;
  unsubCI?: () => void;
  _clock?: ReturnType<typeof setInterval>;
  _suppressHashSync = false;
  _missingRunFetchAttempted = false;
  _lastRequestedRunId = '';
  _directRun: Run | null = null;
  _directRunRequestSeq = 0;
  _taskProgressRequestSeq = 0;
  _siblingsRequestSeq = 0;
  _lastTaskProgressFetchAt = 0;
  _liveTimeoutRequestSeq = 0;
  _lastLiveTimeoutFetchAt = 0;
  _liveTimeoutKey = '';
  _autoResolvedTimeoutDecisionIds = new Set<string>();
}
