/** Project-defined inputs passed unchanged to a shared validation skill. */
export type QaInput = string | number | boolean | null | QaInput[] | { [key: string]: QaInput };

/** Optional form hints for skill inputs. The farm owns their meaning. */
export interface QaInputField {
  path: string;
  title: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  description?: string;
  required?: boolean;
  options?: Array<{ value: string; title: string }>;
}

/** A preset selects a shared workflow; it does not define workflow steps. */
export interface QaProfile {
  id: string;
  title: string;
  description?: string;
  template_id: string;
  inputs?: Record<string, QaInput>;
  input_fields?: QaInputField[];
}

export interface ProjectQaConfig {
  default_profile: string;
  profiles: QaProfile[];
  after_review?: { enabled: boolean; profile_id: string };
}

export interface QaProfileSelection {
  profile: QaProfile;
  inputs: Record<string, QaInput>;
}

/** Captured only when a new static review is admitted with automatic QA enabled. */
export interface QaAfterReview {
  version: 1;
  capturedAt: string;
  selection: QaProfileSelection;
  execution?: import('./pr-monitoring.js').PRExecutionProfile;
  review: import('./pr-rules.js').PRReviewOptions;
  state: 'pending' | 'blocked' | 'submitted';
  teamId?: string;
  submissionId?: string;
  intentId?: string;
  checkedAt?: string;
  error?: string;
}

/** Retained only as provenance when an old combined review request is normalized. */
export interface LegacyReviewSettings {
  validationDepth?: string;
  tier?: string;
  recipeStrategy?: string;
  executionTemplateId?: string;
  executionTemplate?: import('./execution-templates.js').ExecutionTemplateReference;
  taskTemplate?: import('./evals.js').TaskTemplateSelection;
  taskFile?: string;
}

/** Marks an execution that uses separate static Review and runtime QA semantics. */
export interface ReviewQaContract {
  version: 1;
  legacy?: LegacyReviewSettings;
}

export interface ReviewQaDispatchInput {
  flowType: string;
  executionTemplateId?: string;
  taskTemplate?: import('./evals.js').TaskTemplateSelection;
  reviewValidationDepth?: string;
  reviewTier?: string;
  recipeStrategy?: string;
  qaProfileId?: string;
  qaInputs?: Record<string, QaInput>;
}

export type ReviewQaDispatchSelection =
  | { flowType: 'review-pr'; contract: ReviewQaContract; qa?: never }
  | { flowType: 'qa'; contract: ReviewQaContract; qa: QaProfileSelection };

export class ReviewQaConfigurationError extends Error {
  readonly code = 'REVIEW_QA_NEEDS_CONFIGURATION';
}

/** Apply at unstarted intake boundaries; running and historical records keep their contract. */
export function resolveReviewQaDispatch(
  input: ReviewQaDispatchInput,
  config?: ProjectQaConfig,
): ReviewQaDispatchSelection | undefined {
  if (input.flowType !== 'review-pr' && input.flowType !== 'qa') {
    if (input.qaProfileId !== undefined || input.qaInputs !== undefined) {
      throw new ReviewQaConfigurationError('QA preset inputs require the QA flow');
    }
    return undefined;
  }
  const depth = input.reviewValidationDepth;
  const tier = input.reviewTier?.trim();
  const strategy = input.recipeStrategy?.trim();
  if (depth !== undefined && depth !== 'static-code' && depth !== 'full-live') {
    throw new ReviewQaConfigurationError(`Unknown legacy review validation depth: ${depth}`);
  }
  if (tier && !['light', 'standard', 'full'].includes(tier)) {
    throw new ReviewQaConfigurationError(`Unknown legacy review tier: ${tier}`);
  }
  if (strategy && !['smoke', 'targeted', 'full-qa'].includes(strategy)) {
    throw new ReviewQaConfigurationError(`Unknown legacy recipe strategy: ${strategy}`);
  }
  if (input.flowType === 'qa' && depth === 'static-code') {
    throw new ReviewQaConfigurationError(
      'QA conflicts with a static review depth; choose one flow',
    );
  }
  if (input.flowType === 'review-pr' && depth !== 'full-live') {
    if (strategy || (tier && (depth === undefined || tier !== 'light'))) {
      throw new ReviewQaConfigurationError(
        'Legacy review tier or recipe strategy is ambiguous; select Review or a QA preset',
      );
    }
    if (input.qaProfileId !== undefined || input.qaInputs !== undefined) {
      throw new ReviewQaConfigurationError('Static Review cannot select a QA preset; use Run QA');
    }
  }
  const legacy: LegacyReviewSettings = {
    ...(depth !== undefined ? { validationDepth: depth } : {}),
    ...(tier ? { tier } : {}),
    ...(strategy ? { recipeStrategy: strategy } : {}),
    ...(input.flowType === 'review-pr' && depth === 'full-live'
      ? {
          ...(input.executionTemplateId ? { executionTemplateId: input.executionTemplateId } : {}),
          ...(input.taskTemplate ? { taskTemplate: input.taskTemplate } : {}),
        }
      : {}),
  };
  const contract: ReviewQaContract = {
    version: 1,
    ...(Object.keys(legacy).length ? { legacy } : {}),
  };
  if (input.flowType === 'qa' || depth === 'full-live') {
    if (!config) {
      throw new ReviewQaConfigurationError("Configure this farm's QA presets before launching QA");
    }
    const qa = selectQaProfile(config, input.qaProfileId, input.qaInputs);
    if (
      input.flowType === 'qa' &&
      (input.taskTemplate ||
        (input.executionTemplateId && input.executionTemplateId !== qa.profile.template_id))
    ) {
      throw new ReviewQaConfigurationError(
        'QA execution template must match the selected farm preset',
      );
    }
    return { flowType: 'qa', contract, qa };
  }
  return { flowType: 'review-pr', contract };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isInput(value: unknown): value is QaInput {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isInput);
  return isRecord(value) && Object.values(value).every(isInput);
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(`${field} must be a nonempty string without surrounding whitespace`);
  }
}

