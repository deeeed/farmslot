import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ACCEPTANCE_REGISTRATION_INPUT, isRecord, isTerminalRunStatus } from '@farmslot/protocol';

import {
  slotFileExists,
  type SlotLocality,
  slotReadFile,
  slotWriteFiles,
} from '../core/slot-io.js';
import { readSlotField } from '../core/state.js';
import { withRunTransition } from '../run-lifecycle/transition-coordinator.js';
import { deliverOperatorInstruction } from '../runners/operator-instruction.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';

import { syncAcceptanceExecutionContract } from './acceptance-execution-contract.js';
import {
  acceptAcceptanceDerivation,
  AcceptanceDerivationRefusal,
  acceptanceInstructionPrompt,
  acceptanceProofDestinations,
  parseAcceptanceDerivationResult,
} from './acceptance-registration.js';
import { readSubtaskIndex } from './subtasks.js';

/** Admit typed child results through the existing task watch, not a second worker service. */
export async function syncAcceptanceRegistration(
  runId: string,
  slotId: string,
  io: SlotLocality,
  taskDir: string,
): Promise<void> {
  // Existing pinned runs and opted-out templates never acquire this capability.
  if (!getRun(runId)?.acceptanceRegistration && getRun(runId)?.acceptanceContractVersion !== 1)
    return;
  await withRunTransition(runId, async () => {
    const run = getRun(runId);
    if (!run || isTerminalRunStatus(run.status) || run.slotId !== slotId || !run.taskFile) return;
    const generation = run.engineState?.generation ?? 0;
    const owns = async () =>
      !isTerminalRunStatus(getRun(runId)?.status ?? 'cancelled') &&
      getRun(runId)?.slotId === slotId &&
      (getRun(runId)?.engineState?.generation ?? 0) === generation &&
      (await readSlotField(slotId, 'current_run_id')) === runId;
    if (!(await owns())) return;
    const handoff: unknown = JSON.parse(
      await slotReadFile(io, path.join(taskDir, 'inputs/handoff.json')),
    );
    if (!isRecord(handoff) || handoff.attemptId !== runId || handoff.project !== run.project)
      throw new Error('Acceptance registration: worker task identity changed');
    if (!run.acceptanceRegistration) {
      await syncAcceptanceExecutionContract(run, io, taskDir, path.dirname(run.taskFile), owns);
      return;
    }
    const index = await readSubtaskIndex(io, taskDir);
    let registration = run.acceptanceRegistration;
    for (const unit of registration.units) {
      if (unit.delivery?.status !== 'pending' || unit.delivery.startedAt === undefined) continue;
      const result = await deliverOperatorInstruction(
        run,
        unit.id,
        acceptanceInstructionPrompt(unit),
        unit.delivery.startedAt,
        unit.delivery.contextId,
        unit.delivery.commandId,
      );
      if (result === 'confirmed')
        registration = {
          ...registration,
          units: registration.units.map((row) =>
            row.id === unit.id
              ? {
                  ...row,
                  delivery: {
                    ...unit.delivery!,
                    status: 'confirmed',
                    acceptedAt: new Date().toISOString(),
                  },
                }
              : row,
          ),
        };
    }
    for (const unit of index?.units ?? []) {
      if (!(await slotFileExists(io, path.join(taskDir, unit.signal)))) continue;
      const signal: unknown = JSON.parse(await slotReadFile(io, path.join(taskDir, unit.signal)));
      if (!isRecord(signal) || signal.acceptanceDerivation === undefined) continue;
      const admitted = registration.units.find(({ id }) => id === unit.id);
      if (!admitted) throw new Error(`Acceptance derivation is not enabled for child ${unit.id}`);
      try {
        if (
          signal.contextId !== unit.id ||
          !isRecord(signal.parent) ||
          signal.parent.checklist !== unit.parent.checklist ||
          signal.parent.stepNumber !== unit.parent.stepNumber ||
          (unit.id === 'derive-acceptance' &&
            (unit.parent.stepNumber !== 1 || unit.parent.checklist !== 'CHECKLIST.md'))
        )
          throw new AcceptanceDerivationRefusal(
            'Acceptance derivation child identity or first step differs',
          );
        const result = parseAcceptanceDerivationResult(signal.acceptanceDerivation);
        acceptanceProofDestinations(
          result.classifications.flatMap(({ obligations }) =>
            obligations.map(({ proofMode }) => proofMode),
          ),
          run,
        );
        if (result.unitId !== unit.id)
          throw new AcceptanceDerivationRefusal(
            'Acceptance derivation result names a different child',
          );
        registration = acceptAcceptanceDerivation(registration, result, generation);
      } catch (error) {
        if (!(error instanceof AcceptanceDerivationRefusal)) throw error;
        registration = {
          ...registration,
          units: registration.units.map((row) =>
            row.id === unit.id ? { ...row, error: error.message } : row,
          ),
        };
      }
    }
    if (!(await owns())) return;
    if (registration !== run.acceptanceRegistration)
      await persistRunNow(
        updateRun(runId, { acceptanceRegistration: registration }),
        'acceptance source classification registered',
      );
    const text = `${JSON.stringify({ schemaVersion: 1, generation, registration }, null, 2)}\n`;
    const projection = path.join(taskDir, ACCEPTANCE_REGISTRATION_INPUT);
    if (!(await slotFileExists(io, projection)) || (await slotReadFile(io, projection)) !== text)
      await slotWriteFiles(io, taskDir, [
        { path: ACCEPTANCE_REGISTRATION_INPUT, content: Buffer.from(text).toString('base64') },
      ]);
    if (!(await owns())) throw new Error('Acceptance registration delivery lost its slot owner');
    if ((await slotReadFile(io, projection)) !== text)
      throw new Error('Acceptance registration delivery was not confirmed');
    // Mirror transport after confirmation; the immutable handoff stays untouched.
    await writeFile(path.join(path.dirname(run.taskFile), ACCEPTANCE_REGISTRATION_INPUT), text);
    await syncAcceptanceExecutionContract(run, io, taskDir, path.dirname(run.taskFile), owns);
  });
}
