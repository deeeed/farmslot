import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  collectTaskDebrief,
  completeTaskDebrief,
  readTaskDebrief,
  renderTaskDebrief,
  writeTaskDebrief,
} from '../src/index.js';

function fixture(t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'task-debrief-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(fileURLToPath(new URL('fixtures/task-debrief', import.meta.url)), directory, {
    recursive: true,
  });
  return directory;
}

test('retains receipt facts and a dispute once, and rejects a stale accepted result', (t) => {
  const directory = fixture(t);
  const request = collectTaskDebrief(directory);
  const [remark] = request.record.observations;
  assert.equal(remark?.rule, 'proof-remarked');
  assert.equal(request.record.optionalSkips[0]?.condition, 'No runtime behavior changed');
  const response = {
    requestId: request.requestId,
    answers: [
      {
        observationId: remark!.id,
        disposition: 'disputed',
        explanation: 'The second mark clarified the report. The first claim was valid.',
        counterEvidence: remark!.evidence,
      },
    ],
    workflowCandidates: [],
  };
  const record = completeTaskDebrief(request, response);
  writeTaskDebrief(directory, record);
  writeTaskDebrief(directory, record);
  assert.deepEqual(readTaskDebrief(directory, {}), record);
  assert.match(renderTaskDebrief(record), /Worker \(disputed\)/);

  assert.throws(
    () =>
      completeTaskDebrief(request, {
        ...response,
        answers: [...response.answers, ...response.answers],
      }),
    /duplicate/,
  );
  assert.throws(
    () =>
      completeTaskDebrief(request, {
        ...response,
        answers: [{ ...response.answers[0], observationId: '1'.repeat(64) }],
      }),
    /unknown/,
  );
  assert.throws(
    () =>
      completeTaskDebrief(request, {
        ...response,
        answers: [
          {
            ...response.answers[0],
            counterEvidence: [{ ...remark!.evidence[0], path: '../SIGNAL.json' }],
          },
        ],
      }),
    /schema/,
  );

  writeFileSync(path.join(directory, 'artifacts/report.md'), '# Changed result\n');
  assert.throws(() => readTaskDebrief(directory, {}), /no longer matches/);
  assert.throws(() => completeTaskDebrief(collectTaskDebrief(directory), response), /stale/);
});

test('keeps observations when the answer is blocked and detects an escaping input', (t) => {
  const directory = fixture(t);
  const request = collectTaskDebrief(directory);
  const record = completeTaskDebrief(request, {
    requestId: request.requestId,
    answers: [
      {
        observationId: request.record.observations[0]!.id,
        disposition: 'explained',
        explanation: '-----BEGIN PRIVATE KEY-----',
      },
    ],
    workflowCandidates: [],
    friction: 'This must also be omitted.',
  });
  assert.equal(record.outcome.status, 'redacted');
  assert.deepEqual(record.observations, request.record.observations);
  assert.deepEqual(record.answers, []);
  assert.equal(record.friction, undefined);

  rmSync(path.join(directory, 'SIGNAL.json'));
  symlinkSync('/dev/null', path.join(directory, 'SIGNAL.json'));
  const invalid = collectTaskDebrief(directory);
  assert.equal(invalid.record.collection.coverage.signal.status, 'invalid');
  assert.deepEqual(invalid.record.observations, []);
  assert.equal(invalid.record.identity.binding, 'advisory');
});
