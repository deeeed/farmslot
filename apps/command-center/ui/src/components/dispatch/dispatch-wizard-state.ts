import { LitElement } from 'lit';
import { property, state } from 'lit/decorators.js';

import type {
  DevInteractiveProfile,
  DispatchCandidatesResult,
  FlowType,
  ProjectConfig,
  QueueItem,
  Run,
  SlotStatus,
  WorkerTemplateOption,
} from '@farmslot/protocol';
import { DEFAULT_CLAUDE_MODEL } from '@farmslot/protocol';

import { type EffortLevel } from '../../utils/runner-options.js';

import type { PublicationReviewLoopDraft } from './dispatch-wizard-draft.js';

interface DispatchWizardMockInitialState {
  flowType?: FlowType;
  ticketId?: string;
  normalizedTicket?: string;
  project?: string;
  runner?: string;
  model?: string;
}

export abstract class DispatchWizardState extends LitElement {
  @property({ type: Boolean, attribute: 'mock-mode' }) mockMode = false;
  @property({ attribute: false }) mockCandidates: DispatchCandidatesResult['candidates'] | null =
    null;
  @property({ attribute: false }) mockProjectConfigs: ProjectConfig[] | null = null;
  @property({ attribute: false }) mockInitial: DispatchWizardMockInitialState | null = null;

  @state() _flowType: FlowType | null = null;
  @state() _ticketId = '';
  _normalizedTicket = ''; // server-normalized form for internal matching only
  @state() _model = DEFAULT_CLAUDE_MODEL;
  @state() _runner = 'claude';
  @state() _effort: EffortLevel = '';
  @state() _slotOverride = '';
  @state() _project = '';
  @state() _app = '';
  @state() _availableProjects: string[] = [];
  @state() _projectConfigs: ProjectConfig[] = [];
  @state() _templateOptions: WorkerTemplateOption[] = [];
  @state() _templateOptionsLoading = false;
  @state() _templateOptionsError = '';
  @state() _selectedTaskTemplateFileName = '';
  _templateOptionsKey = '';
  @state() _dispatching = false;
  @state() _error = '';
  @state() _queueItems: QueueItem[] = [];
  @state() _matchingProject = false;
  @state() _autoProject = ''; // project matched from ticket input
  @state() _autoFlowType = false; // flow type was auto-detected from issue type
  @state() _issueType = ''; // Jira issue type (Bug, Task, etc.)
  @state() _skipPrepare = false;
  @state() _devInteractiveProfile: DevInteractiveProfile = 'lightweight';
  @state() _reviewTier: '' | 'light' | 'standard' | 'full' = '';
  @state() _publicationReviewLoops: PublicationReviewLoopDraft[] = [];
  _nextPublicationReviewLoopId = 1;
  @state() _candidates: DispatchCandidatesResult['candidates'] = [];
  /** Per-slot intent for nudge-eligible rows. Tracked separately from `_slotOverride` so
   * flipping selection doesn't lose the intent the operator picked on the other row. */
  _nudgeIntents = new Map<string, 'nudge' | 'fresh'>();
  /** Bumped whenever `_nudgeIntents` mutates so Lit re-renders the wizard rows. (Map mutation
   * isn't observable to @state shallow-equality, so we route changes through a counter.) */
  @state() _nudgeIntentVersion = 0;
  @state() _loadingCandidates = false;
  @state() _loadingProjectConfigs = false;
  @state() _allProjectSlots: SlotStatus[] = [];
  @state() _activeRunConflict: { id: string; status: string } | null = null;
  @state() _hydrating = false;
  @state() _bootstrapFailed = false;
  @state() _connectionStale = false;
  @state() _candidateRefreshFailed = false;
  /** First dispatch.candidates call after a gateway restart pays the SSH cost to
   * refresh branches for every free slot. The default 15s gateway-client timeout is
   * too tight for cold cache (10-30s typical, see refreshBranches in dispatch.ts).
   * Bump the budget for the first call only; once we've seen one success we know the
   * cache is warm and subsequent calls hit it in <50ms. The flag is set ONLY on the
   * success path — a failure means we still don't know whether the cache warmed, so
   * the next attempt keeps the cold-cache budget. */
  _candidatesEverLoaded = false;
  /** Comparison-lane fork context, parsed from #dispatch?lane=comparison&familyId=…&variant=…&parentRunId=… */
  @state() _comparisonLane = false;
  @state() _comparisonFamilyId = '';
  @state() _comparisonVariant = '';
  @state() _comparisonParentRunId = '';
  /** Prior runs sharing the typed ticket — populated by debounced run.list lookup so the wizard can
   *  offer an in-wizard comparison fork without forcing the operator to open run-detail first. */
  @state() _priorRuns: Run[] = [];
  /** Operator-supplied variant suffix used only when the default <runner>-<model> tag would
   *  collide with an existing sibling (same-runner+same-model template/recipe edit comparison). */
  @state() _variantInput = '';
  @state() _variantCollision = false;

  _unsubState?: () => void;
  _unsubConn?: () => void;
  _matchTimer: ReturnType<typeof setTimeout> | null = null;
  _priorRunsTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic generation for prior-runs lookup — prevents stale responses from clobbering newer state. */
  _priorRunsGen = 0;
  /** Last machine filter applied to candidate fetch; used to detect filter flips while the project is unchanged. */
  _lastFetchMachines = '';
  /** Last targetBranch passed to dispatch.candidates; re-fetches when pr.list hydrates and flips this from undefined to a branch. */
  _lastFetchTargetBranch: string | undefined;
  /** Tracks which `(flow, ticket)` pair the previous candidate fetch was for. The scoring
   * context isn't just the ticket — `_resolveTargetBranch` ALSO depends on `_flowType` (only
   * `review-pr` / `pr-complete` look up the PR's head branch). Switching from
   * "no flow" → "PR Complete" with the same ticket re-ranks the candidates server-side, so
   * the prior `_slotOverride` (chosen under no-targetBranch scoring) is stale. Without this
   * key the wizard renders the correct order but highlights a different row. */
  _lastFetchScoringKey: string | undefined;
  /** Monotonic fetch generation. Only the latest fetch's response is applied; earlier in-flight responses are discarded. */
  _fetchGen = 0;
}
