import { isDeepStrictEqual } from 'node:util';

import {
  ACCEPTANCE_DERIVATION_VERSION,
  ACCEPTANCE_PROOF_MODES,
  type AcceptanceCriterionRef,
  type AcceptanceDerivationResult,
  type AcceptanceDerivationSource,
  type AcceptanceDerivationUnit,
  type AcceptanceObligation,
  type AcceptanceProofMode,
  type AcceptanceRegistration,
  type AcceptanceSourceClassification,
  isRecord,
  prCompletionClaimReviewSupported,
  type PRCompletionIntakeIdentity,
  type Run,
} from '@farmslot/protocol';

export class AcceptanceDerivationRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcceptanceDerivationRefusal';
  }
}

function nonempty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new AcceptanceDerivationRefusal(`${field}: required string`);
  return value;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new AcceptanceDerivationRefusal(`${field}: required non-negative integer`);
  return value;
}

function parseObligation(value: unknown): AcceptanceObligation {
  if (!isRecord(value))
    throw new AcceptanceDerivationRefusal('acceptance obligation: expected object');
  const proofMode = ACCEPTANCE_PROOF_MODES.find((mode) => mode === value.proofMode);
  if (!proofMode)
    throw new AcceptanceDerivationRefusal(
      'acceptance obligation.proofMode: unsupported proof destination',
    );
  return { text: nonempty(value.text, 'acceptance obligation.text'), proofMode };
}

function parseClassification(value: unknown): AcceptanceSourceClassification {
  if (!isRecord(value) || !Array.isArray(value.obligations))
    throw new AcceptanceDerivationRefusal(
      'acceptance classification: expected source and obligations array',
    );
  const obligations = value.obligations.map(parseObligation);
  const exclusion =
    value.exclusion === undefined
      ? undefined
      : nonempty(value.exclusion, 'acceptance classification.exclusion');
  if ((!obligations.length && !exclusion) || (obligations.length && exclusion))
    throw new AcceptanceDerivationRefusal(
      'acceptance classification: provide obligations or an exclusion reason',
    );
  return {
    sourceId: nonempty(value.sourceId, 'acceptance classification.sourceId'),
    sourceVersion: nonempty(value.sourceVersion, 'acceptance classification.sourceVersion'),
    obligations,
    ...(exclusion === undefined ? {} : { exclusion }),
  };
}

/** Worker input is untrusted; construct the typed result rather than assert it. */
export function parseAcceptanceDerivationResult(value: unknown): AcceptanceDerivationResult {
  if (
    !isRecord(value) ||
    value.schemaVersion !== ACCEPTANCE_DERIVATION_VERSION ||
    !Array.isArray(value.classifications)
  )
    throw new AcceptanceDerivationRefusal(
      'acceptance derivation: expected schemaVersion 1 and classifications array',
    );
  return {
    schemaVersion: 1,
    runId: nonempty(value.runId, 'acceptance derivation.runId'),
    generation: integer(value.generation, 'acceptance derivation.generation'),
    registrationRevision: integer(
      value.registrationRevision,
      'acceptance derivation.registrationRevision',
    ),
    unitId: nonempty(value.unitId, 'acceptance derivation.unitId'),
    classifications: value.classifications.map(parseClassification),
  };
}

export function initializeAcceptanceRegistration(
  runId: string,
  original: AcceptanceCriterionRef[],
  sources: AcceptanceDerivationSource[],
  intake: PRCompletionIntakeIdentity,
): AcceptanceRegistration {
  if (new Set(sources.map(({ id }) => id)).size !== sources.length)
    throw new AcceptanceDerivationRefusal('acceptance intake: duplicate source identity');
  return {
    schemaVersion: 1,
    runId,
    revision: 1,
    intake,
    original: original.map((row) => ({ ...row })),
    derived: [],
    units: [{ id: 'derive-acceptance', sources }],
  };
}

/** Retry the same message identity; never reopen the settled initial unit. */
export function admitAcceptanceInstruction(
  registration: AcceptanceRegistration,
  unit: AcceptanceDerivationUnit,
): AcceptanceRegistration {
  const previous = registration.units.find(({ id }) => id === unit.id);
  if (previous) {
    if (!isDeepStrictEqual(previous.sources, unit.sources))
      throw new AcceptanceDerivationRefusal(
        'acceptance instruction identity was reused with changed contents',
      );
    return registration;
  }
  if (unit.result || unit.sources.some(({ kind }) => kind !== 'instruction'))
    throw new AcceptanceDerivationRefusal(
      'acceptance steer must contain unclassified instruction sources',
    );
  const ids = new Set(registration.units.flatMap(({ sources }) => sources.map(({ id }) => id)));
  if (unit.sources.some(({ id }) => ids.has(id)))
    throw new AcceptanceDerivationRefusal(
      'acceptance steer source already belongs to another unit',
    );
  return {
    ...registration,
    revision: registration.revision + 1,
    units: [...registration.units, unit],
  };
}

