/** Offline protocol for a matched, multi-turn failure investigation. No provider calls. */
import { createHash } from 'node:crypto';
import {
  LABELS,
  type TriageLabel,
} from '../../services/gateway/src/assessment/failure-triage/types.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonicalDigest = (value: unknown) => {
  const canonicalize = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(canonicalize)
      : object(entry)
        ? Object.fromEntries(
            Object.entries(entry)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, child]) => [key, canonicalize(child)]),
          )
        : entry;
  return digest(canonicalize(value));
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export interface NavigationCase {
  id: string;
  failure: string;
  sources: { id: string; title: string; text: string }[];
}
export interface AdviceReceipt {
  /** Advice generation is a real first-use cost, including its native response identity. */
  responseId: string;
  receiptHash: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number;
  providerDurationMs: number;
  elapsedMs: number;
}
export interface NavigationAdvice {
  caseId: string;
  /** Null means the provider abstained; the attempt and its receipt still count. */
  text: string | null;
  receipt: AdviceReceipt;
}
export interface AdviceProvenance {
  advicePlanHash: string;
  configHash: string;
  provider: string;
  model: string;
  journalSha256: string;
  methodologyHash: string;
}
export interface NavigationReference {
  version: 1;
  status: string;
  references: {
    caseId: string;
    label: TriageLabel;
    requiredReadIds: string[];
    nextCheck: string;
    rationale?: string;
    family: string;
  }[];
}
export interface BlindJudgment {
  version: 1;
  packetHash: string;
  methodologyHash: string;
  reviewer: string;
  decisions: {
    blindId: string;
    decision: 'accepted' | 'rejected' | 'unresolved';
    reason: string;
  }[];
}
export interface NavigationPlan {
  version: 1;
  cases: NavigationCase[];
  advice: NavigationAdvice[];
  maxTurns: number;
  maxReads: number;
  referenceHash: string;
  adviceProvenance: AdviceProvenance;
  hash: string;
}
export type Action =
  | { type: 'read_evidence'; id: string }
  | { type: 'answer'; label: TriageLabel; nextCheck: string; evidenceIds: string[] };
export type Arm = 'baseline' | 'assisted';

/** Alternate the first arm by pair index so arm order cannot track case order. */
export function armOrder(pairIndex: number): readonly [Arm, Arm] {
  assert(Number.isSafeInteger(pairIndex) && pairIndex >= 0, 'Invalid pair index');
  return pairIndex % 2 === 0 ? ['baseline', 'assisted'] : ['assisted', 'baseline'];
}
export interface TurnReceipt {
  responseId: string;
  receiptHash: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  providerDurationMs: number;
  elapsedMs: number;
}
export interface Turn {
  number: number;
  promptHash: string;
  action: Action;
  receipt: TurnReceipt;
}
export interface Session {
  planHash: string;
  caseId: string;
  arm: Arm;
  turns: Turn[];
  /** Elapsed time includes evidence reads and the complete worker interaction. */
  elapsedMs: number;
  /** Full local wall time, populated by the live runner after the session ends. */
  wallElapsedMs?: number;
  status: 'active' | 'answered' | 'exhausted' | 'invalid';
}

/** Only these fields enter model-visible case input. Reference answers live elsewhere. */
export function sealCases(cases: NavigationCase[]): { cases: NavigationCase[]; hash: string } {
  assert(cases.length > 0 && cases.length <= 40, 'Invalid case count');
  const caseIds = new Set<string>();
  for (const item of cases) {
    assert(Object.keys(item).sort().join(',') === 'failure,id,sources', 'Unexpected case field');
    assert(/^[\w.-]{2,100}$/.test(item.id) && !caseIds.has(item.id), 'Invalid case ID');
    assert(item.failure.length >= 10 && item.failure.length <= 4000, 'Invalid failure');
    assert(item.sources.length > 0 && item.sources.length <= 12, 'Invalid source count');
    const sourceIds = new Set<string>();
    for (const source of item.sources) {
      assert(Object.keys(source).sort().join(',') === 'id,text,title', 'Unexpected source field');
      assert(/^[\w.-]{2,100}$/.test(source.id) && !sourceIds.has(source.id), 'Invalid source ID');
      assert(
        source.title.length > 0 && source.title.length <= 100 && source.text.length <= 8000,
        'Invalid source',
      );
      sourceIds.add(source.id);
    }
    caseIds.add(item.id);
  }
  const copy = structuredClone(cases);
  return { cases: copy, hash: digest(copy) };
}

