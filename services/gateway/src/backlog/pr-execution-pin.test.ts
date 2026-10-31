import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { PRSlotExecutionProfile, SlotStatus } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const fleet = await import('../fleet/state.js');
// Admission sees only the phone: the simulator was removed from the project's pool.
const phone = { slot: 'phone', project: 'mobile' } as const satisfies Pick<
  SlotStatus,
  'slot' | 'project'
>;
mock.module('../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadProjectConfig: async () => ({ name: 'mobile', ci: { repo: 'owner/repo' } }),
    loadFleetStatus: async () => ({ slots: [phone] }),
  },
});
const { resolvePRExecution } = await import('./pr-execution.js');

test('admission filtering does not turn a declared [sim, phone] policy into a pin', async () => {
  const profile: PRSlotExecutionProfile = {
    slotPolicy: { kind: 'pool', allowedSlots: ['sim', 'phone'] },
    models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high', mode: 'cold' }],
  };
  const resolved = await resolvePRExecution('mobile', 'owner/repo', [profile]);
  assert.deepEqual(
    resolved.choices.map((choice) => choice.slotId),
    ['phone'],
  );
  assert.equal(resolved.pinnedSlotSelection, false);
  const exact = await resolvePRExecution('mobile', 'owner/repo', [
    { ...profile, slotPolicy: { kind: 'exact', slotId: 'phone' } },
  ]);
  assert.equal(exact.pinnedSlotSelection, true);
});