/** Single append rule. It records obligations, never engine proof verdicts. */
export function acceptAcceptanceDerivation(
  registration: AcceptanceRegistration,
  result: AcceptanceDerivationResult,
  generation: number,
): AcceptanceRegistration {
  if (result.runId !== registration.runId || result.generation !== generation)
    throw new AcceptanceDerivationRefusal(
      'acceptance derivation: wrong run or stale worker generation',
    );
  const unit = registration.units.find(({ id }) => id === result.unitId);
  if (!unit)
    throw new AcceptanceDerivationRefusal(
      'acceptance derivation: unit is not admitted by this run',
    );
  if (unit.delivery?.status === 'pending')
    throw new AcceptanceDerivationRefusal(
      'acceptance derivation: operator instruction delivery is not confirmed',
    );
  if (unit.result) {
    if (!isDeepStrictEqual(unit.result, result))
      throw new AcceptanceDerivationRefusal(
        'acceptance derivation: settled obligations cannot be rewritten',
      );
    return registration;
  }
  if (result.registrationRevision !== registration.revision)
    throw new AcceptanceDerivationRefusal(
      'acceptance derivation: registration changed; refresh before classifying',
    );
  const classifications = new Map(result.classifications.map((row) => [row.sourceId, row]));
  if (
    classifications.size !== result.classifications.length ||
    classifications.size !== unit.sources.length
  )
    throw new AcceptanceDerivationRefusal(
      'acceptance derivation: missing or duplicate source coverage',
    );
  const derived = [...registration.derived];
  let next = Math.max(
    0,
    ...[...registration.original, ...derived].map(({ id }) => Number(id.slice(3))),
  );
  for (const source of unit.sources) {
    const classification = classifications.get(source.id);
    if (!classification || classification.sourceVersion !== source.version)
      throw new AcceptanceDerivationRefusal(
        `acceptance derivation: missing or changed source ${source.id}`,
      );
    if (source.kind === 'review-comment' && classification.obligations.length > 1)
      throw new AcceptanceDerivationRefusal(
        `acceptance derivation: one criterion per actionable comment ${source.id}`,
      );
    if (source.resolved && classification.obligations.length)
      throw new AcceptanceDerivationRefusal(
        `acceptance derivation: resolved comment ${source.id} requires an exclusion`,
      );
    classification.obligations.forEach((obligation, obligationIndex) => {
      derived.push({
        id: `AC-${++next}`,
        ...obligation,
        source: {
          kind: source.kind,
          sourceId: source.id,
          sourceVersion: source.version,
          obligationIndex,
          ...(source.url ? { url: source.url } : {}),
        },
      });
    });
  }
  return {
    ...registration,
    revision: registration.revision + 1,
    derived,
    units: registration.units.map((row) => {
      if (row.id !== unit.id) return row;
      const accepted = { ...row, result };
      delete accepted.error;
      return accepted;
    }),
  };
}

export function acceptanceDerivationPending(registration: AcceptanceRegistration): boolean {
  return registration.units.some(({ result }) => !result);
}

export function acceptanceInstructionPrompt(unit: AcceptanceDerivationUnit): string {
  return `${unit.sources.map(({ body }) => body).join('\n\n')}\n\nRead inputs/acceptance-registration.json in your current task. Append a new checklist step and start its child ${unit.id} with ./mark sub start. Classify every source admitted to that unit, then submit its typed result with ./mark sub ${unit.id} complete --acceptance-result <task-relative-result.json>. Keep the settled initial derivation and original criteria intact. Run ./mark start before continuing a completed worker attempt.`;
}

export function acceptanceDerivationInstructions(): string {
  return `## PR-completion acceptance registration

Keep every original criterion. Before fixes or proof planning, start the first child:
\`\`\`sh
./mark sub start derive-acceptance --step 1 --from 'inline:# Derive acceptance\n- [ ] Classify every frozen source\n- [ ] Submit the typed result'
\`\`\`

Read \`inputs/acceptance-registration.json\`. Its \`registration.units\` contain the authoritative frozen comments and dispatch instructions. Classify every source once. One actionable unresolved comment adds one AC; each extra instruction obligation adds one AC. For a resolved or non-actionable source, record an exclusion reason instead. Do not edit the registry or engine verdicts.

Write a JSON result inside this task with \`schemaVersion: 1\`, \`runId\`, current \`generation\`, \`registrationRevision\`, \`unitId\`, and \`classifications\`. Each classification contains \`sourceId\`, \`sourceVersion\`, and \`obligations: [{text, proofMode}]\`; an empty obligation list requires \`exclusion\`. Copy identities from the current transport. Use \`state\`, \`visual\`, \`mixed\`, or \`review\` deliberately, and keep later proof declarations consistent.

Submit with \`./mark sub derive-acceptance complete --mark-last --acceptance-result <task-relative-result.json>\`. The child stays running until the gateway validates coverage and returns its registration acknowledgement; retry the same result after acknowledgement. \`farmslot-agent ac\` stays read-only. A later operator instruction gets its own child unit; never reopen the settled initial unit.
`;
}

/** Review destinations come from declarations; state-only appends request no review. */
export function acceptanceProofDestinations(
  modes: readonly AcceptanceProofMode[],
  run?: Run,
): {
  claimReviewGate: boolean;
  publicationReview: boolean;
} {
  if (
    run &&
    modes.some((mode) => mode === 'visual' || mode === 'mixed') &&
    !prCompletionClaimReviewSupported(run)
  )
    throw new AcceptanceDerivationRefusal(
      'Captured visual completion review is unsupported for this run policy; no criterion was downgraded',
    );
  return {
    claimReviewGate: modes.some((mode) => mode === 'visual' || mode === 'mixed'),
    publicationReview: modes.includes('review'),
  };
}
