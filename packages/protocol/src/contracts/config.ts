import type { SafetyTier } from './agents.js';
import type { ProjectBacklogConfig } from './backlog.js';
import type { FailureCategory } from './chat.js';
import type { ResourceDefinition, SlotActionDefinition } from './resources.js';
import type { FlowType } from './runs.js';
import type { PoolSlotMode } from './slots.js';
import type { TaskSchema } from './task.js';

// ─── Config ───

export interface PoolConfig {
  machine: string;
  project: string;
  platform: string;
  os: string;
  host: string;
  sshUser: string;
  tmuxWorkers?: TmuxWorkerFilterConfig;
  slots: Array<{
    id: string;
    enabled: boolean;
    mode: PoolSlotMode;
    project: string;
    repo: string;
    session: string;
    resources?: Record<string, Record<string, string | number | boolean>>;
  }>;
}

export interface TmuxWorkerFilterRule {
  nodeId?: string;
  session?: string;
  target?: string;
  windowName?: string;
  pane?: string;
  paneId?: string;
  title?: string;
  cwd?: string;
  command?: string;
  linkedSlotId?: string;
  linkedRunId?: string;
  linkedFamilyId?: string;
}

export interface TmuxWorkerFilterConfig {
  include?: TmuxWorkerFilterRule[];
  exclude?: TmuxWorkerFilterRule[];
}

export interface ProjectAutoRecoveryConfig {
  enabled?: boolean;
  maxAttempts?: number;
  allowedSteps?: string[];
  allowedCategories?: FailureCategory[];
  disabledPatterns?: string[];
  llm?: { enabled?: boolean; dailyUsdCap?: number; timeoutMs?: number };
}

export interface ProjectPublicationReviewFlowConfig {
  minimumIndependentReviews?: number;
  requireCrossRunner?: boolean;
}

export interface ProjectRoadmapConfig {
  /** Inline project-specific roadmap refinement prompt template. */
  refinementPrompt?: string;
  /** Markdown prompt template path, absolute or relative to projects/<project>/. */
  refinementPromptPath?: string;
  /** Default runner id for roadmap refinement sessions. */
  runner?: string;
  /** Default model for roadmap refinement sessions. */
  model?: string;
  /** Optional command template launched for refinement. Supports {{runner}}, {{model}}, {{prompt_path}}, and {{item_file}}. */
  runnerCommand?: string;
}

// ─── Prepare profiles (ADR-037) ───

/**
 * Optional cost phases a prepare profile may select. Safety invariants (ssh
 * reachability, device existence, tmux session, prepare sentinel, origin/HEAD
 * guard) always run and are not part of this set.
 */
export const PREPARE_PHASES = ['git', 'fixtures', 'deps', 'preflight', 'health'] as const;
export type PreparePhase = (typeof PREPARE_PHASES)[number];

/**
 * Framework-owned precondition checks a profile may require before its cheap
 * path is valid. Each name binds to existing project hooks/sentinels:
 * deps_current → lockfile-hash sentinel, dev_server_up → dev_server_check
 * hook, health_ok → health_check + ready_indicator pipeline.
 */
export const PREPARE_REQUIREMENTS = ['deps_current', 'dev_server_up', 'health_ok'] as const;
export type PrepareRequirement = (typeof PREPARE_REQUIREMENTS)[number];

export interface PrepareProfileConfig {
  /** Operator-facing label for wizard/CLI listings. */
  label?: string;
  /** Longer operator-facing help text for tooltips/docs. */
  description?: string;
  phases: PreparePhase[];
  /** Per-profile hook overrides; unlisted hooks resolve from the project's top-level hooks. */
  hooks?: Record<string, string>;
  requires?: PrepareRequirement[];
  /** Profile to run instead when any `requires` check fails. Required when `requires` is non-empty. */
  fallback?: string;
}