/** The sealed worker plan pairs exactly one measured advice response per case. */
export function sealPlan(
  cases: NavigationCase[],
  advice: NavigationAdvice[],
  limits: { maxTurns: number; maxReads: number },
  gates: { referenceHash: string; adviceProvenance: AdviceProvenance },
): NavigationPlan {
  sealCases(cases);
  assert(
    Number.isSafeInteger(limits.maxTurns) && limits.maxTurns >= 2 && limits.maxTurns <= 12,
    'Invalid turn limit',
  );
  assert(
    Number.isSafeInteger(limits.maxReads) &&
      limits.maxReads > 0 &&
      limits.maxReads < limits.maxTurns,
    'Invalid evidence-read limit',
  );
  const caseIds = new Set(cases.map((item) => item.id));
  const adviceIds = new Set<string>();
  const adviceReceipts = new Set<string>();
  for (const entry of advice) {
    assert(
      Object.keys(entry).sort().join(',') === 'caseId,receipt,text',
      'Unexpected advice field',
    );
    assert(caseIds.has(entry.caseId) && !adviceIds.has(entry.caseId), 'Invalid advice case');
    assert(
      entry.text === null ||
        (typeof entry.text === 'string' && entry.text.length > 0 && entry.text.length <= 2000),
      'Invalid advice',
    );
    assert(
      Object.keys(entry.receipt).sort().join(',') ===
        'cacheReadTokens,cacheWriteTokens,costUsd,elapsedMs,inputTokens,outputTokens,providerDurationMs,receiptHash,responseId',
      'Missing advice receipt',
    );
    assert(
      validReceipt(entry.receipt) &&
        !adviceReceipts.has(entry.receipt.responseId) &&
        !adviceReceipts.has(entry.receipt.receiptHash),
      'Invalid or repeated advice receipt',
    );
    adviceReceipts.add(entry.receipt.responseId);
    adviceReceipts.add(entry.receipt.receiptHash);
    adviceIds.add(entry.caseId);
  }
  assert(adviceIds.size === caseIds.size, 'Advice required for every matched pair');
  assert(/^[a-f0-9]{64}$/.test(gates.referenceHash), 'Invalid reference hash');
  assert(
    Object.keys(gates.adviceProvenance).sort().join(',') ===
      'advicePlanHash,configHash,journalSha256,methodologyHash,model,provider' &&
      Object.values(gates.adviceProvenance).every(
        (value) => typeof value === 'string' && value.length > 0 && value.length <= 200,
      ) &&
      [
        gates.adviceProvenance.advicePlanHash,
        gates.adviceProvenance.configHash,
        gates.adviceProvenance.journalSha256,
        gates.adviceProvenance.methodologyHash,
      ].every((value) => /^[a-f0-9]{64}$/.test(value)) &&
      /^[\w.-]{1,100}$/.test(gates.adviceProvenance.provider) &&
      /^[\w.-]{1,100}$/.test(gates.adviceProvenance.model),
    'Invalid advice provenance',
  );
  const body = structuredClone({
    version: 1 as const,
    cases,
    advice,
    maxTurns: limits.maxTurns,
    maxReads: limits.maxReads,
    referenceHash: gates.referenceHash,
    adviceProvenance: gates.adviceProvenance,
  });
  return { ...body, hash: digest(body) };
}

