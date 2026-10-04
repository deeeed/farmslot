// Recipe trust input from the command line, and the envelope a trust or
// approval failure reports.
import type {
  RecipeExecutionApproval,
  RecipeSourceKind,
  RecipeSourceProvenance,
  RecipeSourceTrust,
} from '@farmslot/protocol';

/** Source provenance and plan approval from explicit flags; absent flags add nothing. */
export function explicitRecipeTrustOptions(values: {
  sourceTrust?: string;
  sourceKind?: string;
  sourceName?: string;
  sourceDigest?: string;
  approvalDigest?: string;
}): { source?: RecipeSourceProvenance; approval?: RecipeExecutionApproval } {
  const { sourceTrust, sourceKind, sourceName, sourceDigest, approvalDigest } = values;
  const source =
    sourceTrust || sourceKind || sourceName || sourceDigest
      ? {
          trust: (sourceTrust ?? 'unknown') as RecipeSourceTrust,
          kind: (sourceKind ?? 'recipe-file') as RecipeSourceKind,
          ...(sourceName ? { name: sourceName } : {}),
          ...(sourceDigest ? { digest: sourceDigest } : {}),
        }
      : undefined;
  return {
    ...(source ? { source } : {}),
    ...(approvalDigest ? { approval: { planDigest: approvalDigest } } : {}),
  };
}

// A type alias, so the envelope passes as a plain JSON record.
export type RecipeTrustFailure = {
  code: string;
  message: string;
  userAction: string;
  details?: {
    recipeDigest?: string;
    trust?: string;
    blocked?: Array<{
      nodeId: string;
      action: string;
      capabilities: string[];
      source: string;
      implementation?: {
        kind?: string;
        trust?: string;
        digest?: string;
      };
    }>;
  };
};

/**
 * A `RECIPE_*` trust error as a command envelope, without the blocked nodes'
 * payloads; undefined for any other error.
 */
export function recipeTrustFailure(error: unknown): RecipeTrustFailure | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as Record<string, unknown>;
  if (
    typeof value.code !== 'string' ||
    !value.code.startsWith('RECIPE_') ||
    typeof value.message !== 'string' ||
    typeof value.userAction !== 'string'
  )
    return undefined;
  const failure =
    value.failure && typeof value.failure === 'object'
      ? (value.failure as Record<string, unknown>)
      : undefined;
  const blocked = Array.isArray(failure?.blocked)
    ? failure.blocked.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const node = entry as Record<string, unknown>;
        if (
          typeof node.nodeId !== 'string' ||
          typeof node.action !== 'string' ||
          !Array.isArray(node.capabilities)
        )
          return [];
        const origin =
          node.origin && typeof node.origin === 'object'
            ? (node.origin as Record<string, unknown>)
            : undefined;
        const adapterOrigin =
          node.adapterOrigin && typeof node.adapterOrigin === 'object'
            ? (node.adapterOrigin as Record<string, unknown>)
            : undefined;
        const implementation = adapterOrigin
          ? {
              ...(typeof adapterOrigin.kind === 'string' ? { kind: adapterOrigin.kind } : {}),
              ...(typeof adapterOrigin.trust === 'string' ? { trust: adapterOrigin.trust } : {}),
              ...(typeof adapterOrigin.digest === 'string' ? { digest: adapterOrigin.digest } : {}),
            }
          : undefined;
        return [
          {
            nodeId: node.nodeId,
            action: node.action,
            capabilities: node.capabilities.filter(
              (item): item is string => typeof item === 'string',
            ),
            source: typeof origin?.kind === 'string' ? origin.kind : 'unknown',
            ...(implementation && Object.keys(implementation).length > 0 ? { implementation } : {}),
          },
        ];
      })
    : undefined;
  const recipeDigest = typeof failure?.recipeDigest === 'string' ? failure.recipeDigest : undefined;
  const userAction =
    recipeDigest &&
    (value.code === 'RECIPE_TRUST_REQUIRED' || value.code === 'RECIPE_APPROVAL_MISMATCH') &&
    !value.userAction.includes('execution environment')
      ? `${value.userAction}; rerun with the same project root, artifact directory, and execution environment`
      : value.userAction;
  return {
    code: value.code,
    message: value.message,
    userAction,
    ...(failure
      ? {
          details: {
            // Farmslot reports the approved execution plan digest as
            // recipeDigest in failures; approval input names it planDigest.
            ...(recipeDigest ? { recipeDigest } : {}),
            ...(typeof failure.trust === 'string' ? { trust: failure.trust } : {}),
            ...(blocked?.length ? { blocked } : {}),
          },
        }
      : {}),
  };
}
