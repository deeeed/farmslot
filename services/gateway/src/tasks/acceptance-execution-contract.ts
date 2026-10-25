import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  ACCEPTANCE_CONTRACT_INPUT,
  type AcceptanceExecutionContract,
  isRecord,
  registeredAcceptanceCriteria,
  type Run,
  WORKER_TERMINAL_CONTRACT_INPUT,
} from '@farmslot/protocol';

import {
  slotFileExists,
  type SlotLocality,
  slotReadFile,
  slotWriteFiles,
} from '../core/slot-io.js';
import { readInheritedAcceptanceSource } from '../run-completion/inherited-acceptance.js';
import { persistRunNow, updateRun } from '../runs/store.js';

import { acceptanceProofDestinations } from './acceptance-registration.js';
import { readAcceptanceStatusLedger } from './acceptance-status.js';

/** The caller holds this run's transition, or owns its pre-dispatch task write. */
export async function syncAcceptanceExecutionContract(
  run: Run,
  io: SlotLocality,
  taskDir: string,
  mirrorDir: string,
  owns: () => Promise<boolean>,
): Promise<void> {
  if (run.acceptanceContractVersion !== 1) return;
  if (!(await owns())) throw new Error('Acceptance execution contract lost its task owner');
  const baseBytes = await slotReadFile(io, path.join(taskDir, WORKER_TERMINAL_CONTRACT_INPUT));
  const base: unknown = JSON.parse(baseBytes);
  if (!isRecord(base) || base.acceptanceContractVersion !== 1)
    throw new Error('Frozen worker contract does not support acceptance revisions');
  const criteria = registeredAcceptanceCriteria(
    run.ticketData?.acceptanceCriteria ?? [],
    run.acceptanceRegistration,
  );
  const ledger = await readAcceptanceStatusLedger(io, taskDir);
  const proofModes: AcceptanceExecutionContract['proofModes'] = [];
  for (const criterion of criteria) {
    const row = ledger?.criteria.find(({ id }) => id === criterion.id);
    if (
      row &&
      (row.text !== criterion.text ||
        (criterion.proofMode && row.proofMode !== criterion.proofMode))
    )
      throw new Error(`${criterion.id}: proof differs from its registered definition or mode`);
    const proofMode = criterion.proofMode ?? row?.proofMode;
    if (proofMode) proofModes.push({ id: criterion.id, text: criterion.text, proofMode });
  }
  const content = {
    schemaVersion: 1 as const,
    runId: run.id,
    registrationRevision: run.acceptanceRegistration?.revision ?? 0,
    baseContractHash: createHash('sha256').update(baseBytes).digest('hex'),
    proofModes,
    inheritedCriterionIds:
      (await readInheritedAcceptanceSource(run))?.acceptance.criteria.map(({ id }) => id) ?? [],
  };
  const destinations = acceptanceProofDestinations(
    proofModes
      .filter(({ id }) => !content.inheritedCriterionIds.includes(id))
      .map(({ proofMode }) => proofMode),
    run,
  );
  const nextContent = { ...content, ...destinations };
  const previous = run.acceptanceExecutionContract;
  const { revision: _revision, ...priorContent } = previous ?? { revision: 0 };
  const revision =
    previous && isDeepStrictEqual(nextContent, priorContent)
      ? previous
      : { ...nextContent, revision: (previous?.revision ?? 0) + 1 };
  const bytes = `${JSON.stringify(revision, null, 2)}\n`;
  const frozenPath = `inputs/acceptance-contracts/${revision.revision}.json`;
  if (
    (await slotFileExists(io, path.join(taskDir, frozenPath))) &&
    (await slotReadFile(io, path.join(taskDir, frozenPath))) !== bytes
  )
    throw new Error('Acceptance execution contract immutable revision differs');
  if (!(await owns())) throw new Error('Acceptance execution contract lost its task owner');
  if (revision !== previous)
    await persistRunNow(
      updateRun(run.id, { acceptanceExecutionContract: revision, acceptanceProofHold: undefined }),
      'acceptance execution contract selected',
    );
  const frozenExists = await slotFileExists(io, path.join(taskDir, frozenPath));
  const currentMatches =
    (await slotFileExists(io, path.join(taskDir, ACCEPTANCE_CONTRACT_INPUT))) &&
    (await slotReadFile(io, path.join(taskDir, ACCEPTANCE_CONTRACT_INPUT))) === bytes;
  if (!frozenExists || !currentMatches)
    await slotWriteFiles(io, taskDir, [
      ...(frozenExists
        ? []
        : [{ path: frozenPath, content: Buffer.from(bytes).toString('base64'), mode: 0o444 }]),
      { path: ACCEPTANCE_CONTRACT_INPUT, content: Buffer.from(bytes).toString('base64') },
    ]);
  if (
    !(await owns()) ||
    (await slotReadFile(io, path.join(taskDir, ACCEPTANCE_CONTRACT_INPUT))) !== bytes
  )
    throw new Error('Acceptance execution contract delivery was not confirmed');
  if (path.resolve(mirrorDir) !== path.resolve(taskDir)) {
    await mkdir(path.join(mirrorDir, 'inputs/acceptance-contracts'), { recursive: true });
    const localFrozen = path.join(mirrorDir, frozenPath);
    try {
      if ((await readFile(localFrozen, 'utf8')) !== bytes)
        throw new Error('Mirrored acceptance execution contract revision differs');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFile(localFrozen, bytes, { mode: 0o444, flag: 'wx' });
    }
    await writeFile(path.join(mirrorDir, ACCEPTANCE_CONTRACT_INPUT), bytes);
  }
}
