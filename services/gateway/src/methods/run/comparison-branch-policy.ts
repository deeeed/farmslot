import type { RunCreateParams } from '@farmslot/protocol';

import { buildSmartBranch } from '../../intelligence/engine.js';

function variantSlug(variant: string): string {
  return variant.trim().toLowerCase().replace(/[#\\/]/g, '-');
}

export function branchIncludesVariant(branch: string, variant: string): boolean {
  const slug = variantSlug(variant);
  const normalized = branch.trim().toLowerCase();
  return normalized.endsWith(`-${slug}`) || normalized.includes(`-${slug}-`);
}

/** Comparison siblings need distinct branches; derive when omitted, reject shared production branches. */
export function applyComparisonBranchPolicy(params: RunCreateParams): void {
  if (params.lane !== 'comparison') return;
  const variant = params.variant?.trim();
  if (!variant) return;

  const derived = buildSmartBranch(
    params.flowType,
    params.ticketOrPr,
    undefined,
    undefined,
    variant,
  );

  if (!params.branch?.trim()) {
    params.branch = derived;
    return;
  }

  const branch = params.branch.trim();
  if (!branchIncludesVariant(branch, variant)) {
    throw new Error(
      `Comparison lane branch '${branch}' does not distinguish variant '${variant}'. ` +
        `Omit branch to auto-derive '${derived}', or include the variant suffix.`,
    );
  }
}