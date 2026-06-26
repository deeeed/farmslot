import type { RuntimeDecisionReport, RuntimeReadinessDecision } from './decision-types.js';

export interface OrchestrateRuntimeUpOptions<T extends RuntimeDecisionReport = RuntimeDecisionReport> {
  decide: () => Promise<T>;
  onInstall: (report: T) => Promise<void>;
  onLaunch: (report: T) => Promise<void>;
  onReady: (report: T) => Promise<void>;
  onBlocked?: (report: T) => Promise<void>;
  /** Shared flag — set true after first install attempt to prevent loops. */
  installAttempted?: { value: boolean };
}

export interface OrchestrateRuntimeUpResult<T extends RuntimeDecisionReport = RuntimeDecisionReport> {
  report: T;
  exitDecision: RuntimeReadinessDecision;
}

/**
 * Generic install → relaunch decision loop for product runners.
 * Hosts supply shell/platform actions via onInstall/onLaunch/onReady callbacks.
 */
export async function orchestrateRuntimeUp<T extends RuntimeDecisionReport>(
  options: OrchestrateRuntimeUpOptions<T>,
): Promise<OrchestrateRuntimeUpResult<T>> {
  const installFlag = options.installAttempted ?? { value: false };
  const report = await options.decide();

  switch (report.decision) {
    case 'install': {
      if (installFlag.value) {
        throw new Error(`install did not resolve runtime (${report.reasonCode})`);
      }
      installFlag.value = true;
      await options.onInstall(report);
      return orchestrateRuntimeUp({ ...options, installAttempted: installFlag });
    }
    case 'launch':
    case 'relaunch':
    case 'build':
      await options.onLaunch(report);
      return { report, exitDecision: report.decision };
    case 'ready':
      await options.onReady(report);
      return { report, exitDecision: 'ready' };
    case 'blocked':
      if (options.onBlocked) await options.onBlocked(report);
      return { report, exitDecision: 'blocked' };
    default:
      if (options.onBlocked) await options.onBlocked(report);
      return { report, exitDecision: report.decision };
  }
}