function validReceipt(receipt: AdviceReceipt | TurnReceipt): boolean {
  return (
    Number.isFinite(receipt.providerDurationMs) &&
    receipt.providerDurationMs >= 0 &&
    (receipt.cacheReadTokens === null ||
      (Number.isSafeInteger(receipt.cacheReadTokens) && receipt.cacheReadTokens >= 0)) &&
    (receipt.cacheWriteTokens === null ||
      (Number.isSafeInteger(receipt.cacheWriteTokens) && receipt.cacheWriteTokens >= 0)) &&
    receipt.inputTokens !== null &&
    (receipt.cacheReadTokens ?? 0) + (receipt.cacheWriteTokens ?? 0) <= receipt.inputTokens &&
    /^(?!.*\s)[\w.-]{2,200}$/.test(receipt.responseId) &&
    /^[a-f0-9]{64}$/.test(receipt.receiptHash) &&
    Number.isSafeInteger(receipt.inputTokens) &&
    receipt.inputTokens! >= 0 &&
    Number.isSafeInteger(receipt.outputTokens) &&
    receipt.outputTokens! >= 0 &&
    typeof receipt.costUsd === 'number' &&
    Number.isFinite(receipt.costUsd) &&
    receipt.costUsd >= 0 &&
    typeof receipt.elapsedMs === 'number' &&
    Number.isFinite(receipt.elapsedMs) &&
    receipt.elapsedMs >= 0
  );
}

export function verifyPlan(plan: NavigationPlan): void {
  const expected = sealPlan(plan.cases, plan.advice, plan, plan);
  assert(
    JSON.stringify(expected) === JSON.stringify(plan),
    'Navigation plan changed after sealing',
  );
}

/** Reads a single named source. The worker never receives hidden labels or the full source list. */
export function initialPrompt(plan: NavigationPlan, caseId: string, arm: Arm): string {
  verifyPlan(plan);
  const item = plan.cases.find((entry) => entry.id === caseId);
  assert(item && (arm === 'baseline' || arm === 'assisted'), 'Unknown planned session');
  const advice =
    arm === 'assisted' ? plan.advice.find((entry) => entry.caseId === caseId)!.text : undefined;
  return JSON.stringify({
    failure: item.failure,
    available: item.sources.map(({ id, title }) => ({ id, title })),
    ...(advice ? { advice } : {}),
  });
}

export function nextPrompt(plan: NavigationPlan, session: Session): string {
  verifyPlan(plan);
  const item = plan.cases.find((entry) => entry.id === session.caseId);
  assert(
    item && session.planHash === plan.hash && session.status === 'active',
    'Session cannot continue',
  );
  const reads = session.turns
    .filter((turn) => turn.action.type === 'read_evidence')
    .map(
      (turn) => item.sources.find((source) => source.id === (turn.action as { id: string }).id)!,
    );
  return JSON.stringify({
    start: initialPrompt(plan, item.id, session.arm),
    reads,
    actions: session.turns.map((turn) => turn.action),
    remainingTurns: plan.maxTurns - session.turns.length,
    remainingReads:
      plan.maxReads - session.turns.filter((turn) => turn.action.type === 'read_evidence').length,
  });
}

