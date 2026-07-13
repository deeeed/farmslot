// runner-ids.ts — canonical runner-id vocabulary shared by every surface
// (gateway registry, CLI, slot-config template expansion). Capability data
// stays in the gateway runner registry (ADR-023); this is names only.

export const DEFAULT_RUNNER = 'claude';

export const RUNNER_ALIASES: Record<string, string> = {
  'claude-code': 'claude',
};

export function normalizeRunner(runnerId?: string | null): string {
  const normalized = (runnerId ?? DEFAULT_RUNNER).trim().toLowerCase();
  return (RUNNER_ALIASES[normalized] ?? normalized) || DEFAULT_RUNNER;
}
