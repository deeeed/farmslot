import {
  recordingTargetClaimKey,
  type RuntimeCapabilityAcquireParams,
  type RuntimeCapabilityAcquireResult,
  type RuntimeCapabilityReleaseParams,
  type RuntimeCapabilityReleaseResult,
} from '@farmslot/protocol';
import type { RecordingAdmission } from '@farmslot/recipe-runner';

/** The existing lease authority; this bridge creates no resource store or lock. */
export interface RecordingAdmissionAuthority {
  acquire(params: RuntimeCapabilityAcquireParams): Promise<RuntimeCapabilityAcquireResult>;
  release(params: RuntimeCapabilityReleaseParams): Promise<RuntimeCapabilityReleaseResult>;
}

export { recordingTargetClaimKey } from '@farmslot/protocol';

/** Hosted and direct SDK hosts bind the same authority once, outside author recipes. */
export function createRuntimeCapabilityRecordingAdmission(
  authority: RecordingAdmissionAuthority,
  owner: RuntimeCapabilityAcquireParams,
): RecordingAdmission {
  return {
    async acquire(context) {
      const key = recordingTargetClaimKey(context);
      const result = await authority.acquire({
        ...owner,
        parameters: {
          ...owner.parameters,
          recording: { backend: context.backend, target: context.target },
        },
      });
      if (!result.ok) throw new Error(`Recording admission refused: ${result.conflict.reason}`);
      return {
        key,
        async release() {
          if (result.idempotent) return;
          const released = await authority.release({
            slotId: owner.slotId,
            ownerRunId: owner.ownerRunId,
            leaseId: result.lease.id,
            keepWarm: false,
          });
          if (!released.ok || released.failures.length)
            throw new Error(
              `Recording lease release failed: ${released.failures.map((failure) => failure.reason).join('; ')}`,
            );
        },
      };
    },
  };
}
