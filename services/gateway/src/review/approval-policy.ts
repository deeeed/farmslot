import { resolveApprovalPolicy } from '@farmslot/protocol/review-approval-policy.cjs';
import { invalidateProjectVarsCache } from '@farmslot/slot-config';

import { loadProjectVars } from '../core/config.js';

/** Completion and refresh must see project policy edits without a restart. */
export async function loadReviewApprovalPolicy(project: string) {
  invalidateProjectVarsCache(project);
  try {
    return resolveApprovalPolicy((await loadProjectVars(project)).projectJson.approvalPolicy);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Project config not found:'))
      return resolveApprovalPolicy();
    throw error;
  }
}
