import type { ResourceStatus, SlotResource, SlotStatus } from '@farmslot/protocol';

function healthStatus(
  value: string | undefined,
  opts?: { nonEmptyMeansRunning?: boolean },
): ResourceStatus {
  if (!value || value === '-') return 'unknown';
  if (/FAIL/i.test(value)) return 'error';
  if (/OFF/i.test(value)) return 'stopped';
  if (/OK/i.test(value)) return 'running';
  return opts?.nonEmptyMeansRunning ? 'running' : 'unknown';
}

export function isDeviceGridResourceApplicable(slot: SlotStatus, resource: SlotResource): boolean {
  const platform = resource.definition.platform;
  if (!platform) return true;
  if (resource.definition.type !== 'device' && resource.definition.type !== 'browser') return true;
  return platform === slot.platform;
}

export function resolveDeviceGridResourceStatus(
  slot: SlotStatus,
  resource: SlotResource,
): ResourceStatus {
  if (!isDeviceGridResourceApplicable(slot, resource)) return 'stopped';

  if (resource.status === 'running' || resource.status === 'stale') return resource.status;

  const inferred = (() => {
    switch (resource.definition.type) {
      case 'device':
        return healthStatus(slot.health.device);
      case 'browser':
        return resource.status;
      case 'dev-server':
        return healthStatus(slot.health.devserver);
      default:
        return 'unknown' as const;
    }
  })();

  return inferred === 'unknown' ? resource.status : inferred;
}

export function isDeviceGridResourceLive(status: ResourceStatus): boolean {
  return status === 'running' || status === 'stale';
}