function requireFields(value: Record<string, unknown>, allowed: string[], field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${field}.${unknown} is not a supported preset field`);
}

export function validateQaConfig(value: unknown): asserts value is ProjectQaConfig {
  if (!isRecord(value)) throw new Error('qa must be an object');
  requireFields(value, ['default_profile', 'profiles', 'after_review'], 'qa');
  requireText(value.default_profile, 'qa.default_profile');
  if (!Array.isArray(value.profiles) || value.profiles.length === 0) {
    throw new Error('qa.profiles must contain at least one preset');
  }
  const ids = new Set<string>();
  for (const [index, profile] of value.profiles.entries()) {
    const field = `qa.profiles[${index}]`;
    if (!isRecord(profile)) throw new Error(`${field} must be an object`);
    requireFields(
      profile,
      ['id', 'title', 'description', 'template_id', 'inputs', 'input_fields'],
      field,
    );
    requireText(profile.id, `${field}.id`);
    requireText(profile.title, `${field}.title`);
    requireText(profile.template_id, `${field}.template_id`);
    if (profile.description !== undefined) requireText(profile.description, `${field}.description`);
    if (ids.has(profile.id)) throw new Error(`Duplicate QA preset id: ${profile.id}`);
    ids.add(profile.id);
    if (
      profile.inputs !== undefined &&
      (!isRecord(profile.inputs) || !Object.values(profile.inputs).every(isInput))
    ) {
      throw new Error(`${field}.inputs must be an object containing JSON values`);
    }
    if (profile.input_fields !== undefined) {
      if (!Array.isArray(profile.input_fields))
        throw new Error(`${field}.input_fields must be an array`);
      const paths = new Set<string>();
      for (const input of profile.input_fields) {
        if (!isRecord(input)) throw new Error(`${field}.input_fields entries must be objects`);
        requireFields(
          input,
          ['path', 'title', 'type', 'description', 'required', 'options'],
          `${field}.input_fields`,
        );
        requireText(input.path, 'QA field path');
        requireText(input.title, 'QA field title');
        if (
          !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(input.path) ||
          input.path
            .split('.')
            .some((part) => ['__proto__', 'constructor', 'prototype'].includes(part))
        )
          throw new Error('QA field path is invalid');
        if (paths.has(input.path)) throw new Error(`Duplicate QA field: ${input.path}`);
        paths.add(input.path);
        if (!['text', 'number', 'boolean', 'select'].includes(String(input.type)))
          throw new Error('QA field type is invalid');
        if (input.required !== undefined && typeof input.required !== 'boolean')
          throw new Error('QA field required must be boolean');
        if (input.description !== undefined) requireText(input.description, 'QA field description');
        if (input.type === 'select') {
          if (!Array.isArray(input.options) || !input.options.length)
            throw new Error('QA select field needs options');
          const values = new Set<string>();
          for (const option of input.options) {
            if (!isRecord(option)) throw new Error('QA field option must be an object');
            requireFields(option, ['value', 'title'], 'QA field option');
            requireText(option.value, 'QA option value');
            requireText(option.title, 'QA option title');
            if (values.has(option.value)) throw new Error('QA option values must be unique');
            values.add(option.value);
          }
        } else if (input.options !== undefined) throw new Error('Only select fields have options');
      }
    }
  }
  if (!ids.has(value.default_profile)) {
    throw new Error(`QA default preset does not exist: ${value.default_profile}`);
  }
  if (value.after_review !== undefined) {
    if (!isRecord(value.after_review)) throw new Error('qa.after_review must be an object');
    requireFields(value.after_review, ['enabled', 'profile_id'], 'qa.after_review');
    if (typeof value.after_review.enabled !== 'boolean')
      throw new Error('qa.after_review.enabled must be boolean');
    requireText(value.after_review.profile_id, 'qa.after_review.profile_id');
    if (!ids.has(value.after_review.profile_id))
      throw new Error('Automatic QA profile does not exist');
  }
}

export function captureQaAfterReview(
  config: ProjectQaConfig | undefined,
  defaults: import('./config.js').PRWorkflowPolicy,
): QaAfterReview | undefined {
  if (!config?.after_review?.enabled) return undefined;
  const selection = selectQaProfile(
    config,
    config.after_review.profile_id,
    defaults.review?.qaInputs,
  );
  const {
    validationDepth: _legacyDepth,
    busySession: _busySession,
    ...review
  } = defaults.review ?? {
    sessionIntent: 'reset' as const,
    scope: 'full' as const,
  };
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    selection,
    ...(defaults.execution ? { execution: structuredClone(defaults.execution) } : {}),
    review: {
      ...structuredClone(review),
      sessionIntent: 'reset',
      scope: 'full',
      workflow: 'qa',
      qaProfileId: selection.profile.id,
      qaInputs: structuredClone(selection.inputs),
    },
    state: 'pending',
  };
}

/** Returns a detached snapshot so configuration edits cannot change an admitted task. */
export function selectQaProfile(
  config: ProjectQaConfig | undefined,
  requestedId?: string,
  inputs: Record<string, QaInput> = {},
): QaProfileSelection {
  if (!config) throw new ReviewQaConfigurationError('This farm has no QA presets configured');
  validateQaConfig(config);
  if (requestedId !== undefined) requireText(requestedId, 'QA preset id');
  if (!isRecord(inputs) || !Object.values(inputs).every(isInput)) {
    throw new Error('QA inputs must be an object containing JSON values');
  }
  const id = requestedId ?? config.default_profile;
  const profile = config.profiles.find((entry) => entry.id === id);
  if (!profile)
    throw new ReviewQaConfigurationError(`QA preset does not exist in this farm: ${id}`);
  const selection: QaProfileSelection = JSON.parse(
    JSON.stringify({ profile, inputs: { ...profile.inputs, ...inputs } }),
  );
  for (const field of profile.input_fields ?? []) {
    const value = qaInputFieldValue(selection.inputs, field.path);
    const missing =
      value === undefined || value === null || (typeof value === 'string' && !value.trim());
    if (missing) {
      if (field.required) throw new ReviewQaConfigurationError(`${field.title} is required`);
      continue;
    }
    if (
      (field.type === 'text' && typeof value !== 'string') ||
      (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) ||
      (field.type === 'boolean' && typeof value !== 'boolean') ||
      (field.type === 'select' && !field.options?.some((option) => option.value === value))
    )
      throw new ReviewQaConfigurationError(`${field.title} has an invalid value`);
  }
  return selection;
}

export function qaInputFieldValue(
  inputs: Record<string, QaInput>,
  path: string,
): QaInput | undefined {
  let value: QaInput | undefined = inputs;
  for (const part of path.split('.'))
    value = isRecord(value) ? (value[part] as QaInput | undefined) : undefined;
  return value;
}

/** Skill-resolved runtime evidence index, written as artifacts/qa-result.json. */
export interface QaResult {
  version: 1;
  runId: string;
  /** Exact admitted preset and effective inputs from inputs/qa.json. */
  qa: QaProfileSelection;
  /** Immutable source range resolved by the skill, checked against the prepared checkout. */
  source: { baseSha: string; headSha: string };
  /** Suite directory relative to artifacts/, using existing Recipe v1 suite scope/result files. */
  suitePath: string;
  /** Retained skill scope and suite binding, using canonical JSON SHA-256 digests. */
  scope: { path: string; digest: string; suiteDigest: string };
  /** Case id to complete recipe package directory, relative to artifacts/. */
  packages: Record<string, string>;
  /** Existing case/proof target selected by the farm skill as the runtime smoke check. */
  smoke: { caseId: string; proofTarget: string };
}
