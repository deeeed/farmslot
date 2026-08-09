import { Methods } from './registry.js';

export const IntelligenceMethods = {
  actionsSummary: Methods.INTELLIGENCE_ACTIONS_SUMMARY,
  finetuneIndex: Methods.FINETUNE_INDEX,
  finetuneExportSft: Methods.FINETUNE_EXPORT_SFT,
  finetuneExportDpo: Methods.FINETUNE_EXPORT_DPO,
  llmAuthList: Methods.LLM_AUTH_LIST,
  llmAuthAdd: Methods.LLM_AUTH_ADD,
  llmAuthRemove: Methods.LLM_AUTH_REMOVE,
  llmAuthTest: Methods.LLM_AUTH_TEST,
  llmAuthImport: Methods.LLM_AUTH_IMPORT,
  llmAuthRefresh: Methods.LLM_AUTH_REFRESH,
  llmAuthLogin: Methods.LLM_AUTH_LOGIN,
  improvementChat: Methods.IMPROVEMENT_CHAT,
  improvementApply: Methods.IMPROVEMENT_APPLY,
  llmConfigGet: Methods.LLM_CONFIG_GET,
  llmConfigSet: Methods.LLM_CONFIG_SET,
  llmTiers: Methods.LLM_TIERS,
} as const;

// ─── Fine-tuning data export param/result types ───

export interface FinetuneIndexParams {
  project?: string;
}

export interface FinetuneIndexResult {
  runs: Array<{
    id: string;
    flowType: string;
    project: string;
    ticketOrPr: string;
    outcome: string;
    humanGrade?: string;
    model: string;
    durationMs: number;
    stepCount: number;
    hasGrade: boolean;
  }>;
  stats: {
    total: number;
    graded: number;
    good: number;
    ok: number;
    bad: number;
  };
}

export interface FinetuneExportSFTParams {
  project?: string;
  minGrade?: string;
}

export interface FinetuneExportSFTResult {
  examples: Array<{
    runId: string;
    flowType: string;
    ticketOrPr: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    label: string;
  }>;
}

export interface FinetuneExportDPOParams {
  project?: string;
}

export interface FinetuneExportDPOResult {
  pairs: Array<{
    ticketOrPr: string;
    chosen: { runId: string; model: string; grade: string; outputs: Record<string, unknown> };
    rejected: { runId: string; model: string; grade: string; outputs: Record<string, unknown> };
  }>;
}

// ─── LLM Auth param/result types ───

export interface LLMAuthListResult {
  profiles: Array<{
    profileId: string;
    provider: string;
    type: string;
    hasKey: boolean;
    /** OAuth access-token expiry (ms epoch). Undefined for non-oauth credentials or when not stored. */
    expires?: number;
    /** OAuth account email when the provider returned one. */
    email?: string;
    /** Has a refresh token available — UI uses this to gate the "Refresh OAuth" button. */
    hasRefresh?: boolean;
  }>;
  envProviders: string[];
  openclawProviders: string[];
}

export interface LLMAuthAddParams {
  provider: string;
  type: 'api_key' | 'token';
  credential: string;
  profileId?: string; // defaults to "provider:default"
}

export interface LLMAuthAddResult {
  profileId: string;
}

export interface LLMAuthRemoveParams {
  profileId: string;
}

export interface LLMAuthRemoveResult {
  ok: boolean;
}

export interface LLMAuthTestParams {
  provider?: string;
  model?: string;
}

export interface LLMAuthTestResult {
  ok: boolean;
  provider: string;
  model: string;
  source?: string;
  responsePreview?: string;
  usage?: import('../recipes/step-io.js').StepLLMUsage;
  error?: string;
}

export interface LLMAuthImportResult {
  imported: number;
  profiles: string[];
  /** Profiles that were skipped because a same-named profile already existed locally and `overwrite` was false. */
  skippedExisting?: string[];
  /** Profiles that were replaced because `overwrite` was true. */
  overwritten?: string[];
}

export interface LLMAuthImportParams {
  source?: 'local' | 'remote';
  host?: string;
  sshUser?: string;
  /** When true, replace existing local profiles that share an id with an incoming profile. */
  overwrite?: boolean;
}

export interface LLMAuthRefreshParams {
  /** Refresh a single profile. When omitted, refresh every OAuth profile in the local store. */
  profileId?: string;
}

export interface LLMAuthRefreshOutcome {
  ok: boolean;
  profileId: string;
  expiresBefore?: number;
  expiresAfter?: number;
  error?: string;
}

export interface LLMAuthRefreshResult {
  outcomes: LLMAuthRefreshOutcome[];
}

export interface LLMAuthLoginParams {
  /** Provider id to log in with. Currently supports `openai-codex`. */
  provider: string;
  /** Override default profile id. Defaults to `<provider>:default` (or `<provider>:<email>` if the OAuth flow returns one). */
  profileId?: string;
}

export interface LLMAuthLoginResult {
  ok: boolean;
  /** Persisted profile id on success. */
  profileId?: string;
  /** OAuth account email when the provider returned one. */
  email?: string;
  /** Failure reason. */
  error?: string;
}

/**
 * Streaming progress events emitted while {@link LLMAuthLoginResult} is in
 * flight. Surface them on the WS `event` channel under topic
 * `llm.auth.login.progress`.
 */
export interface LLMAuthLoginProgress {
  provider: string;
  /** Authorization URL to open in a browser. */
  url?: string;
  /** Free-form status update from the OAuth flow. */
  message?: string;
  /** Optional one-time manual code prompt for fallback paste flow. */
  manualPrompt?: { message: string; placeholder?: string };
}

// ─── LLM Config param/result types ───

// ─── Improvement param/result types ───

export interface ImprovementChatParams {
  runId: string;
  decisionId: string;
  message: string;
}

export interface ImprovementChatResult {
  text: string;
  updatedChanges?: import('../contracts/index.js').ImprovementFileChange[];
}

export interface ImprovementApplyParams {
  runId: string;
  decisionId: string;
}

export interface ImprovementApplyResult {
  applied: import('../contracts/index.js').ImprovementFileChange[];
  validationPassed: boolean;
  validationOutput?: string;
  /**
   * Changes the apply refused, with the reason. `stale-anchor`: the file on
   * disk no longer matches the card's `before` snapshot (another card or a
   * human edit landed since proposal) — refine the card so it re-reads the
   * current file. `suspicious-shrink`: `after` deletes a large share of the
   * file, the signature of a truncated LLM payload — re-propose with the
   * complete content, or make deliberate large deletions by hand.
   * `truncated-tail`: the payload grew the file but lost its trailing
   * newline — the mid-line-cut signature of a truncated submission.
   * `write-error`: the write or git stage failed (see gateway logs).
   */
  refused?: {
    filePath: string;
    reason:
      | 'stale-anchor'
      | 'suspicious-shrink'
      | 'truncated-tail'
      | 'out-of-project'
      | 'write-error';
  }[];
}

export interface LLMConfigGetResult {
  defaultProvider: string;
  copilotModel: string;
  intelligenceModel: string;
  improvementModel?: string;
}

export interface LLMConfigSetParams {
  defaultProvider?: string;
  copilotModel?: string;
  intelligenceModel?: string;
  improvementModel?: string;
}

export interface LLMConfigSetResult {
  ok: true;
}

export interface LLMTiersResult {
  tiers: Record<string, Record<string, string>>;
}
