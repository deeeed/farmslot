import {
  type RecipeExecutionApproval,
  type RecipeSourceKind,
  type RecipeSourceProvenance,
} from '@farmslot/protocol';

import { invalidRecipeSource } from './trust-error.js';

export const RECIPE_TRUST_ENV = {
  sourceTrust: 'FARMSLOT_RECIPE_SOURCE_TRUST',
  sourceKind: 'FARMSLOT_RECIPE_SOURCE_KIND',
  sourceName: 'FARMSLOT_RECIPE_SOURCE_NAME',
  sourceDigest: 'FARMSLOT_RECIPE_SOURCE_DIGEST',
  approvalDigest: 'FARMSLOT_RECIPE_APPROVE_PLAN',
} as const;

const sourceTrustValues = new Set(['trusted', 'untrusted', 'unknown']);
const sourceKindValues = new Set([
  'bundled',
  'operator',
  'task',
  'recipe-file',
  'uses-catalog',
  'library',
  'custom-adapter',
]);

export interface RecipeTrustInput {
  source?: RecipeSourceProvenance;
  approval?: RecipeExecutionApproval;
}

export function resolveRecipeTrustInput(
  options: {
    sourceTrust?: string;
    sourceKind?: string;
    sourceName?: string;
    sourceDigest?: string;
    approvalDigest?: string;
  } = {},
  env: Record<string, string | undefined> = process.env,
): RecipeTrustInput {
  const optionSource = parseSource(options, 'option');
  const environmentSource = parseSource(
    {
      sourceTrust: env[RECIPE_TRUST_ENV.sourceTrust],
      sourceKind: env[RECIPE_TRUST_ENV.sourceKind],
      sourceName: env[RECIPE_TRUST_ENV.sourceName],
      sourceDigest: env[RECIPE_TRUST_ENV.sourceDigest],
    },
    'environment',
  );
  const source = restrictSource(environmentSource, optionSource);
  const approvalDigest = options.approvalDigest ?? env[RECIPE_TRUST_ENV.approvalDigest];

  return {
    ...(source ? { source } : {}),
    ...(approvalDigest ? { approval: { planDigest: approvalDigest } } : {}),
  };
}

function parseSource(
  values: {
    sourceTrust?: string;
    sourceKind?: string;
    sourceName?: string;
    sourceDigest?: string;
  },
  input: 'option' | 'environment',
): RecipeSourceProvenance | undefined {
  const { sourceTrust, sourceKind, sourceName, sourceDigest } = values;
  if ((sourceTrust == null) !== (sourceKind == null)) {
    throw invalidRecipeSource(
      `Recipe source trust and kind must be supplied together in the ${input}.`,
      `set both ${RECIPE_TRUST_ENV.sourceTrust} and ${RECIPE_TRUST_ENV.sourceKind}`,
    );
  }
  if ((sourceName != null || sourceDigest != null) && (sourceTrust == null || sourceKind == null)) {
    throw invalidRecipeSource(
      `Recipe source name or digest requires source trust and kind in the ${input}.`,
      `set both ${RECIPE_TRUST_ENV.sourceTrust} and ${RECIPE_TRUST_ENV.sourceKind}`,
    );
  }
  if (sourceTrust && !sourceTrustValues.has(sourceTrust)) {
    throw invalidRecipeSource(
      `Unknown recipe source trust ${JSON.stringify(sourceTrust)}.`,
      'use trusted, untrusted, or unknown',
    );
  }
  if (sourceKind && !sourceKindValues.has(sourceKind)) {
    throw invalidRecipeSource(
      `Unknown recipe source kind ${JSON.stringify(sourceKind)}.`,
      'use a Recipe Protocol source kind reported by the runner',
    );
  }

  if (!sourceTrust || !sourceKind) return undefined;
  return {
    trust: sourceTrust as RecipeSourceProvenance['trust'],
    kind: sourceKind as RecipeSourceKind,
    ...(sourceName ? { name: sourceName } : {}),
    ...(sourceDigest ? { digest: sourceDigest } : {}),
  };
}

function restrictSource(
  environmentSource: RecipeSourceProvenance | undefined,
  optionSource: RecipeSourceProvenance | undefined,
): RecipeSourceProvenance | undefined {
  if (!environmentSource) return optionSource;
  if (!optionSource) return environmentSource;
  if (environmentSource.trust !== 'trusted') return environmentSource;
  return optionSource;
}
