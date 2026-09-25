import {
  ASSESSMENT_CONSUMERS,
  type AssessmentAnswer,
  type AssessmentRecord,
  type AssessmentResult,
  type AssessmentSubject,
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
const admittedText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b-\x1f]/.test(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const probability = (value: unknown): value is number => count(value) && value <= 1;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function assertAssessmentSubject(value: unknown): asserts value is AssessmentSubject {
  if (!record(value) || Object.keys(value).some((k) => !['pr', 'run', 'suggestion'].includes(k)))
    throw new Error('Invalid assessment subject');
  if (value.suggestion !== undefined) {
    const suggestion = value.suggestion;
    if (
      !record(suggestion) ||
      Object.keys(suggestion).some(
        (k) => !['kind', 'source', 'context', 'items', 'candidates'].includes(k),
      ) ||
      !['static-review-checklist', 'copilot-context', 'review-routing'].includes(
        String(suggestion.kind),
      ) ||
      !record(suggestion.source) ||
      Object.keys(suggestion.source).some((k) => !['classification', 'ref'].includes(k)) ||
      !['public', 'synthetic'].includes(String(suggestion.source.classification)) ||
      !admittedText(suggestion.context, 4000) ||
      (suggestion.source.classification === 'public'
        ? !/^https:\/\/[^\s]+$/.test(String(suggestion.source.ref)) ||
          String(suggestion.source.ref).length > 300
        : !/^synthetic:[\w./-]{1,200}$/.test(String(suggestion.source.ref))) ||
      (suggestion.items !== undefined &&
        (!Array.isArray(suggestion.items) ||
          suggestion.items.length < 1 ||
          suggestion.items.length > 12 ||
          !suggestion.items.every(
            (item) =>
              record(item) &&
              Object.keys(item).every((k) => ['id', 'text', 'evidence'].includes(k)) &&
              /^[a-z][a-z0-9_-]{0,39}$/.test(String(item.id)) &&
              admittedText(item.text, 600) &&
              admittedText(item.evidence, 1800),
          ))) ||
      (suggestion.candidates !== undefined &&
        (!Array.isArray(suggestion.candidates) ||
          suggestion.candidates.length < 2 ||
          suggestion.candidates.length > 8 ||
          !suggestion.candidates.every(
            (item) =>
              record(item) &&
              Object.keys(item).every((k) => ['id', 'description'].includes(k)) &&
              /^[a-z][a-z0-9_-]{0,39}$/.test(String(item.id)) &&
              admittedText(item.description, 500),
          )))
    )
      throw new Error('Invalid assessment suggestion context');
  }
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
  if (value.run !== undefined) {
    const r = value.run;
    if (
      !record(r) ||
      Object.keys(r).some(
        (k) =>
          ![
            'id',
            'project',
            'step',
            'snapshotHash',
            'decision',
            'criterion',
            'admission',
            'sources',
          ].includes(k),
      ) ||
      !bounded(r.id) ||
      !bounded(r.project) ||
      !bounded(r.step) ||
      typeof r.snapshotHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(r.snapshotHash)
    )
      throw new Error('Invalid assessment run identity');
    if (r.admission !== undefined) {
      if (
        !record(r.admission) ||
        Object.keys(r.admission).some((key) => !['classification', 'sourceRef'].includes(key)) ||
        (r.admission.classification !== 'synthetic' && r.admission.classification !== 'public') ||
        typeof r.admission.sourceRef !== 'string' ||
        r.admission.sourceRef.length > 300 ||
        !(r.admission.classification === 'public'
          ? /^https:\/\/[^\s]+$/.test(r.admission.sourceRef)
          : /^synthetic:[\w./-]+$/.test(r.admission.sourceRef))
      )
        throw new Error('Invalid assessment admission');
    }
    if (r.criterion !== undefined) {
      const criterion = r.criterion;
      if (
        !record(criterion) ||
        Object.keys(criterion).some((k) => !['id', 'text', 'evidence'].includes(k)) ||
        !/^AC-[1-9][0-9]*$/.test(String(criterion.id)) ||
        !admittedText(criterion.text, 1200) ||
        !Array.isArray(criterion.evidence) ||
        criterion.evidence.length < 1 ||
        criterion.evidence.length > 4 ||
        !criterion.evidence.every(
          (item) =>
            record(item) &&
            Object.keys(item).every((k) => ['id', 'text'].includes(k)) &&
            bounded(item.id, 200) &&
            admittedText(item.text, 4096),
        )
      )
        throw new Error('Invalid assessment criterion context');
    }
    if (r.decision !== undefined) {
      const decision = r.decision;
      if (
        !record(decision) ||
        Object.keys(decision).some((k) => !['id', 'type', 'description', 'actions'].includes(k)) ||
        !bounded(decision.id) ||
        !bounded(decision.type, 100) ||
        !admittedText(decision.description, 4096) ||
        !Array.isArray(decision.actions) ||
        decision.actions.length < 3 ||
        decision.actions.length > 20 ||
        !decision.actions.every(
          (action) =>
            record(action) &&
            Object.keys(action).every((k) => ['id', 'label', 'description'].includes(k)) &&
            bounded(action.id, 80) &&
            admittedText(action.label, 4096) &&
            admittedText(action.description, 4096),
        )
      )
        throw new Error('Invalid assessment decision context');
    }
    if (
      r.sources !== undefined &&
      (!Array.isArray(r.sources) ||
        r.sources.length > 4 ||
        !r.sources.every(
          (s) =>
            record(s) &&
            Object.keys(s).every((k) => ['id', 'sourceId', 'digest'].includes(k)) &&
            bounded(s.id) &&
            bounded(s.sourceId) &&
            typeof s.digest === 'string' &&
            /^[a-f0-9]{64}$/.test(s.digest),
        ))
    )
      throw new Error('Invalid assessment source identities');
  }
}
function answer(value: unknown): value is AssessmentAnswer {
  if (!record(value)) return false;
  if (value.type === 'boolean')
    return (
      (typeof value.value === 'boolean' || probability(value.probability)) &&
      (value.value === undefined || typeof value.value === 'boolean') &&
      (value.probability === undefined || probability(value.probability)) &&
      Object.keys(value).every((k) => ['type', 'value', 'probability'].includes(k))
    );
  if (value.type !== 'choice' && value.type !== 'score') return false;
  if (value.confidence !== undefined && !probability(value.confidence)) return false;
  if (
    value.probabilities !== undefined &&
    (!record(value.probabilities) ||
      Object.keys(value.probabilities).length > 50 ||
      !Object.values(value.probabilities).every(probability))
  )
    return false;
  if (
    Object.keys(value).some(
      (k) =>
        !['type', 'choice', 'choices', 'score', 'confidence', 'probabilities', 'legend'].includes(
          k,
        ),
    )
  )
    return false;
  if (value.type === 'choice') {
    if (
      value.choices !== undefined &&
      (!Array.isArray(value.choices) ||
        value.choices.length < 1 ||
        value.choices.length > 50 ||
        !value.choices.every((c) => bounded(c, 80)) ||
        new Set(value.choices).size !== value.choices.length)
    )
      return false;
    const options = Array.isArray(value.choices)
      ? value.choices
      : record(value.probabilities)
        ? Object.keys(value.probabilities)
        : [];
    return (
      bounded(value.choice, 80) &&
      options.includes(value.choice) &&
      (value.probabilities === undefined ||
        (record(value.probabilities) &&
          Object.keys(value.probabilities).every((c) => options.includes(c)) &&
          Object.hasOwn(value.probabilities, value.choice)))
    );
  }
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
          'attempted',
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
  if (value.attempted !== undefined && typeof value.attempted !== 'boolean') return false;
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
            'cacheReadTokens',
            'cacheWriteTokens',
            'outputTokens',
            'costUsd',
            'costKind',
          ].includes(k),
      )
    )
      return false;
    for (const k of [
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'costUsd',
    ])
      if (u[k] !== undefined && !count(u[k])) return false;
    if (u.costKind !== undefined && !['estimated', 'reported'].includes(String(u.costKind)))
      return false;
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
          'reservation',
          'requestedIdentity',
          'feedback',
        ].includes(k),
    ) ||
    value.version !== 1 ||
    !bounded(value.id) ||
    !bounded(value.ownerId) ||
    !bounded(value.policyVersion) ||
    !ASSESSMENT_CONSUMERS.some((consumer) => consumer === value.consumer) ||
    !statuses.has(String(value.status)) ||
    typeof value.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.startedAt))
  )
    throw new Error('Invalid assessment record');
  if (value.reservation !== undefined) {
    const r = value.reservation;
    if (
      !record(r) ||
      Object.keys(r).some((k) => !['key', 'maxUsd', 'priceHash', 'price'].includes(k)) ||
      typeof r.key !== 'string' ||
      !/^[a-f0-9]{64}$/.test(r.key) ||
      typeof r.priceHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(r.priceHash) ||
      !count(r.maxUsd) ||
      r.maxUsd <= 0 ||
      r.maxUsd > 0.1
    )
      throw new Error('Invalid assessment reservation');
    if (r.price !== undefined) {
      const p = r.price;
      if (
        !record(p) ||
        Object.keys(p).some(
          (k) =>
            ![
              'version',
              'provider',
              'model',
              'verifiedAt',
              'source',
              'inputUsdPerMillion',
              'outputUsdPerMillion',
              'maxRequestTokens',
              'maxInputTokens',
              'maxOutputTokens',
            ].includes(k),
        ) ||
        p.version !== 1 ||
        !bounded(p.provider) ||
        !bounded(p.model) ||
        !bounded(p.source, 1000) ||
        typeof p.verifiedAt !== 'string' ||
        !Number.isFinite(Date.parse(p.verifiedAt)) ||
        !count(p.inputUsdPerMillion) ||
        !count(p.outputUsdPerMillion) ||
        !count(p.maxRequestTokens) ||
        (p.maxInputTokens !== undefined && !count(p.maxInputTokens)) ||
        (p.maxOutputTokens !== undefined && !count(p.maxOutputTokens))
      )
        throw new Error('Invalid assessment price snapshot');
    }
  }
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
