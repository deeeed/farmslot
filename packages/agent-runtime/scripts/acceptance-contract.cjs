const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const {
  ACCEPTANCE_CONTRACT_INPUT,
  ACCEPTANCE_PROOF_MODES,
  ACCEPTANCE_REGISTRATION_INPUT,
} = require('@farmslot/protocol/scripts/acceptance.mjs');

const ACCEPTANCE_CONTRACT_VERSION = 1;

/** New runs select gateway-confirmed revisions without changing the frozen base. */
function effectiveAcceptanceContract(taskDir, base, baseBytes) {
  if (base.acceptanceContractVersion === undefined) return base;
  if (base.acceptanceContractVersion !== ACCEPTANCE_CONTRACT_VERSION)
    throw new Error('Unsupported acceptance execution contract; update the worker runtime.');
  const revisionBytes = readFileSync(path.join(taskDir, ACCEPTANCE_CONTRACT_INPUT));
  const revision = JSON.parse(revisionBytes);
  const handoff = JSON.parse(readFileSync(path.join(taskDir, 'inputs/handoff.json'), 'utf8'));
  const frozenBase =
    base.acceptanceParentContract === 'inputs/worker-terminal-contract.json'
      ? readFileSync(path.join(taskDir, base.acceptanceParentContract))
      : baseBytes;
  if (
    revision.schemaVersion !== 1 ||
    revision.runId !== handoff.attemptId ||
    !Number.isSafeInteger(revision.revision) ||
    revision.revision < 1 ||
    !Array.isArray(revision.proofModes) ||
    revision.baseContractHash !== createHash('sha256').update(frozenBase).digest('hex')
  )
    throw new Error(
      'Acceptance execution contract identity or frozen base differs; await gateway delivery.',
    );
  const frozen = readFileSync(
    path.join(taskDir, `inputs/acceptance-contracts/${revision.revision}.json`),
  );
  if (!frozen.equals(revisionBytes))
    throw new Error('Acceptance execution contract revision was changed.');
  const registrationPath = path.join(taskDir, ACCEPTANCE_REGISTRATION_INPUT);
  if (
    existsSync(registrationPath) &&
    JSON.parse(readFileSync(registrationPath, 'utf8')).registration?.revision !==
      revision.registrationRevision
  )
    throw new Error(
      'Acceptance registration changed; await the gateway execution-contract revision.',
    );
  const proofModes = new Map();
  for (const row of revision.proofModes) {
    if (
      typeof row?.id !== 'string' ||
      typeof row.text !== 'string' ||
      !ACCEPTANCE_PROOF_MODES.includes(row.proofMode) ||
      proofModes.has(row.id)
    )
      throw new Error('Acceptance execution contract has invalid proof declarations.');
    proofModes.set(row.id, row);
  }
  const {
    workerAcceptanceCriteria,
    readAcceptanceLedger,
    inheritedCriterionIdsForTask,
  } = require('./acceptance-ledger.cjs');
  const criteria = workerAcceptanceCriteria(taskDir);
  const inherited = inheritedCriterionIdsForTask(taskDir, criteria);
  const recordedInherited = revision.inheritedCriterionIds ?? [];
  if (
    recordedInherited.some((id) => !inherited.has(id)) ||
    recordedInherited.length !== inherited.size
  )
    throw new Error('Inherited acceptance qualification differs; await gateway contract delivery.');
  const ledger = readAcceptanceLedger(taskDir);
  for (const criterion of criteria) {
    if (inherited.has(criterion.id)) continue;
    const row = ledger?.criteria?.find((candidate) => candidate.id === criterion.id);
    const mode = criterion.proofMode ?? row?.proofMode;
    if (
      mode &&
      (proofModes.get(criterion.id)?.proofMode !== mode ||
        proofModes.get(criterion.id)?.text !== criterion.text)
    )
      throw new Error(
        `${criterion.id}: proof mode changed; await the gateway execution-contract revision.`,
      );
  }
  return {
    ...base,
    inheritedAcceptanceCriteria: [...inherited],
  };
}

module.exports = {
  ACCEPTANCE_CONTRACT_INPUT,
  ACCEPTANCE_CONTRACT_VERSION,
  effectiveAcceptanceContract,
};
