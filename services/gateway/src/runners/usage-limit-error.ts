/**
 * Typed provider usage-limit error — not an autoAction keystroke.
 * Parallel to SLOT_CLAIM_REFUSED: orchestrator/DISPATCH can branch without string matching.
 */

export const PROVIDER_USAGE_LIMIT_CODE = 'PROVIDER_USAGE_LIMIT';

export interface ProviderUsageLimitError extends Error {
  code: typeof PROVIDER_USAGE_LIMIT_CODE;
  accountLabel: string;
  provider: string;
  triedLabels?: string[];
  earliestExpiry?: string | null;
}

export function createProviderUsageLimitError(options: {
  accountLabel: string;
  provider?: string;
  summary?: string;
  triedLabels?: string[];
  earliestExpiry?: string | null;
}): ProviderUsageLimitError {
  const provider = options.provider ?? 'codex';
  const tried = options.triedLabels?.length
    ? ` Tried accounts: ${options.triedLabels.join(', ')}.`
    : '';
  const expiry = options.earliestExpiry
    ? ` Earliest cooling expiry: ${options.earliestExpiry}.`
    : '';
  const base =
    options.summary?.trim() ||
    `Provider usage limit for account '${options.accountLabel}' (${provider}).`;
  const err = new Error(`${base}${tried}${expiry}`) as ProviderUsageLimitError;
  err.name = 'ProviderUsageLimitError';
  err.code = PROVIDER_USAGE_LIMIT_CODE;
  err.accountLabel = options.accountLabel;
  err.provider = provider;
  err.triedLabels = options.triedLabels;
  err.earliestExpiry = options.earliestExpiry ?? null;
  return err;
}

export function isProviderUsageLimitError(err: unknown): err is ProviderUsageLimitError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === PROVIDER_USAGE_LIMIT_CODE
  );
}

export function createNoEligibleProviderAccountError(options: {
  triedLabels: string[];
  earliestExpiry?: string | null;
  provider?: string;
}): ProviderUsageLimitError {
  const provider = options.provider ?? 'codex';
  const list = options.triedLabels.length ? options.triedLabels.join(', ') : '(none)';
  const expiry = options.earliestExpiry
    ? ` Earliest cooling expiry: ${options.earliestExpiry}.`
    : '';
  return createProviderUsageLimitError({
    accountLabel: options.triedLabels[0] ?? 'none',
    provider,
    summary: `No eligible ${provider} provider account remains. Accounts considered: ${list}.${expiry}`,
    triedLabels: options.triedLabels,
    earliestExpiry: options.earliestExpiry,
  });
}