export function advance(
  plan: NavigationPlan,
  session: Session,
  action: Action,
  receipt: TurnReceipt,
): { session: Session; evidence?: { id: string; title: string; text: string } } {
  verifyPlan(plan);
  const item = plan.cases.find((entry) => entry.id === session.caseId);
  assert(
    item &&
      session.planHash === plan.hash &&
      (session.arm === 'baseline' || session.arm === 'assisted'),
    'Session does not match plan',
  );
  assert(
    session.status === 'active' && session.turns.length < plan.maxTurns,
    'Session already ended',
  );
  assert(
    session.turns.every((turn, index) => turn.number === index + 1),
    'Invalid turn sequence',
  );
  const seen = new Set(session.turns.map((turn) => turn.receipt.responseId));
  const receiptHashes = new Set(session.turns.map((turn) => turn.receipt.receiptHash));
  const expectedHash = digest(nextPrompt(plan, session));
  const valid =
    validReceipt(receipt) &&
    !seen.has(receipt.responseId) &&
    !receiptHashes.has(receipt.receiptHash) &&
    object(action) &&
    ((action.type === 'read_evidence' &&
      Object.keys(action).sort().join(',') === 'id,type' &&
      item.sources.some((source) => source.id === action.id) &&
      !session.turns.some(
        (turn) => turn.action.type === 'read_evidence' && turn.action.id === action.id,
      ) &&
      session.turns.filter((turn) => turn.action.type === 'read_evidence').length <
        plan.maxReads) ||
      (action.type === 'answer' &&
        Object.keys(action).sort().join(',') === 'evidenceIds,label,nextCheck,type' &&
        LABELS.includes(action.label) &&
        typeof action.nextCheck === 'string' &&
        action.nextCheck.trim().length >= 4 &&
        action.nextCheck.length <= 240 &&
        Array.isArray(action.evidenceIds) &&
        action.evidenceIds.length <= 8 &&
        action.evidenceIds.every((id) =>
          session.turns.some(
            (turn) => turn.action.type === 'read_evidence' && turn.action.id === id,
          ),
        )));
  const turns = [
    ...session.turns,
    { number: session.turns.length + 1, promptHash: expectedHash, action, receipt },
  ];
  const updated: Session = {
    ...session,
    turns,
    elapsedMs: session.elapsedMs + receipt.elapsedMs,
    status: !valid
      ? 'invalid'
      : action.type === 'answer'
        ? 'answered'
        : turns.length === plan.maxTurns
          ? 'exhausted'
          : 'active',
  };
  return {
    session: updated,
    ...(valid && action.type === 'read_evidence'
      ? { evidence: item.sources.find((source) => source.id === action.id)! }
      : {}),
  };
}

export function startSession(plan: NavigationPlan, caseId: string, arm: Arm): Session {
  initialPrompt(plan, caseId, arm);
  return { planHash: plan.hash, caseId, arm, turns: [], elapsedMs: 0, status: 'active' };
}

/** Reviewer export omits arms, advice, response cost, and provider identity. */
export function blindReviewRows(plan: NavigationPlan, sessions: Session[]) {
  verifyPlan(plan);
  return sessions
    .map((session) => {
      const item = plan.cases.find((entry) => entry.id === session.caseId);
      assert(item && session.planHash === plan.hash, 'Unknown review session');
      return {
        blindId: digest(`${plan.hash}:${session.caseId}:${session.arm}`),
        failure: item.failure,
        sources: item.sources,
        reads: session.turns
          .filter((turn) => turn.action.type === 'read_evidence')
          .map((turn) => turn.action),
        answer: session.turns.find((turn) => turn.action.type === 'answer')?.action ?? null,
      };
    })
    .sort((a, b) => a.blindId.localeCompare(b.blindId));
}

export function navigationReferenceHash(reference: NavigationReference): string {
  assert(
    Object.keys(reference).sort().join(',') === 'references,status,version' &&
      reference.version === 1 &&
      typeof reference.status === 'string' &&
      reference.status.length > 0,
    'Invalid navigation reference',
  );
  const caseIds = new Set<string>();
  for (const row of reference.references) {
    const keys = Object.keys(row).sort().join(',');
    assert(
      (keys === 'caseId,family,label,nextCheck,requiredReadIds' ||
        keys === 'caseId,family,label,nextCheck,rationale,requiredReadIds') &&
        /^[\w.-]{2,100}$/.test(row.caseId) &&
        !caseIds.has(row.caseId) &&
        LABELS.includes(row.label) &&
        Array.isArray(row.requiredReadIds) &&
        row.requiredReadIds.length > 0 &&
        new Set(row.requiredReadIds).size === row.requiredReadIds.length &&
        row.requiredReadIds.every((id) => /^[\w.-]{2,100}$/.test(id)) &&
        typeof row.nextCheck === 'string' &&
        row.nextCheck.trim().length >= 4 &&
        typeof row.family === 'string' &&
        row.family.length > 0 &&
        (row.rationale === undefined ||
          (typeof row.rationale === 'string' && row.rationale.trim().length > 0)),
      'Invalid navigation reference row',
    );
    caseIds.add(row.caseId);
  }
  return canonicalDigest(reference);
}

