import { AGENT_ROLES, type AgentRole, type FlowType } from '../contracts/index.js';

export { AGENT_ROLES };

export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  primary: 'Primary',
  dev: 'Dev',
  'fix-bug': 'Bugfix',
  review: 'Review',
  'self-review': 'Self-review',
  'self-review-fix': 'Self-review fix',
  'ci-fix': 'CI fix',
};

export const AGENT_ROLE_SHORT_LABELS: Record<AgentRole, string> = {
  primary: 'MAIN',
  dev: 'DEV',
  'fix-bug': 'BUG',
  review: 'REV',
  'self-review': 'S-REV',
  'self-review-fix': 'S-FIX',
  'ci-fix': 'CI',
};

export const AGENT_ROLE_WINDOWS: Record<AgentRole, string | null> = {
  primary: null,
  dev: 'dev',
  'fix-bug': 'bugfix',
  review: 'review',
  'self-review': 'self-review',
  'self-review-fix': null, // runs in the primary worker's window, not a separate one
  'ci-fix': 'ci-fix',
};

// Rank groups keep the flow-owned worker first, then optional review/fix loops
// in the order they are normally spawned. Gaps leave room for new intermediate
// roles without reordering persisted/UI state.
export const AGENT_ROLE_RANKS: Record<AgentRole, number> = {
  primary: 0,
  dev: 1,
  'fix-bug': 2,
  review: 3,
  'self-review': 10,
  'self-review-fix': 20,
  'ci-fix': 30,
};

export function primaryRoleForFlow(flowType?: FlowType | string | null): AgentRole {
  if (flowType === 'dev') return 'dev';
  if (flowType === 'fix-bug') return 'fix-bug';
  if (flowType === 'review-pr') return 'review';
  // Non-worker orchestration flows (pr-complete, merge-main) and null/undefined
  // reuse the default session window instead of claiming a role-scoped worker window.
  if (!flowType || flowType === 'pr-complete' || flowType === 'merge-main') return 'primary';
  throw new Error(`primaryRoleForFlow: unknown flow type '${flowType}'`);
}

export function contextIdFor(role: AgentRole): string {
  return role;
}

export function agentRoleLabel(role: AgentRole): string {
  return AGENT_ROLE_LABELS[role];
}

export function agentRoleShortLabel(role: AgentRole): string {
  return AGENT_ROLE_SHORT_LABELS[role] ?? role.toUpperCase();
}

export function agentRoleWindow(role: AgentRole): string | null {
  return AGENT_ROLE_WINDOWS[role];
}

export function agentRoleRank(role: AgentRole): number {
  const rank = AGENT_ROLE_RANKS[role];
  if (rank === undefined) {
    console.warn(
      `[agent-roles] unknown role rank for '${role}' — this may indicate a gateway/UI version mismatch`,
    );
    return 99;
  }
  return rank;
}

export function signalFileForTask(taskFile?: string | null): string | null {
  if (!taskFile) return null;
  const trimmed = taskFile.trim();
  if (!trimmed) return null;
  // Only derive from scoped task paths. A bare "TASK.md" has no stable
  // context directory; explicit bare signalFile values are resolved by the
  // gateway beside the already-resolved task file instead.
  if (trimmed.startsWith('/') || !trimmed.includes('/')) return null;

  const normalized = trimmed.replace(/\/+$/, '');
  const separator = normalized.lastIndexOf('/');
  if (separator < 0) return null;
  return `${normalized.slice(0, separator)}/SIGNAL.json`;
}

export function agentContextTaskFile(
  taskFile?: string | null,
  activeTaskFile?: string | null,
): string | null {
  return scopedAgentTaskFile(taskFile) ?? scopedAgentTaskFile(activeTaskFile);
}

function scopedAgentTaskFile(taskFile?: string | null): string | null {
  const candidate = taskFile?.trim();
  if (!candidate || candidate.startsWith('/') || !candidate.includes('/')) return null;
  return candidate;
}
