import {
  type ResourcePressureSnapshotResult,
  selectResourcePressureGroups,
} from '@farmslot/protocol';

type PressureGroup =
  ResourcePressureSnapshotResult['machines'][number]['processAttribution']['groups'][number];

export function pressureOwnershipLabel(classification: PressureGroup['classification']): string {
  return classification === 'unknown' ? 'system / unmapped' : classification;
}

const PRESSURE_CHART_SAMPLES = 30;

type CleanupTarget = { machine: string; resourceId: string; slotId: string };

export function cleanupTargetsRemainEligible(
  selected: CleanupTarget[],
  fresh: CleanupTarget[],
): boolean {
  const freshKeys = new Set(
    fresh.map((target) => `${target.machine}:${target.slotId}:${target.resourceId}`),
  );
  return selected.every((target) =>
    freshKeys.has(`${target.machine}:${target.slotId}:${target.resourceId}`),
  );
}

export function cleanupExecutionTargets(targets: CleanupTarget[]): CleanupTarget[] {
  return targets.map(({ machine, resourceId, slotId }) => ({ machine, resourceId, slotId }));
}

export function pressureSparklinePoints(values: number[], maxValue: number): string {
  const samples = values.slice(-PRESSURE_CHART_SAMPLES);
  if (samples.length === 0 || maxValue <= 0) return '';
  const points = samples.map((value, index) => {
    const x = samples.length === 1 ? 100 : (index / (samples.length - 1)) * 100;
    const y = 23 - Math.min(1, Math.max(0, value / maxValue)) * 21;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  if (points.length === 1) points.unshift(`0,${points[0].split(',')[1]}`);
  return points.join(' ');
}

export function pressureProcessName(executable: string): string {
  const app = executable.match(/\/([^/]+)\.app(?:\/|$)/)?.[1];
  if (app) return app;
  const name = executable.split('/').at(-1) || executable;
  return name.replace(/^\((.+)\)$/u, '$1');
}

export function pressureProcessCpu(cpuPercent: number): string {
  return cpuPercent >= 100 ? `${(cpuPercent / 100).toFixed(1)} cores` : `${cpuPercent.toFixed(1)}%`;
}

export function pressureLoadRatio(ratio: number | undefined): string {
  return ratio == null ? '–' : `${ratio.toFixed(2)}×`;
}

export function pressureBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_048_576)} MB`;
}

export function pressureSampleAge(sampledAt: string | undefined, now = Date.now()): string {
  if (!sampledAt) return 'awaiting process sample';
  const sampledAtMs = Date.parse(sampledAt);
  if (!Number.isFinite(sampledAtMs)) return 'unknown sample age';
  const seconds = Math.max(0, Math.round((now - sampledAtMs) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

export function visiblePressureGroups(groups: PressureGroup[], limit: number): PressureGroup[] {
  return selectResourcePressureGroups(groups, limit);
}