export function blindReviewPacketHash(plan: NavigationPlan, sessions: Session[]): string {
  return canonicalDigest(blindReviewRows(plan, sessions));
}

/** Unknown usage, an unbound review, or missing pairs can never be reported as savings. */
export function compareSessions(
  plan: NavigationPlan,
  sessions: Session[],
  reference: NavigationReference,
  judgment: BlindJudgment,
) {
  verifyPlan(plan);
  const referenceHash = navigationReferenceHash(reference);
  assert(
    reference.status === 'frozen' && referenceHash === plan.referenceHash,
    'Reference does not match frozen plan',
  );
  const referenceIds = new Set(reference.references.map((row) => row.caseId));
  assert(
    referenceIds.size === plan.cases.length &&
      plan.cases.every(
        (item) =>
          referenceIds.has(item.id) &&
          reference.references
            .find((row) => row.caseId === item.id)!
            .requiredReadIds.every((id) => item.sources.some((source) => source.id === id)),
      ),
    'Reference does not cover the sealed cases',
  );
  const rows = new Map<string, Session>();
  const identities = new Set<string>();
  for (const entry of plan.advice) {
    assert(
      !identities.has(entry.receipt.responseId) && !identities.has(entry.receipt.receiptHash),
      'Repeated advice receipt',
    );
    identities.add(entry.receipt.responseId);
    identities.add(entry.receipt.receiptHash);
  }
  for (const session of sessions) {
    assert(
      session.planHash === plan.hash &&
        plan.cases.some((entry) => entry.id === session.caseId) &&
        (session.arm === 'baseline' || session.arm === 'assisted'),
      'Unknown session',
    );
    const key = `${session.caseId}/${session.arm}`;
    assert(!rows.has(key), 'Duplicate session');
    let replay = startSession(plan, session.caseId, session.arm);
    for (const turn of session.turns) {
      assert(
        turn.number === replay.turns.length + 1 &&
          turn.promptHash === digest(nextPrompt(plan, replay)),
        'Unverified turn',
      );
      assert(
        !identities.has(turn.receipt.responseId) && !identities.has(turn.receipt.receiptHash),
        'Repeated native receipt across sessions',
      );
      identities.add(turn.receipt.responseId);
      identities.add(turn.receipt.receiptHash);
      replay = advance(plan, replay, turn.action, turn.receipt).session;
    }
    const { wallElapsedMs, ...recorded } = session;
    assert(
      JSON.stringify(replay) === JSON.stringify(recorded) &&
        (wallElapsedMs === undefined ||
          (Number.isFinite(wallElapsedMs) && wallElapsedMs >= session.elapsedMs)),
      'Session does not match journal replay',
    );
    rows.set(key, session);
  }
  const packetHash = blindReviewPacketHash(plan, sessions);
  assert(
    Object.keys(judgment).sort().join(',') ===
      'decisions,methodologyHash,packetHash,reviewer,version' &&
      judgment.version === 1 &&
      judgment.packetHash === packetHash &&
      /^[a-f0-9]{64}$/.test(judgment.methodologyHash) &&
      /^[\w.-]{2,100}$/.test(judgment.reviewer),
    'Blind judgment does not match review packet',
  );
  const blindRows = blindReviewRows(plan, sessions);
  const expectedBlindIds = new Set(blindRows.map((row) => row.blindId));
  const decisions = new Map<string, BlindJudgment['decisions'][number]>();
  for (const row of judgment.decisions) {
    assert(
      Object.keys(row).sort().join(',') === 'blindId,decision,reason' &&
        expectedBlindIds.has(row.blindId) &&
        !decisions.has(row.blindId) &&
        ['accepted', 'rejected', 'unresolved'].includes(row.decision) &&
        typeof row.reason === 'string' &&
        row.reason.trim().length > 0 &&
        row.reason.length <= 2000,
      'Invalid blind judgment row',
    );
    decisions.set(row.blindId, row);
  }
  assert(
    decisions.size === expectedBlindIds.size &&
      [...expectedBlindIds].every((id) => decisions.has(id)),
    'Blind judgment IDs do not exactly match review packet',
  );
  const pairs = plan.cases.map(({ id }) => {
    const baseline = rows.get(`${id}/baseline`);
    const assisted = rows.get(`${id}/assisted`);
    const recommendation = plan.advice.find((entry) => entry.caseId === id)!;
    const advice = recommendation.receipt;
    const expected = reference.references.find((entry) => entry.caseId === id)!;
    const sum = (session: Session, field: 'inputTokens' | 'outputTokens' | 'costUsd') =>
      session.turns.reduce<number | null>(
        (total, turn) =>
          total === null || turn.receipt[field] === null ? null : total + turn.receipt[field]!,
        0,
      );
    const reviews = {
      baseline: decisions.get(digest(`${plan.hash}:${id}:baseline`)),
      assisted: decisions.get(digest(`${plan.hash}:${id}:assisted`)),
    };
    const matchesReference = (session: Session | undefined) => {
      const answer = session?.turns.find((turn) => turn.action.type === 'answer')?.action;
      return (
        answer?.type === 'answer' &&
        answer.label === expected.label &&
        expected.requiredReadIds.every((sourceId) => answer.evidenceIds.includes(sourceId))
      );
    };
    const result = (session: Session | undefined, arm: Arm) => {
      const review = reviews[arm];
      const referenceMatch = matchesReference(session);
      if (
        session?.status === 'invalid' ||
        session?.status === 'exhausted' ||
        review?.decision === 'rejected' ||
        (session?.status === 'answered' && !referenceMatch)
      )
        return 'rejected';
      if (
        session?.status === 'answered' &&
        referenceMatch &&
        review?.decision === 'accepted' &&
        session.turns.every((turn) => validReceipt(turn.receipt))
      )
        return 'accepted';
      return 'unresolved';
    };
    const baseQuality = result(baseline, 'baseline');
    const assistQuality = result(assisted, 'assisted');
    const ready = baseQuality === 'accepted' && assistQuality === 'accepted';
    const pairQuality = ready
      ? 'equal-accepted'
      : baseQuality === 'accepted' && assistQuality === 'rejected'
        ? 'baseline-better'
        : baseQuality === 'rejected' && assistQuality === 'accepted'
          ? 'assisted-better'
          : baseQuality === 'rejected' && assistQuality === 'rejected'
            ? 'both-rejected'
            : 'inconclusive';
    const armReport = (session: Session | undefined, arm: Arm) => {
      const answer = session?.turns.find((turn) => turn.action.type === 'answer')?.action;
      const review = reviews[arm];
      const referenceMatch = matchesReference(session);
      const readIds =
        session?.turns
          .filter((turn) => turn.action.type === 'read_evidence')
          .map((turn) => (turn.action as { type: 'read_evidence'; id: string }).id) ?? [];
      return {
        status: session?.status ?? 'missing',
        quality: result(session, arm),
        referenceMatch,
        readIds,
        firstReadIncludesRequired: readIds.length
          ? expected.requiredReadIds.includes(readIds[0])
          : null,
        readCount: readIds.length,
        turnCount: session?.turns.length ?? 0,
        answer:
          answer?.type === 'answer'
            ? { label: answer.label, nextCheck: answer.nextCheck, evidenceIds: answer.evidenceIds }
            : null,
        judgment: review ? { decision: review.decision, reason: review.reason } : null,
      };
    };
    return {
      caseId: id,
      quality: pairQuality,
      recommendation: recommendation.text,
      reference: { label: expected.label, requiredReadIds: expected.requiredReadIds },
      baseline: armReport(baseline, 'baseline'),
      assisted: armReport(assisted, 'assisted'),
      tokens: ready
        ? {
            baseline: sum(baseline!, 'inputTokens')! + sum(baseline!, 'outputTokens')!,
            assisted:
              sum(assisted!, 'inputTokens')! +
              sum(assisted!, 'outputTokens')! +
              advice.inputTokens +
              advice.outputTokens,
          }
        : null,
      costUsd: ready
        ? {
            baseline: sum(baseline!, 'costUsd')!,
            assisted: sum(assisted!, 'costUsd')! + advice.costUsd,
          }
        : null,
      elapsedMs:
        ready && baseline!.wallElapsedMs !== undefined && assisted!.wallElapsedMs !== undefined
          ? {
              baseline: baseline!.wallElapsedMs,
              assisted: assisted!.wallElapsedMs + advice.elapsedMs,
            }
          : null,
    };
  });
  const navigation = Object.fromEntries(
    (['named', 'abstention'] as const).map((kind) => {
      const group = pairs.filter(
        (pair) => (pair.recommendation === null) === (kind === 'abstention'),
      );
      const matched = group.filter((pair) => pair.quality === 'equal-accepted');
      return [
        kind,
        {
          cases: group.length,
          missing: {
            baseline: group.filter((pair) => pair.baseline.status === 'missing').length,
            assisted: group.filter((pair) => pair.assisted.status === 'missing').length,
          },
          interrupted: {
            baseline: group.filter((pair) => ['active', 'invalid'].includes(pair.baseline.status))
              .length,
            assisted: group.filter((pair) => ['active', 'invalid'].includes(pair.assisted.status))
              .length,
          },
          zeroRead: {
            baseline: group.filter(
              (pair) =>
                ['answered', 'exhausted'].includes(pair.baseline.status) &&
                pair.baseline.readCount === 0,
            ).length,
            assisted: group.filter(
              (pair) =>
                ['answered', 'exhausted'].includes(pair.assisted.status) &&
                pair.assisted.readCount === 0,
            ).length,
          },
          firstReadHits: {
            baseline: group.filter((pair) => pair.baseline.firstReadIncludesRequired).length,
            assisted: group.filter((pair) => pair.assisted.firstReadIncludesRequired).length,
          },
          equalQualityPairs: matched.length,
          matchedReads: {
            baseline: matched.reduce((total, pair) => total + pair.baseline.readCount, 0),
            assisted: matched.reduce((total, pair) => total + pair.assisted.readCount, 0),
          },
          matchedTurns: {
            baseline: matched.reduce((total, pair) => total + pair.baseline.turnCount, 0),
            assisted: matched.reduce((total, pair) => total + pair.assisted.turnCount, 0),
          },
        },
      ];
    }),
  );
  const complete = pairs.filter((pair) => pair.tokens && pair.costUsd && pair.elapsedMs);
  const totals = (field: 'tokens' | 'costUsd' | 'elapsedMs') =>
    complete.reduce(
      (sum, pair) => ({
        baseline: sum.baseline + pair[field]!.baseline,
        assisted: sum.assisted + pair[field]!.assisted,
      }),
      { baseline: 0, assisted: 0 },
    );
  return {
    provenance: {
      referenceHash,
      packetHash,
      judgmentHash: canonicalDigest(judgment),
      methodologyHash: judgment.methodologyHash,
      reviewer: judgment.reviewer,
      advice: plan.adviceProvenance,
    },
    denominator: plan.cases.length,
    equalQualityPairs: pairs.filter((pair) => pair.quality === 'equal-accepted').length,
    completeMetricsPairs: complete.length,
    regressions: pairs.filter((pair) => pair.quality === 'baseline-better').length,
    navigation,
    totals:
      complete.length === plan.cases.length
        ? { tokens: totals('tokens'), costUsd: totals('costUsd'), elapsedMs: totals('elapsedMs') }
        : null,
    pairs,
  };
}
