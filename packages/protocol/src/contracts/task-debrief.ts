/** The portable JSON contract for a task debrief and its worker response. */
type Schema =
  | {
      type: 'string';
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      enum?: readonly string[];
    }
  | { const: 1 }
  | { type: 'integer'; minimum: number }
  | { type: 'array'; items: Schema; maxItems: number; minItems?: number }
  | ObjectSchema;

interface ObjectSchema {
  type: 'object';
  properties: Record<string, Schema>;
  required: readonly string[];
  additionalProperties: false;
}

type SchemaValue<S> = S extends { const: infer V }
  ? V
  : S extends { enum: readonly (infer V)[] }
    ? V
    : S extends { type: 'string' }
      ? string
      : S extends { type: 'integer' }
        ? number
        : S extends { type: 'array'; items: infer I }
          ? SchemaValue<I>[]
          : S extends { properties: infer P; required: readonly (infer K)[] }
            ? { [F in keyof P & K]: SchemaValue<P[F]> } & {
                [F in Exclude<keyof P, K>]?: SchemaValue<P[F]>;
              }
            : never;

const object = <P extends Record<string, Schema>, const K extends readonly (keyof P & string)[]>(
  properties: P,
  required: K,
) => ({ type: 'object' as const, properties, required, additionalProperties: false as const });

const string = (maxLength: number) => ({ type: 'string' as const, minLength: 1, maxLength });
const oneOf = <const T extends readonly string[]>(...values: T) => ({
  type: 'string' as const,
  enum: values,
});
const array = <S extends Schema>(items: S, maxItems: number, minItems = 0) => ({
  type: 'array' as const,
  items,
  maxItems,
  minItems,
});

const sha256 = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const;
const version = { const: 1 } as const;
const step = { type: 'integer', minimum: 1 } as const;
const evidenceSource = oneOf('checklist', 'signal', 'terminalContract', 'completionArtifact');
const taskPath = {
  type: 'string',
  maxLength: 512,
  pattern:
    '^(?![A-Za-z]:)(?!.*(?:^|/)\\.{1,2}(?:/|$))[^/\\\\\\x00-\\x1f]+(?:/[^/\\\\\\x00-\\x1f]+)*$',
} as const;

const reference = object({ source: evidenceSource, path: taskPath, locator: string(128), sha256 }, [
  'source',
  'path',
  'locator',
  'sha256',
]);
const coverage = object(
  { status: oneOf('present', 'unavailable', 'invalid'), sha256, path: taskPath },
  ['status'],
);
const observation = object(
  {
    id: sha256,
    rule: oneOf('proof-remarked', 'historical-mark-out-of-order', 'required-step-skipped'),
    step,
    expected: string(600),
    recorded: string(600),
    evidence: array(reference, 4, 1),
  },
  ['id', 'rule', 'step', 'expected', 'recorded', 'evidence'],
);
const optionalSkip = object(
  { step, condition: string(600), reason: string(600), evidence: reference },
  ['step', 'evidence'],
);
const answer = object(
  {
    observationId: sha256,
    disposition: oneOf('explained', 'disputed', 'unknown'),
    explanation: string(1600),
    counterEvidence: array(reference, 5),
    missingInputs: array(string(300), 5),
  },
  ['observationId', 'disposition', 'explanation'],
);
const candidate = object(
  {
    observationIds: array(sha256, 5, 1),
    lesson: { ...string(240), pattern: '^[^\\r\\n]+$' },
    templateId: string(160),
    step,
    instruction: string(1000),
    measure: string(600),
  },
  ['observationIds', 'lesson', 'instruction', 'measure'],
);
const responseFields = {
  answers: array(answer, 5),
  workflowCandidates: array(candidate, 5),
  friction: string(600),
};
const response = object({ requestId: sha256, ...responseFields }, [
  'requestId',
  'answers',
  'workflowCandidates',
]);

export const taskDebriefResponseSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  ...response,
};

