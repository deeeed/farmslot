import {
  isRecipeQualityArtifact,
  RECIPE_QUALITY_ARTIFACT_SOURCES,
  RECIPE_QUALITY_ARTIFACT_VERSION,
  RECIPE_QUALITY_FALLBACK_SOURCES,
  RECIPE_QUALITY_PROOF_MODES,
  RECIPE_QUALITY_VERDICTS,
  type RecipeQualityArtifact,
  type RecipeQualityArtifactSource,
  type RecipeQualityEvidenceMode,
  type RecipeQualityVerdict,
} from '@farmslot/protocol';

type RecipeQualityFallbackSource = Exclude<RecipeQualityArtifactSource, 'worker' | 'gateway'>;

export interface RecipeQualityArtifactBuilderInput {
  verdict: RecipeQualityVerdict;
  reasons: string[];
  betterVersionGuidance?: string[];
  dimensions?: RecipeQualityArtifact['dimensions'];
  structuralFindings?: RecipeQualityArtifact['structural_findings'];
  contextualFindings?: RecipeQualityArtifact['contextual_findings'];
  suggestedRecipeDelta?: string[];
  trainingFields?: RecipeQualityArtifact['training_fields'];
  producer?: RecipeQualityArtifactSource;
  fallbackUsed?: boolean;
  fallbackSource?: RecipeQualityFallbackSource;
  legacyTask?: boolean;
  artifactRequired?: boolean;
  sourceSignals?: string[];
  extra?: Record<string, unknown>;
}

export type BuiltRecipeQualityArtifact = RecipeQualityArtifact & Record<string, unknown>;

const COMPACT_VERDICT_BY_VERDICT: Record<RecipeQualityVerdict, 'PASS' | 'WARN' | 'FAIL'> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
};

const CORE_ARTIFACT_KEYS = new Set([
  'version',
  'verdict',
  'compact',
  'dimensions',
  'structural_findings',
  'contextual_findings',
  'suggested_recipe_delta',
  'training_fields',
  'meta',
]);

function assertRecipeQualityVerdict(value: RecipeQualityVerdict): void {
  if (!RECIPE_QUALITY_VERDICTS.includes(value)) {
    throw new TypeError(`verdict must be one of: ${RECIPE_QUALITY_VERDICTS.join(', ')}.`);
  }
}

function assertRecipeQualityProducer(value: RecipeQualityArtifactSource): void {
  if (!RECIPE_QUALITY_ARTIFACT_SOURCES.includes(value)) {
    throw new TypeError(`producer must be one of: ${RECIPE_QUALITY_ARTIFACT_SOURCES.join(', ')}.`);
  }
}

function assertStringArray(name: string, value: string[]): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${name} must be an array of strings.`);
  }
}

function defaultFallbackUsed(
  producer: RecipeQualityArtifactSource,
  fallbackSource: RecipeQualityFallbackSource | undefined,
): boolean {
  return fallbackSource != null || producer.startsWith('fallback:');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertOptionalPlainRecord(name: string, value: unknown): void {
  if (value != null && !isPlainRecord(value)) {
    throw new TypeError(`${name} must be a JSON object when provided.`);
  }
}

function assertOptionalBoolean(name: string, value: unknown): void {
  if (value != null && typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean when provided.`);
  }
}

function assertOptionalArray(name: string, value: unknown): void {
  if (value != null && !Array.isArray(value)) {
    throw new TypeError(`${name} must be an array when provided.`);
  }
}

function validateTrainingFields(value: RecipeQualityArtifact['training_fields'] | undefined): void {
  assertOptionalPlainRecord('trainingFields', value);
  const proofMode = value?.proof_mode;
  if (proofMode != null && !RECIPE_QUALITY_PROOF_MODES.includes(proofMode)) {
    throw new TypeError(
      `trainingFields.proof_mode must be one of: ${RECIPE_QUALITY_PROOF_MODES.join(', ')}.`,
    );
  }
}

