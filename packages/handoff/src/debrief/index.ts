import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  isTaskDebrief,
  isTaskDebriefResponse,
  type TaskDebrief,
  type TaskDebriefEvidenceReference,
  type TaskDebriefResponse,
} from '@farmslot/protocol';

import {
  collectTaskDebrief,
  scrubDebriefText,
  TASK_DEBRIEF_PROMPT,
  type TaskDebriefOptions,
  type TaskDebriefRequest,
} from './collect.js';
import {
  asRecord,
  debriefPath,
  digestDebriefValue,
  evidencePath,
  type Input,
  MAX_DEBRIEF_BYTES,
  readBoundedFile,
} from './evidence.js';

export {
  collectTaskDebrief,
  scrubDebriefText,
  TASK_DEBRIEF_PROMPT,
  type TaskDebriefOptions,
  type TaskDebriefRequest,
} from './collect.js';
export { debriefPath, type RetainedDebriefEvidence } from './evidence.js';

type TerminalOutcome = Exclude<TaskDebrief['outcome']['status'], 'answered' | 'partial'>;

function validLocator(input: Input, locator: string): boolean {
  const line = /^line:([1-9]\d*)$/u.exec(locator);
  if (line) return Number(line[1]) <= (input.text?.split('\n').length ?? 0);
  if (input.json === undefined || !locator.startsWith('/')) return false;
  if (locator === '/') return true;
  let value: unknown = input.json;
  for (const segment of locator.slice(1).split('/')) {
    if (/~(?![01])/u.test(segment)) return false;
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/u.test(key) || !Object.hasOwn(value, key)) return false;
      value = value[Number(key)] as unknown;
    } else {
      const object = asRecord(value);
      if (!object || !Object.hasOwn(object, key)) return false;
      value = object[key];
    }
  }
  return true;
}

function assertReference(request: TaskDebriefRequest, ref: TaskDebriefEvidenceReference): void {
  const input = request.inputs[ref.source];
  if (
    input.coverage.path !== ref.path ||
    input.coverage.sha256 !== ref.sha256 ||
    !validLocator(input, ref.locator)
  )
    throw new Error('Debrief references evidence outside the captured inputs.');
}

function unanswered(
  observationIds: readonly string[],
  response: Pick<TaskDebriefResponse, 'answers' | 'workflowCandidates'>,
): string[] {
  const remaining = new Set(observationIds);
  const informative = new Set<string>();
  for (const answer of response.answers) {
    if (!remaining.delete(answer.observationId))
      throw new Error('Debrief answer has an unknown or duplicate observation ID.');
    if (answer.disposition !== 'unknown') informative.add(answer.observationId);
  }
  for (const candidate of response.workflowCandidates) {
    if (
      new Set(candidate.observationIds).size !== candidate.observationIds.length ||
      candidate.observationIds.some((id) => !informative.has(id))
    )
      throw new Error('Debrief candidate must cite distinct answered observations.');
  }
  return [...remaining];
}

function seal(
  request: TaskDebriefRequest,
  response: Omit<TaskDebriefResponse, 'requestId'>,
  status: TaskDebrief['outcome']['status'],
  reason?: string,
): TaskDebrief {
  const record = {
    ...request.record,
    ...response,
    outcome: {
      status,
      ...(reason ? { reason } : {}),
      unansweredObservationIds: unanswered(request.record.requestedObservationIds, response),
    },
  };
  return validateTaskDebrief({ ...record, recordDigest: digestDebriefValue(record) });
}

export function settleTaskDebrief(
  request: TaskDebriefRequest,
  status: TerminalOutcome,
  reason?: string,
): TaskDebrief {
  return seal(request, { answers: [], workflowCandidates: [] }, status, reason);
}

export function completeTaskDebrief(
  request: TaskDebriefRequest,
  value: unknown,
  options: TaskDebriefOptions = {},
): TaskDebrief {
  if (!isTaskDebriefResponse(value)) throw new Error('Invalid debrief response schema.');
  if (value.requestId !== request.requestId)
    throw new Error('Debrief response is stale or belongs to a different accepted result.');
  const missing = unanswered(request.record.requestedObservationIds, value);
  for (const answer of value.answers) {
    for (const ref of answer.counterEvidence ?? []) assertReference(request, ref);
  }
  const { requestId: _requestId, ...body } = value;
  const clean = scrubDebriefText(JSON.stringify(body), options);
  if (clean === undefined)
    return settleTaskDebrief(request, 'redacted', 'The worker response did not clear redaction.');
  const sanitized: unknown = JSON.parse(clean);
  const response = { ...(asRecord(sanitized) ?? {}), requestId: request.requestId };
  if (!isTaskDebriefResponse(response))
    return settleTaskDebrief(request, 'redacted', 'Redaction exceeded the worker response limits.');
  // A redaction may touch a path or locator. Losing its identity invalidates the response.
  for (const answer of response.answers) {
    for (const ref of answer.counterEvidence ?? []) {
      const original = value.answers.find(
        ({ observationId }) => observationId === answer.observationId,
      );
      if (
        !original?.counterEvidence?.some(
          (before) => digestDebriefValue(before) === digestDebriefValue(ref),
        )
      )
        return settleTaskDebrief(
          request,
          'redacted',
          'Redaction removed a counter-evidence identity.',
        );
    }
  }
  const { requestId: _sanitizedId, ...scrubbed } = response;
  return seal(request, scrubbed, missing.length ? 'partial' : 'answered');
}

