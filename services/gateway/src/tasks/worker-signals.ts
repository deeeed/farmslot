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

// Anchored ISO-8601 shape. Date.parse alone is too permissive for unattended
// decisions: it tolerates trailing junk (e.g. "2026-04-25junk" parses), which
// would let a mangled SIGNAL.json timestamp pass an ordering check.
const STRICT_ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

export function parseStrictIsoMs(value: string | null | undefined): number | null {
  if (!value || !STRICT_ISO_RE.test(value)) return null;
  return parseFiniteIsoMs(value);
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
  const reportPath = signal.evidence?.reportPath?.trim();
  if (!reportPath) {
    return 'evidence.reportPath is required (use ./mark no-change after writing artifacts/no-change-report.md)';
  }
  const normalized = reportPath.replace(/^\.\//, '').replace(/\\/g, '/');
  const reviewerReport = /^artifacts\/review-feedback(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)?\.md$/;
  if (normalized !== 'artifacts/no-change-report.md' && !reviewerReport.test(normalized)) {
    return 'evidence.reportPath must be artifacts/no-change-report.md or a scoped artifacts/review-feedback.<context>.md';
  }
  return null;
}

export type WorkerSignalNormalizationResult =
  | { ok: true; signal: WorkerSignal; warning?: string }
  | { ok: false; reason: string };

export function normalizeWorkerSignal(signal: WorkerSignal): WorkerSignalNormalizationResult {
  const rawStatus = String((signal as { status?: unknown }).status ?? '');
  if (!rawStatus) return { ok: false, reason: 'missing status' };

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