function validateExtraKeys(extra: Record<string, unknown> | undefined): void {
  assertOptionalPlainRecord('extra', extra);
  if (!extra) return;
  for (const key of Object.keys(extra)) {
    if (CORE_ARTIFACT_KEYS.has(key)) {
      throw new TypeError(`extra.${key} cannot override a RecipeQualityArtifact core field.`);
    }
  }
}

/**
 * Builds the canonical `artifacts/recipe-quality.json` payload from the compact
 * fields agents are expected to know after a recipe-quality pass.
 */
export function buildRecipeQualityArtifact(
  input: RecipeQualityArtifactBuilderInput,
): BuiltRecipeQualityArtifact {
  assertRecipeQualityVerdict(input.verdict);
  assertStringArray('reasons', input.reasons);
  if (input.reasons.length === 0) {
    throw new TypeError('reasons must include at least one reason.');
  }
  assertStringArray('betterVersionGuidance', input.betterVersionGuidance ?? []);
  assertStringArray('suggestedRecipeDelta', input.suggestedRecipeDelta ?? []);
  assertStringArray('sourceSignals', input.sourceSignals ?? ['recipe-quality.json']);
  assertOptionalPlainRecord('dimensions', input.dimensions);
  assertOptionalArray('structuralFindings', input.structuralFindings);
  assertOptionalArray('contextualFindings', input.contextualFindings);
  assertOptionalBoolean('fallbackUsed', input.fallbackUsed);
  assertOptionalBoolean('legacyTask', input.legacyTask);
  assertOptionalBoolean('artifactRequired', input.artifactRequired);
  validateTrainingFields(input.trainingFields);
  validateExtraKeys(input.extra);

  const producer = input.producer ?? 'worker';
  assertRecipeQualityProducer(producer);
  const fallbackSource = input.fallbackSource;
  if (fallbackSource != null && !RECIPE_QUALITY_FALLBACK_SOURCES.includes(fallbackSource)) {
    throw new TypeError(
      `fallbackSource must be one of: ${RECIPE_QUALITY_FALLBACK_SOURCES.join(', ')}.`,
    );
  }
  const fallbackUsed = input.fallbackUsed ?? defaultFallbackUsed(producer, fallbackSource);
  if (fallbackSource != null && fallbackUsed === false) {
    throw new TypeError('fallbackUsed cannot be false when fallbackSource is set.');
  }
  if (producer.startsWith('fallback:') && fallbackUsed === false) {
    throw new TypeError('fallbackUsed cannot be false for fallback producers.');
  }
  const artifact: BuiltRecipeQualityArtifact = {
    ...(input.extra ?? {}),
    version: RECIPE_QUALITY_ARTIFACT_VERSION,
    verdict: input.verdict,
    compact: {
      verdict: COMPACT_VERDICT_BY_VERDICT[input.verdict],
      reasons: input.reasons,
      better_version_guidance: input.betterVersionGuidance ?? [],
    },
    dimensions: input.dimensions ?? {},
    structural_findings: input.structuralFindings ?? [],
    contextual_findings: input.contextualFindings ?? [],
    suggested_recipe_delta: input.suggestedRecipeDelta ?? [],
    training_fields: {
      proof_mode: 'unknown' satisfies RecipeQualityEvidenceMode,
      ...(input.trainingFields ?? {}),
    },
    meta: {
      producer,
      fallback_used: fallbackUsed,
      fallback_source: fallbackSource,
      legacy_task: input.legacyTask ?? false,
      artifact_required: input.artifactRequired ?? true,
      source_signals: input.sourceSignals ?? ['recipe-quality.json'],
    },
  };

  if (!isRecipeQualityArtifact(artifact)) {
    throw new TypeError('Built recipe-quality artifact does not satisfy RecipeQualityArtifact.');
  }

  return artifact;
}
