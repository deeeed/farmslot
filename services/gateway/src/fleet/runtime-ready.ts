import timers from 'node:timers/promises';

import { isTerminalRunStatus } from '@farmslot/protocol';

import { loadProjectVars, loadSlotVars } from '../core/config.js';
import { runtimeBootTimeoutMs } from '../core/project-timeouts.js';
import { readSlotRow } from '../core/state.js';
import { getRuntimeCapabilityRegistry } from '../methods/runtime-capabilities.js';
import { getRun, updateRunStep } from '../runs/store.js';
import { withSlotSources } from '../sources/runtime.js';

import {
  executeResourceControl,
  getActiveResource,
  probeResourceStatus,
  resolveSlotResources,
} from './resource-manager.js';
import { probeResourceProcess } from './resource-process.js';

const HEALTH_POLL_MS = 2_000;

/** The fresh-launch boundary, independent of the prepare profile's health phase. */
export async function ensureRunRuntimeReady(
  slotId: string,
  runId: string,
  beforeBoot: () => Promise<void>,
  assertCurrent?: () => void,
  options: { pollMs?: number } = {},
): Promise<void> {
  return withSlotSources(slotId, async () => {
    const initial = await readSlotRow(slotId);
    const assertOwner = async () => {
      assertCurrent?.();
      const run = getRun(runId);
      const row = await readSlotRow(slotId);
      if (
        !run ||
        isTerminalRunStatus(run.status) ||
        run.status === 'blocked' ||
        run.slotId !== slotId ||
        !row ||
        row.current_run_id !== runId ||
        row.slot_epoch !== initial?.slot_epoch ||
        row.cleanup_run_id ||
        (row.handoff_run_id && row.handoff_run_id !== runId) ||
        row.workspace_recovery ||
        row.phase === 'releasing'
      )
        throw new Error(`Runtime readiness refused for ${slotId}: run or slot ownership changed`);
      assertCurrent?.();
    };
    await assertOwner();
    const vars = await loadSlotVars(slotId);
    const project = await loadProjectVars(vars.projectName);
    const bootTimeoutMs = runtimeBootTimeoutMs(project.projectJson);
    const resources = (await resolveSlotResources(slotId))
      .filter(
        ({ definition: def }) =>
          def.controllable &&
          def.hooks?.health &&
          def.hooks.boot &&
          ['dev-server', 'browser', 'device'].includes(def.type),
      )
      .sort(
        (a, b) =>
          Number(b.definition.type === 'dev-server') - Number(a.definition.type === 'dev-server'),
      );
    // A boot can take its whole launch budget, so name it on the run's active
    // step as the launch preflight does, and put the step's detail back after.
    const steps = getRun(runId)?.steps ?? [];
    const step =
      steps.find((entry) => entry.status === 'running') ??
      steps.find((entry) => entry.name === 'dispatch');
    const stepDetail = step?.detail;
    let shownDetail = stepDetail;
    const showDetail = (detail: string | undefined) => {
      if (!step || detail === shownDetail) return;
      shownDetail = detail;
      updateRunStep(runId, step.name, { detail });
    };
    for (const resource of resources) {
      await assertOwner();
      const observed = await probeResourceStatus(slotId, resource.id);
      await assertOwner();
      if (observed.status === 'running') continue;
      if (observed.status !== 'stopped')
        throw new Error(
          `Runtime ${resource.id} on ${slotId} is ${observed.status}: ${observed.detail ?? 'health unavailable'}`,
        );
      let deadline = 0;
      let ready = observed;
      const starting = `Starting ${resource.id} on ${slotId} (up to ${Math.ceil(bootTimeoutMs / 1000)} s)`;
      showDetail(starting);
      // Reuse the slot/device ownership fence of the capability registry. A pack's
      // server hook may also launch its device, so inspect device claims for both.
      const controlled = await getRuntimeCapabilityRegistry().withSlotResourceShutdown(
        slotId,
        runId,
        resource.id,
        true,
        async () => {
          showDetail(starting);
          await beforeBoot();
          await assertOwner();
          const active = getActiveResource(slotId, resource.id);
          if (active && active.runId !== runId && (await probeResourceProcess(vars, active.pid)))
            throw new Error(
              `Runtime ${resource.id} on ${slotId} has a foreign live process; boot refused`,
            );
          deadline = Date.now() + bootTimeoutMs;
          const result = await executeResourceControl(
            slotId,
            resource.id,
            'boot',
            undefined,
            runId,
            { bootTimeoutMs },
          );
          await assertOwner();
          if (!result.ok)
            throw new Error(
              `Runtime ${resource.id} on ${slotId} failed to boot: ${result.detail ?? 'unknown failure'}`,
            );
          ready = await probeResourceStatus(slotId, resource.id);
          await assertOwner();
        },
        () => showDetail(`Waiting for an earlier runtime action on ${slotId}`),
      );
      if (!controlled.ok)
        throw new Error(`Runtime ${resource.id} on ${slotId}: ${controlled.reason}`);
      // A host still busy from the boot (CoreSimulator right after `simctl boot`) can
      // time out one health probe, so keep probing within the launch budget, outside
      // the slot's runtime control queue.
      while (ready.status === 'stopped' && Date.now() < deadline) {
        await timers.setTimeout(Math.min(options.pollMs ?? HEALTH_POLL_MS, deadline - Date.now()));
        if (Date.now() >= deadline) break;
        ready = await probeResourceStatus(slotId, resource.id);
        await assertOwner();
      }
      if (ready.status !== 'running')
        throw new Error(
          `Runtime ${resource.id} on ${slotId} is ${ready.status} after boot: ${ready.detail ?? 'not healthy'}`,
        );
    }
    showDetail(stepDetail);
    await assertOwner();
  });
}
