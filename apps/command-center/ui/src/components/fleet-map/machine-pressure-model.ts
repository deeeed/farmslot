import type { ResourcePressureSnapshotResult } from '@farmslot/protocol';

type PressureGroup =
  ResourcePressureSnapshotResult['machines'][number]['processAttribution']['groups'][number];

const PRESSURE_CHART_SAMPLES = 30;

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

export function pressureBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_048_576)} MB`;
}

export function pressureSampleAge(sampledAt: string | undefined, now = Date.now()): string {
  if (!sampledAt) return 'awaiting process sample';
  const seconds = Math.max(0, Math.round((now - Date.parse(sampledAt)) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

export function visiblePressureGroups(groups: PressureGroup[], limit: number): PressureGroup[] {
  const required = (['stale', 'active'] as const)
    .map((classification) => groups.find((group) => group.classification === classification))
    .filter((group): group is PressureGroup => group != null);
  const visible = [
    ...groups
      .filter((group) => !required.includes(group))
      .slice(0, Math.max(0, limit - required.length)),
    ...required,
  ];
  return visible.sort((a, b) => groups.indexOf(a) - groups.indexOf(b));
}
