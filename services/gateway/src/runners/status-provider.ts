import type { loadSlotVars } from '../core/config.js';

import { claudeHookObservability } from './claude-observability.js';
import { normalizeRunner } from './registry.js';

/**
 * ADR-032 Phase 3: debug-only helper — no production caller. Claude's context-% is sourced solely
 * from the Farmslot statusline JSON via {@link claudeHookObservability}; this pane regex is retained
 * for local diagnostics (comparing a captured pane against the statusline reading) only.
 *
 * Extract Claude's context-window utilization (0-100) from a captured tmux pane. Returns `null`
 * when no `ctx:N%` marker is present (likely cause: pane is on alt-screen, scrolled past the status
 * line, or the runner version dropped the marker).
 */
export function parseClaudeCtxPctFromPane(pane: string): number | null {
  if (!pane) return null;
  // Claude status line: `... | ctx:11% | ...` — match the LAST occurrence so a stale earlier
  // line doesn't shadow the live one.
  const matches = [...pane.matchAll(/\bctx:(\d{1,3})%/gi)];
  const last = matches[matches.length - 1];
  if (last) {
    const n = parseInt(last[1], 10);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  }
  return null;
}

/**
 * Generic status surface for a runner. Lives next to RunnerDefinition so any code that needs
 * runtime info about a worker (context utilization, future: token budget, last-action time,
 * tool-call rate, etc.) calls a typed interface instead of branching on runner id.
 *
 * Implementations choose their own source. Claude prefers Farmslot hook/statusline files and
 * falls back to tmux pane parsing when observability files are absent or stale.
 *
 * Adding a new field: extend this interface, give every existing provider a default impl
 * (typically `null`), and let callers null-check the result.
 */
export interface RunnerStatusProvider {
  /** Current context-window utilization percentage (0-100). Null when unknown. */
  getContextPct(
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    target: string,
  ): Promise<number | null>;
}

const claudeStatusProvider: RunnerStatusProvider = {
  async getContextPct(vars, target) {
    // ADR-032 Phase 3: the Farmslot statusline JSON is the sole ctx-% source for Claude — the
    // hook/statusline command writes a per-session reading and the pane regex
    // (parseClaudeCtxPctFromPane) is retired to a debug helper.
    try {
      const reading = await claudeHookObservability.getContextPct(vars, target);
      if (reading) return reading.value;
    } catch (error) {
      console.warn(
        `[runner-observability] statusline ctxPct read failed for ${vars.slotId}: ${(error as Error).message}`,
      );
    }
    return null;
  },
};

/**
 * Per-runner status provider registry. Runners without an entry expose no status surface; the
 * generic lookup {@link getRunnerStatusProvider} returns `null` and callers render gracefully.
 */
export const KNOWN_RUNNER_STATUS_PROVIDERS: Record<string, RunnerStatusProvider> = {
  claude: claudeStatusProvider,
};

export function getRunnerStatusProvider(runnerId?: string | null): RunnerStatusProvider | null {
  if (!runnerId) return null;
  const norm = normalizeRunner(runnerId);
  return KNOWN_RUNNER_STATUS_PROVIDERS[norm] ?? null;
}
