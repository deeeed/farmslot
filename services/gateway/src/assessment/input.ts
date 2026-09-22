import type { AssessmentJsonValue, AssessmentQuestions } from '@farmslot/protocol';

const SECRET_FIELD =
  /password|secret|token|credential|authorization|api.?key|private.?key|mnemonic|seed.?phrase/i;

/** Defense in depth; callers must still supply only approved, focused context. */
export function prepareAssessmentInput(
  state: AssessmentJsonValue,
  questions: AssessmentQuestions,
  maxBytes: number,
  apiKey: string,
) {
  const secrets = Object.entries(process.env)
    .filter(([key, value]) => SECRET_FIELD.test(key) && value && value.length >= 8)
    .map(([, value]) => value!);
  if (apiKey) secrets.push(apiKey);
  const redact = (value: string) =>
    secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
  let remaining = maxBytes;
  function visit(value: unknown, depth: number): AssessmentJsonValue {
    if (depth > 32 || --remaining < 0) throw new Error('Assessment input limit exceeded');
    if (typeof value === 'string') {
      remaining -= Buffer.byteLength(value, 'utf8');
      if (remaining < 0) throw new Error('Assessment input limit exceeded');
      return redact(value);
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map((entry) => visit(entry, depth + 1));
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
          remaining -= Buffer.byteLength(key, 'utf8');
          if (remaining < 0) throw new Error('Assessment input limit exceeded');
          return [redact(key), SECRET_FIELD.test(key) ? '[REDACTED]' : visit(entry, depth + 1)];
        }),
      );
    }
    throw new Error('Assessment input must contain JSON values only');
  }
  validateQuestions(questions);
  const preparedState = visit(state, 0);
  // Question labels are contract identifiers. Reject secrets here rather than changing identity.
  const serializedQuestions = JSON.stringify(questions);
  if (redact(serializedQuestions) !== serializedQuestions)
    throw new Error('Assessment questions contain a credential');
  if (Buffer.byteLength(JSON.stringify({ state: preparedState, questions }), 'utf8') > maxBytes) {
    throw new Error('Assessment input limit exceeded');
  }
  return { state: preparedState, questions };
}

export function validateQuestions(value: unknown): asserts value is AssessmentQuestions {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid assessment questions');
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 50)
    throw new Error('Expected 1 to 50 assessment questions');
  for (const [id, raw] of entries) {
    if (!/^[a-zA-Z][\w-]{0,79}$/.test(id) || ['constructor', 'prototype'].includes(id))
      throw new Error('Invalid question id');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid question');
    const q = raw as Record<string, unknown>;
    if (
      typeof q.instructions !== 'string' ||
      !q.instructions.trim() ||
      q.instructions.length > 4000
    )
      throw new Error('Invalid question instructions');
    if (
      q.type === 'boolean' &&
      Object.keys(q).every((key) => ['type', 'instructions'].includes(key))
    )
      continue;
    if (q.type !== 'choice' && q.type !== 'score') throw new Error('Invalid question type');
    if (Object.keys(q).some((key) => !['type', 'instructions', 'criteria'].includes(key)))
      throw new Error('Unexpected question field');
    if (
      !q.criteria ||
      typeof q.criteria !== 'object' ||
      (q.type === 'score') !== Array.isArray(q.criteria)
    )
      throw new Error('Invalid question criteria');
    const criteria = Object.entries(q.criteria);
    if (
      criteria.length < 2 ||
      criteria.length > 50 ||
      criteria.some(
        ([key, text]) =>
          ['__proto__', 'prototype', 'constructor'].includes(key) ||
          key.length > 80 ||
          typeof text !== 'string' ||
          !text.trim() ||
          text.length > 4000,
      )
    )
      throw new Error('Invalid question criteria');
  }
}