export function validateTaskDebrief(value: unknown, request?: TaskDebriefRequest): TaskDebrief {
  if (!isTaskDebrief(value)) throw new Error('Invalid debrief record schema.');
  const {
    recordDigest,
    observations,
    optionalSkips,
    collection,
    debriefId,
    prompt,
    identity,
    requestedObservationIds,
    answers,
    workflowCandidates,
    friction,
    outcome,
  } = value;
  const { recordDigest: _digest, ...record } = value;
  if (recordDigest !== digestDebriefValue(record))
    throw new Error('Invalid debrief record digest.');
  if (
    collection.observationDigest !== digestDebriefValue({ observations, optionalSkips }) ||
    prompt.sha256 !== TASK_DEBRIEF_PROMPT.sha256 ||
    debriefId !==
      digestDebriefValue([
        identity.acceptedResultFingerprint,
        collection.observationDigest,
        prompt.sha256,
      ]) ||
    digestDebriefValue(requestedObservationIds) !==
      digestDebriefValue(observations.slice(0, 5).map(({ id }) => id)) ||
    new Set(observations.map(({ id }) => id)).size !== observations.length
  )
    throw new Error('Invalid debrief observation or request identity.');
  const missing = unanswered(requestedObservationIds, value);
  if (
    digestDebriefValue(missing) !== digestDebriefValue(outcome.unansweredObservationIds) ||
    (outcome.status === 'answered' && missing.length > 0) ||
    (outcome.status === 'partial' && missing.length === 0) ||
    (!['answered', 'partial'].includes(outcome.status) &&
      (answers.length || workflowCandidates.length || friction))
  )
    throw new Error('Debrief outcome disagrees with the retained response.');

  if (request) {
    if (
      debriefId !== request.requestId ||
      digestDebriefValue(identity) !== digestDebriefValue(request.record.identity) ||
      digestDebriefValue({
        ...collection,
        coverage: {
          ...collection.coverage,
          retainedConversation: request.record.collection.coverage.retainedConversation,
        },
      }) !== digestDebriefValue(request.record.collection)
    )
      throw new Error('Debrief no longer matches the captured evidence or accepted result.');
    for (const answer of answers)
      for (const ref of answer.counterEvidence ?? []) assertReference(request, ref);
  }
  return value;
}

export function readTaskDebrief(
  root: string,
  options?: TaskDebriefOptions,
  relative: string = debriefPath,
): TaskDebrief {
  const value: unknown = JSON.parse(
    readBoundedFile(realpathSync(root), relative, MAX_DEBRIEF_BYTES).toString('utf8'),
  );
  return validateTaskDebrief(value, options && collectTaskDebrief(root, options));
}

export function writeTaskDebrief(
  directory: string,
  value: TaskDebrief,
  relative: string = debriefPath,
): void {
  const record = validateTaskDebrief(value);
  const root = realpathSync(directory);
  const target = evidencePath(root, relative);
  const parent = path.dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (realpathSync(parent) !== parent) throw new Error('Debrief destination escaped its root.');
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const file = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    try {
      // A hard link exposes complete bytes without replacing a concurrent first writer.
      linkSync(temporary, target);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const existing = readTaskDebrief(root, undefined, relative);
      if (existing.recordDigest !== record.recordDigest)
        throw new Error('The debrief destination already contains a different record.');
    }
  } finally {
    unlinkSync(temporary);
  }
}

export function renderTaskDebrief(value: TaskDebrief): string {
  const record = validateTaskDebrief(value);
  const lines = [
    '# Task debrief',
    '',
    `Outcome: ${record.outcome.status}`,
    ...(record.outcome.reason ? [record.outcome.reason] : []),
    '',
    '## Evidence coverage',
    '',
    ...Object.entries(record.collection.coverage).map(
      ([name, { status }]) => `- ${name}: ${status}`,
    ),
    '',
    '## Recorded observations',
    '',
  ];
  if (!record.observations.length) lines.push('No actionable observations.');
  for (const observation of record.observations) {
    lines.push(`- ${observation.recorded} Expected: ${observation.expected}`);
    for (const ref of observation.evidence) lines.push(`  - \`${ref.path}#${ref.locator}\``);
    const answer = record.answers.find(({ observationId }) => observationId === observation.id);
    if (answer) {
      lines.push(`  - Worker (${answer.disposition}): ${answer.explanation}`);
      for (const ref of answer.counterEvidence ?? [])
        lines.push(`    - \`${ref.path}#${ref.locator}\``);
      if (answer.missingInputs?.length)
        lines.push(`    - Missing: ${answer.missingInputs.join(', ')}`);
    } else if (record.outcome.unansweredObservationIds.includes(observation.id)) {
      lines.push('  - Unanswered.');
    }
  }
  if (record.optionalSkips.length) {
    lines.push('', '## Recorded skips', '');
    for (const skip of record.optionalSkips)
      lines.push(
        `- Step ${skip.step}: ${skip.condition ?? 'Optionality unknown.'}${skip.reason ? ` Worker reason: ${skip.reason}` : ''}`,
      );
  }
  if (record.friction) lines.push('', '## Worker friction', '', record.friction);
  if (record.workflowCandidates.length) {
    lines.push('', '## Suggested workflow changes', '');
    for (const candidate of record.workflowCandidates)
      lines.push(
        `- ${candidate.lesson}`,
        `  - Instruction: ${candidate.instruction}`,
        `  - Measure: ${candidate.measure}`,
      );
  }
  return lines.join('\n') + '\n';
}
