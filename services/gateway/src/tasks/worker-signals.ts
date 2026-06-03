import type { WorkerSignal, WorkerTerminalDisposition } from '@farmslot/protocol';

/**
 * Runner-neutral worker signal helpers.
 *
 * Recovery should be based on the durable agent context + signal-file protocol,
 * not on runner/model-specific panes or replayed pipeline-step timestamps.
 */

export function parseFiniteIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function isTerminalWorkerSignal(signal: WorkerSignal): boolean {
  return (
    signal.status === 'complete' ||
    signal.status === 'failed' ||
    signal.status === 'done' ||
    signal.status === 'blocked'
  );
}

export function terminalWorkerSignalFromRaw(raw: string): WorkerSignal | undefined {
  if (!raw.trim()) return undefined;
  const parsed = JSON.parse(raw) as WorkerSignal;
  const result = normalizeWorkerSignal(parsed);
  if (!result.ok) return undefined;
  const signal = result.signal;
  return isTerminalWorkerSignal(signal) ? signal : undefined;
}

export function isNoCodeTerminalDisposition(
  disposition: WorkerTerminalDisposition | null | undefined,
): disposition is 'already_fixed' | 'not_reproducible' {
  return disposition === 'already_fixed' || disposition === 'not_reproducible';
}

function hasEvidenceArtifact(signal: WorkerSignal): boolean {
  return Boolean(
    signal.evidence?.reportPath?.trim() ||
    (Array.isArray(signal.evidence?.artifacts) &&
      signal.evidence.artifacts.some(
        (artifact) => typeof artifact === 'string' && artifact.trim().length > 0,
      )),
  );
}

function invalidNoChangeSignal(signal: WorkerSignal, reason: string): WorkerSignal {
  return {
    ...signal,
    status: 'blocked',
    outcome: 'partial',
    disposition: 'blocked',
    reason: `Invalid no-change signal: ${reason}${signal.reason ? `; worker reason: ${signal.reason}` : ''}`,
  };
}

function validateNoChangeEvidence(signal: WorkerSignal): string | null {
  if (signal.evidence?.noCodeChange !== true) return 'evidence.noCodeChange must be true';
  if (!hasEvidenceArtifact(signal)) return 'evidence.reportPath or evidence.artifacts is required';
  if (
    signal.disposition === 'not_reproducible' &&
    signal.evidence?.reproductionAttempted !== true
  ) {
    return 'not_reproducible requires evidence.reproductionAttempted=true';
  }
  return null;
}

export type WorkerSignalNormalizationResult =
  | { ok: true; signal: WorkerSignal; warning?: string }
  | { ok: false; reason: string };

export function normalizeWorkerSignal(signal: WorkerSignal): WorkerSignalNormalizationResult {
  if (!signal.status) return { ok: false, reason: 'missing status' };

  const status = signal.status;
  if (!['running', 'blocked', 'complete', 'failed', 'done'].includes(status)) {
    return { ok: false, reason: `unknown status: ${status}` };
  }

  const disposition = signal.disposition;
  if (
    disposition &&
    !['fixed', 'already_fixed', 'not_reproducible', 'blocked', 'failed'].includes(disposition)
  ) {
    return { ok: false, reason: `unknown disposition: ${disposition}` };
  }

  if (isNoCodeTerminalDisposition(disposition)) {
    if (status !== 'complete' && status !== 'done') {
      return {
        ok: true,
        signal: invalidNoChangeSignal(
          signal,
          `status ${status} is incompatible with ${disposition}`,
        ),
      };
    }
    if (signal.outcome && signal.outcome !== 'success') {
      return {
        ok: true,
        signal: invalidNoChangeSignal(
          signal,
          `outcome ${signal.outcome} is incompatible with ${disposition}`,
        ),
      };
    }
    const evidenceError = validateNoChangeEvidence(signal);
    if (evidenceError) return { ok: true, signal: invalidNoChangeSignal(signal, evidenceError) };
    return { ok: true, signal };
  }

  if (status === 'complete' || status === 'done') {
    if (signal.outcome && signal.outcome !== 'success') {
      return { ok: false, reason: `terminal success status cannot use outcome ${signal.outcome}` };
    }
    if (disposition && disposition !== 'fixed') {
      return { ok: false, reason: `status ${status} cannot use disposition ${disposition}` };
    }
    return { ok: true, signal };
  }

  if (status === 'blocked') {
    if (signal.outcome && signal.outcome !== 'partial')
      return { ok: false, reason: 'blocked status requires partial outcome when outcome is set' };
    if (disposition && disposition !== 'blocked')
      return { ok: false, reason: `blocked status cannot use disposition ${disposition}` };
    return { ok: true, signal };
  }

  if (status === 'failed') {
    if (signal.outcome && signal.outcome !== 'failure')
      return { ok: false, reason: 'failed status requires failure outcome when outcome is set' };
    if (disposition && disposition !== 'failed')
      return { ok: false, reason: `failed status cannot use disposition ${disposition}` };
    return { ok: true, signal };
  }

  if (signal.outcome || signal.disposition)
    return { ok: false, reason: 'running status cannot include outcome or disposition' };
  return { ok: true, signal };
}

export function signalFreshSince(
  signal: WorkerSignal,
  startedAt: string | null | undefined,
): boolean {
  const startedMs = parseFiniteIsoMs(startedAt);
  if (startedMs === null) return true;
  const signalMs = parseFiniteIsoMs(signal.timestamp);
  if (signalMs === null) return true;
  return signalMs >= startedMs;
}

export function signalFreshAfterAll(
  signal: WorkerSignal,
  floors: Array<string | null | undefined>,
): boolean {
  const parsedFloors = floors.map(parseFiniteIsoMs).filter((ms): ms is number => ms !== null);
  if (parsedFloors.length === 0) return true;
  const signalMs = parseFiniteIsoMs(signal.timestamp);
  if (signalMs === null) return true;
  return signalMs >= Math.max(...parsedFloors);
}
