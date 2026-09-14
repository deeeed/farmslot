// Delay one real retiring engine's cleanup until after its successor records a release.
import fs from 'node:fs';

import 'tsx';

const config = process.env.FARMSLOT_DEFERRED_RELEASE_FAULT;
if (config && Number(process.env.FARMSLOT_DEFERRED_RELEASE_PID) === process.pid) {
  const { DeferredSlotReleases } =
    await import('../../../services/gateway/src/run-engine/deferred-slot-release.ts');
  const take = DeferredSlotReleases.prototype.take;
  const defer = DeferredSlotReleases.prototype.defer;
  let held;
  DeferredSlotReleases.prototype.take = function (runId, generation) {
    if (fs.existsSync(config) && !fs.existsSync(`${config}.held`)) {
      const target = JSON.parse(fs.readFileSync(config, 'utf8'));
      if (
        target.gatewayPid === process.pid &&
        target.runId === runId &&
        target.generation === generation
      ) {
        held = { receiver: this, runId, generation };
        fs.writeFileSync(`${config}.held`, JSON.stringify({ runId, generation }), { mode: 0o600 });
        return undefined;
      }
    }
    return take.call(this, runId, generation);
  };
  DeferredSlotReleases.prototype.defer = function (runId, generation, params) {
    defer.call(this, runId, generation, params);
    if (held && held.runId === runId && generation > held.generation) {
      const old = held;
      held = undefined;
      const consumed = take.call(old.receiver, old.runId, old.generation);
      fs.writeFileSync(
        `${config}.resumed`,
        JSON.stringify({
          runId,
          oldGeneration: old.generation,
          successorGeneration: generation,
          slotId: params.slotId,
          consumedSuccessorRelease: Boolean(consumed),
        }),
        { mode: 0o600 },
      );
    }
  };
  fs.writeFileSync(`${config}.${process.pid}.loaded`, '', { mode: 0o600 });
}
