import type {
  AssessmentAnswer,
  AssessmentRecord,
  AssessmentResult,
  AssessmentSubject,
} from '@farmslot/protocol';

const statuses = new Set([
  'started',
  'interrupted',
  'completed',
  'disabled',
  'skipped',
  'unavailable',
]);
const bounded = (value: unknown, max = 200): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\x00-\x1f]/.test(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const probability = (value: unknown): value is number => count(value) && value <= 1;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function assertAssessmentSubject(value: unknown): asserts value is AssessmentSubject {
  if (!record(value) || Object.keys(value).some((k) => !['pr', 'runId'].includes(k)))
    throw new Error('Invalid assessment subject');
  if (value.runId !== undefined && !bounded(value.runId)) throw new Error('Invalid assessment run');
  if (value.pr !== undefined) {
    if (
      !record(value.pr) ||
      Object.keys(value.pr).some((k) => !['host', 'repo', 'number', 'headSha'].includes(k)) ||
      !bounded(value.pr.host) ||
      !bounded(value.pr.repo) ||
      !Number.isSafeInteger(value.pr.number) ||
      Number(value.pr.number) < 1 ||
      typeof value.pr.headSha !== 'string' ||
      !/^[a-f0-9]{40,64}$/i.test(value.pr.headSha)
    )
      throw new Error('Invalid assessment PR identity');
  }
}
function answer(value: unknown): value is AssessmentAnswer {
  if (!record(value)) return false;
  if (value.type === 'boolean')
    return (
      probability(value.probability) &&
      Object.keys(value).every((k) => ['type', 'probability'].includes(k))
    );
  if (value.type !== 'choice' && value.type !== 'score') return false;
  if (value.confidence !== undefined && !probability(value.confidence)) return false;
  if (
    !record(value.probabilities) ||
    Object.keys(value.probabilities).length > 50 ||
    !Object.values(value.probabilities).every(probability)
  )
    return false;
  if (
    Object.keys(value).some(
      (k) => !['type', 'choice', 'score', 'confidence', 'probabilities', 'legend'].includes(k),
    )
  )
    return false;
  if (value.type === 'choice')
    return bounded(value.choice, 80) && Object.hasOwn(value.probabilities, value.choice);
  return (
    count(value.score) &&
    (!value.legend ||
      (record(value.legend) && Object.values(value.legend).every((x) => bounded(x, 4000))))
  );
}
function result(value: unknown): value is AssessmentResult {
  if (
    !record(value) ||
    !['completed', 'disabled', 'skipped', 'unavailable'].includes(String(value.status))
  )
    return false;
  if (
    Object.keys(value).some(
      (k) =>
        ![
          'status',
          'assessmentId',
          'monitoringError',
          'provider',
          'requestedModel',
          'returnedModel',
          'answers',
          'usage',
          'questionSchemaHash',
          'stateHash',
          'error',
        ].includes(k),
    )
  )
    return false;
  for (const key of [
    'provider',
    'requestedModel',
    'returnedModel',
    'assessmentId',
    'error',
    'monitoringError',
  ])
    if (value[key] !== undefined && !bounded(value[key], 300)) return false;
  for (const key of ['stateHash', 'questionSchemaHash'])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/.test(value[key]))
    )
      return false;
  if (
    value.answers !== undefined &&
    (!record(value.answers) ||
      Object.keys(value.answers).length > 50 ||
      !Object.values(value.answers).every(answer))
  )
    return false;
  if (value.usage !== undefined) {
    const u = value.usage;
    if (!record(u) || !bounded(u.provider) || !bounded(u.requestedModel) || !count(u.durationMs))
      return false;
    if (
      Object.keys(u).some(
        (k) =>
          ![
            'provider',
            'requestedModel',
            'returnedModel',
            'requestId',
            'durationMs',
            'inputTokens',
            'outputTokens',
            'costUsd',
          ].includes(k),
      )
    )
      return false;
    for (const k of ['inputTokens', 'outputTokens', 'costUsd'])
      if (u[k] !== undefined && !count(u[k])) return false;
    for (const k of ['requestId', 'returnedModel'])
      if (u[k] !== undefined && !bounded(u[k])) return false;
  }
  return true;
}
export function assertAssessmentRecord(value: unknown): asserts value is AssessmentRecord {
  if (
    !record(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          'version',
          'id',
          'ownerId',
          'consumer',
          'subject',
          'startedAt',
          'completedAt',
          'status',
          'result',
          'recommendation',
          'policyVersion',
          'requestedIdentity',
          'feedback',
        ].includes(k),
    ) ||
    value.version !== 1 ||
    !bounded(value.id) ||
    !bounded(value.ownerId) ||
    !bounded(value.policyVersion) ||
    !['review-intake', 'smoke-test'].includes(String(value.consumer)) ||
    !statuses.has(String(value.status)) ||
    typeof value.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.startedAt))
  )
    throw new Error('Invalid assessment record');
  if (
    value.completedAt !== undefined &&
    (typeof value.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.completedAt)) ||
      Date.parse(value.completedAt) < Date.parse(value.startedAt))
  )
    throw new Error('Invalid assessment completion time');
  if (value.requestedIdentity !== undefined) {
    const identity = value.requestedIdentity;
    if (
      !record(identity) ||
      Object.keys(identity).some(
        (k) => !['provider', 'model', 'inputDigest', 'questionSchemaHash'].includes(k),
      ) ||
      Object.entries(identity).some(
        ([k, v]) =>
          v !== undefined &&
          (['inputDigest', 'questionSchemaHash'].includes(k)
            ? typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)
            : !bounded(v, 100)),
      )
    )
      throw new Error('Invalid assessment request identity');
  }
  assertAssessmentSubject(value.subject);
  if (value.result !== undefined && !result(value.result))
    throw new Error('Invalid assessment result');
  if (value.recommendation !== undefined) {
    const r = value.recommendation;
    if (
      !record(r) ||
      Object.keys(r).some(
        (k) => !['assessment', 'route', 'visualReviewRequired', 'reasons'].includes(k),
      ) ||
      !result(r.assessment) ||
      !['standard-review', 'strong-reviewer', 'multimodal-review', 'needs-review'].includes(
        String(r.route),
      ) ||
      typeof r.visualReviewRequired !== 'boolean' ||
      !Array.isArray(r.reasons) ||
      r.reasons.length > 20 ||
      !r.reasons.every((x) => bounded(x, 200))
    )
      throw new Error('Invalid assessment recommendation');
  }
  if (
    !Array.isArray(value.feedback) ||
    value.feedback.length > 1000 ||
    !value.feedback.every(
      (f, i) =>
        record(f) &&
        Object.keys(f).every((k) =>
          [
            'revision',
            'recordedAt',
            'questionId',
            'verdict',
            'adviceUsed',
            'adviceShown',
            'evidenceRef',
            'correctedAnswer',
          ].includes(k),
        ) &&
        f.revision === i + 1 &&
        bounded(f.questionId, 80) &&
        ['correct', 'incorrect', 'insufficient-context'].includes(String(f.verdict)) &&
        typeof f.adviceUsed === 'boolean' &&
        typeof f.adviceShown === 'boolean' &&
        (!f.adviceUsed || f.adviceShown) &&
        bounded(f.evidenceRef, 500) &&
        (f.correctedAnswer === undefined
          ? f.verdict !== 'incorrect'
          : typeof f.correctedAnswer === 'boolean' || bounded(f.correctedAnswer, 80)) &&
        typeof f.recordedAt === 'string' &&
        Number.isFinite(Date.parse(f.recordedAt)),
    )
  )
    throw new Error('Invalid assessment feedback');
}

export function serializeAssessment(record: AssessmentRecord): string {
  assertAssessmentRecord(record);
  const bytes = JSON.stringify(record);
  if (Buffer.byteLength(bytes) > 256 * 1024) throw new Error('Assessment record exceeds limit');
  assertNoCredentials(bytes);
  return bytes;
}

export function assertNoCredentials(bytes: string): void {
  // Provider errors or metadata must not echo the gateway's credentials into history.
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /password|secret|token|credential|authorization|api.?key|private.?key/i.test(key) &&
      value &&
      value.length >= 8 &&
      (bytes.includes(value) || bytes.includes(JSON.stringify(value).slice(1, -1)))
    )
      throw new Error('Assessment record contains a credential');
  }
}