export const taskDebriefSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  ...object(
    {
      schemaVersion: version,
      debriefId: sha256,
      identity: object(
        {
          taskId: sha256,
          acceptedResultFingerprint: sha256,
          binding: oneOf('standalone', 'hosted', 'advisory'),
          runId: string(160),
          attemptId: string(160),
          template: object(
            { id: string(160), sourceId: string(160), sha256, revision: string(160) },
            ['id', 'sourceId', 'sha256'],
          ),
        },
        ['taskId', 'acceptedResultFingerprint', 'binding'],
      ),
      collection: object(
        {
          ruleset: oneOf('checklist-receipts'),
          version,
          observationDigest: sha256,
          signalOutcome: oneOf('success', 'failure', 'partial'),
          coverage: object(
            {
              checklist: coverage,
              signal: coverage,
              terminalContract: coverage,
              completionArtifact: coverage,
              retainedConversation: coverage,
              toolEvents: coverage,
            },
            [
              'checklist',
              'signal',
              'terminalContract',
              'completionArtifact',
              'retainedConversation',
              'toolEvents',
            ],
          ),
        },
        ['ruleset', 'version', 'observationDigest', 'coverage'],
      ),
      prompt: object({ id: oneOf('task-debrief-v1'), sha256 }, ['id', 'sha256']),
      observations: array(observation, 2048),
      optionalSkips: array(optionalSkip, 2048),
      requestedObservationIds: array(sha256, 5),
      ...responseFields,
      outcome: object(
        {
          status: oneOf(
            'answered',
            'partial',
            'no-observations',
            'unsupported',
            'timeout',
            'failed',
            'redacted',
          ),
          reason: string(600),
          unansweredObservationIds: array(sha256, 5),
        },
        ['status', 'unansweredObservationIds'],
      ),
      recordDigest: sha256,
    },
    [
      'schemaVersion',
      'debriefId',
      'identity',
      'collection',
      'prompt',
      'observations',
      'optionalSkips',
      'requestedObservationIds',
      'answers',
      'workflowCandidates',
      'outcome',
      'recordDigest',
    ],
  ),
};

export type TaskDebrief = SchemaValue<typeof taskDebriefSchema>;
export type TaskDebriefResponse = SchemaValue<typeof response>;
export type TaskDebriefEvidenceReference = SchemaValue<typeof reference>;
export type TaskDebriefObservation = SchemaValue<typeof observation>;
export type TaskDebriefCoverage = SchemaValue<typeof coverage>;
export type TaskDebriefWorkflowCandidate = SchemaValue<typeof candidate>;

function matches(schema: Schema, value: unknown): boolean {
  if ('const' in schema) return value === schema.const;
  switch (schema.type) {
    case 'string':
      return (
        typeof value === 'string' &&
        value.length >= (schema.minLength ?? 0) &&
        value.length <= (schema.maxLength ?? Infinity) &&
        (!schema.pattern || new RegExp(schema.pattern, 'u').test(value)) &&
        (!schema.enum || schema.enum.includes(value))
      );
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= schema.minimum;
    case 'array':
      return (
        Array.isArray(value) &&
        value.length <= schema.maxItems &&
        value.length >= (schema.minItems ?? 0) &&
        value.every((item: unknown) => matches(schema.items, item))
      );
    case 'object':
      return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        schema.required.every((key) => Object.hasOwn(value, key)) &&
        Object.entries(value).every(
          ([key, item]) =>
            Object.hasOwn(schema.properties, key) && matches(schema.properties[key]!, item),
        )
      );
  }
}

export function isTaskDebrief(value: unknown): value is TaskDebrief {
  return matches(taskDebriefSchema, value);
}

export function isTaskDebriefResponse(value: unknown): value is TaskDebriefResponse {
  return matches(taskDebriefResponseSchema, value);
}

export function isTaskDebriefRelativePath(value: unknown): value is string {
  return matches(taskPath, value);
}

/** Write-ahead state for the optional continuation of an accepted worker turn. */
export interface ManagedTaskDebrief {
  debriefId: string;
  attemptId: string;
  generation: number;
  contextId: string;
  runner?: string;
  sessionId?: string;
  bundle: import('./run-bundles.js').RunArtifactBundleRef;
  manifestDigest: string;
  reportPath?: string;
  status: 'prepared' | 'submitted' | 'settled' | 'stale';
  outcome?: TaskDebrief['outcome']['status'];
}