export interface ProjectPrepareConfig {
  /** Profile used when no explicit selection is made. */
  default?: string;
  profiles: Record<string, PrepareProfileConfig>;
}

export interface ProjectConfig {
  name: string;
  repoUrl: string;
  defaultBranch: string;
  /** Linked-worktree idle branch template (e.g. wt/{{session}}). See ADR-042. */
  slotTrackingBranch?: string;
  /** Operator/docs hint for worktree sandboxes. Stale/idle inference uses fleet-probed linkedWorktree on SlotStatus, not this path. */
  worktreeBase?: string;
  apps?: string[];
  paths: { runtimeDir: string; artifactDir: string };
  defaults: Record<string, { runner: string; model: string }>;
  hooks: Record<string, string | Record<string, string>>;
  health: Record<string, string>;
  ci: {
    repo: string;
    prLabels?: string[];
    prTitleSuffix?: string;
    watchChecks: string[];
    checkGroups: ProjectCICheckGroup[];
    botPatterns: Array<{
      author: string;
      label: string;
      defaultAction: 'nudge_worker' | 'alert_only';
      actions?: Array<{ bodyMatch: string; action: 'nudge_worker' | 'alert_only'; label?: string }>;
    }>;
  };
  jira: {
    project: string; // e.g. "TAT" — Jira key prefix
    base_url?: string;
    email_env?: string;
    api_token_env?: string;
  };
  // Project-level safety-tier policy (ADR-023 §3). Applied at run create time
  // when neither the dispatch params nor a parent run supplies an explicit
  // tier. Unset → runner's intrinsic 'sandboxed' fallback.
  defaultSafetyTier?: SafetyTier;
  resources?: Record<string, ResourceDefinition>;
  slotActions?: Record<string, SlotActionDefinition>;
  models?: {
    provider?: string; // default LLM provider (e.g. "anthropic", "openai")
    default_model?: string; // default model (e.g. "haiku", "gpt-4o-mini")
    api_key_env?: string; // env var override for API key
  };
  webhooks?: {
    github_secret?: string; // HMAC secret for GitHub webhook validation
    jira_secret?: string; // token for Jira webhook validation
    auto_dispatch?: boolean; // default true
  };
  ci_watch?: {
    poll_interval_s?: number; // default 60
    max_hold_min?: number; // default 120
    max_total_hold_min?: number; // absolute cap across progress resets
    auto_dispatch?: {
      test_failures?: boolean; // default true
      merge_conflicts?: boolean; // default true
      bot_comments?: boolean; // default true
    };
  };
  auto_recycle?: {
    enabled?: boolean; // default false
    interval_min?: number; // default 5
    max_failures?: number; // default 2
  };
  publicationReview?: Partial<Record<'fix-bug' | 'dev', ProjectPublicationReviewFlowConfig>>;
  autoRecovery?: ProjectAutoRecoveryConfig;
  backlog?: ProjectBacklogConfig;
  roadmap?: ProjectRoadmapConfig;
  prepare?: ProjectPrepareConfig;
  /** When true, UI may offer slow playback and gateway appends --slow to recipe_run. */
  recipeRunSupportsPlaybackSlow?: boolean;
  /** When true, UI may offer video recording and gateway appends --record-video=full-run to recipe_run. */
  recipeRunSupportsVideoRecording?: boolean;
}

export interface ProjectCICheckGroup {
  name: string;
  match: string;
  matchMode: 'exact' | 'includes' | 'regex';
  aggregate: 'all' | 'any' | 'latest';
}

export interface WorkerTemplateOption {
  flowType: FlowType;
  fileName: string;
  variant?: string | null;
  label: string;
  isDefault: boolean;
}

export interface TemplatePreview {
  flowType: string;
  fileName: string;
  schema: TaskSchema;
  placeholders: string[];
  rawMarkdown: string;
}

export interface SlotConfigUpdate {
  enabled?: boolean;
  mode?: PoolSlotMode;
}
