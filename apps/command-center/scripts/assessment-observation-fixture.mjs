// Setup before the UI starts, using the actual private actor and owning assessment store.
// Authority: FARMSLOT_ASSESSMENT_AUTHORITY_PROOF=1 node --import tsx <this-file>
// authority-seed, or authority-feedback <assessmentId>. Both print the exact owner,
// generation, assessment/run IDs and source SHA-256; feedback also prints its revisions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';
import { serializeAssessment } from '../../../services/gateway/src/assessment/record-validation.ts';
import {
  beginAssessment,
  finishAssessment,
  recordAssessmentFeedback,
} from '../../../services/gateway/src/assessment/store.ts';
import { writeAtomicJSON } from '../../../services/gateway/src/core/atomic-json.ts';
import { runWithPrincipalOwner } from '../../../services/gateway/src/security/work-originator.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.cwd(), root);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
const mode = process.argv[2];
assert(!mode || ['authority-seed', 'authority-feedback'].includes(mode));
const authority = Boolean(mode);
assert.equal(
  process.env[
    authority ? 'FARMSLOT_ASSESSMENT_AUTHORITY_PROOF' : 'FARMSLOT_ASSESSMENT_HISTORY_PROOF'
  ],
  '1',
);
const output = path.resolve(process.env.FARMSLOT_TRIAGE_PROOF_SETUP);
const setup = JSON.parse(await readFile(output, 'utf8'));
assert(setup.setupOnly && setup.home === process.env.FARMSLOT_HOME);
assert((authority || !setup.assessments) && !output.startsWith(root + '/'));
const feedbackItem =
  mode === 'authority-feedback'
    ? setup.assessments?.find((item) => item.id === process.argv[3] && item.kind === 'authority')
    : undefined;
if (mode === 'authority-feedback')
  assert(feedbackItem, 'Select an exactly recorded authority seed');
if (feedbackItem) {
  assert(typeof feedbackItem.ownerId === 'string' && feedbackItem.ownerId.length > 0);
  assert(Number.isSafeInteger(feedbackItem.ownerGeneration) && feedbackItem.ownerGeneration >= 0);
  assert(
    setup.assessmentBaseline,
    'Authority feedback must retain the original assessment baseline',
  );
}
let principal;
if (mode !== 'authority-feedback') {
  const target = await automationGatewayTarget();
  assert.equal(new URL(target.url).hostname, '127.0.0.1');
  assert.equal(new URL(target.url).port, '7913');
  const socket = new WebSocket(target.url);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Private assessment setup deadline')), 10000);
      const finish = (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      socket.once('error', () =>
        finish(new Error('Private setup authentication transport failed')),
      );
      socket.once('open', () =>
        socket.send(
          JSON.stringify({
            type: 'req',
            id: 'auth',
            method: 'auth.connect',
            params: { ...target.credential, clientKind: 'ui', clientName: 'assessment-fixture' },
          }),
        ),
      );
      socket.on('message', (raw) => {
        try {
          const frame = JSON.parse(String(raw));
          if (frame.id === 'auth') {
            assert(frame.ok && frame.payload.principal.roles.some((row) => row.role === 'admin'));
            principal = frame.payload.principal;
            socket.send(
              JSON.stringify({
                type: 'req',
                id: 'run',
                method: 'run.get',
                params: { runId: setup.runId },
                resourceRead: { version: 1 },
              }),
            );
          } else if (frame.id === 'run') {
            assert(
              frame.ok &&
                frame.resourceState?.epoch &&
                frame.payload.run.id === setup.runId &&
                frame.payload.run.status === 'done',
            );
            setup.assessmentSetupRead = {
              principal,
              resourceState: frame.resourceState,
              runId: setup.runId,
              at: Date.now(),
            };
            if (authority)
              (setup.assessmentAuthorityReads ??= []).push({
                ownerId: principal.id,
                ownerGeneration: principal.generation ?? 0,
                resourceState: frame.resourceState,
                runId: setup.runId,
                at: Date.now(),
              });
            finish();
          }
        } catch (error) {
          finish(error);
        }
      });
    });
  } finally {
    socket.close();
  }
}
const directory = path.join(setup.home, 'assessments');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (!setup.assessmentBaseline) {
  let previous = [];
  try {
    previous = await readdir(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  setup.assessmentBaseline = {};
  for (const name of previous.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
    assert(/^[a-f0-9-]{36}\.json$/.test(name));
    const bytes = await readFile(path.join(directory, name));
    assert(
      Date.parse(JSON.parse(bytes).startedAt) >= Date.now() - 30 * 86400_000,
      'Refuse setup that would prune an original expired record',
    );
    setup.assessmentBaseline[name] = digest(bytes);
  }
}
setup.assessments ??= [];
const ownerId = feedbackItem ? feedbackItem.ownerId : principal.id;
const ownerGeneration = feedbackItem ? feedbackItem.ownerGeneration : (principal.generation ?? 0);
if (!authority) {
  setup.ownerId = ownerId;
  setup.ownerGeneration = ownerGeneration;
}
if (mode === 'authority-seed')
  assert(
    !setup.assessments.some(
      (item) => item.ownerId === ownerId && item.ownerGeneration === ownerGeneration,
    ),
    'Seed each exact authority owner once',
  );
const checkpoint = () => writeFile(output, JSON.stringify(setup) + '\n', { mode: 0o600 });
let authorityResult;
await checkpoint();
await runWithPrincipalOwner({ ownerId, ownerGeneration }, async () => {
  if (feedbackItem) {
    const file = path.join(directory, `${feedbackItem.id}.json`);
    assert.equal(feedbackItem.file, file);
    assert.equal(feedbackItem.runId, setup.runId);
    const before = await readFile(file);
    assert(
      feedbackItem.allowedHashes.includes(digest(before)),
      'Refuse a foreign assessment write',
    );
    const record = JSON.parse(before);
    assert.equal(record.id, feedbackItem.id);
    assert.equal(record.ownerId, ownerId);
    assert.equal(record.ownerGeneration ?? 0, ownerGeneration);
    assert.equal(record.subject.run.id, setup.runId);
    assert.equal(record.subject.run.project, setup.project);
    assert.equal(record.status, 'completed');
    const expectedRevision = record.feedback.length;
    const updated = await recordAssessmentFeedback(ownerId, {
      id: record.id,
      expectedRevision,
      questionId: 'cause',
      verdict: 'correct',
      adviceUsed: false,
      adviceShown: true,
      evidenceRef: 'Synthetic D07 authority source change; no provider result claimed',
    });
    const sourceSha256 = digest(await readFile(file));
    feedbackItem.allowedHashes.push(sourceSha256);
    feedbackItem.sourceSha256 = sourceSha256;
    feedbackItem.feedbackRevision = updated.feedback.length;
    authorityResult = {
      authorityFeedback: true,
      assessmentId: record.id,
      ownerId,
      ownerGeneration,
      runId: setup.runId,
      expectedRevision,
      feedbackRevision: updated.feedback.length,
      beforeSha256: digest(before),
      sourceSha256,
      committedAt: Date.now(),
      providerCalls: 0,
    };
    setup.assessmentAuthorityFeedback = authorityResult;
    return;
  }
  for (const kind of authority ? ['authority'] : ['outcome', 'expiry']) {
    const snapshotHash = digest(
      JSON.stringify({ runId: setup.runId, kind, case: path.basename(path.dirname(output)) }),
    );
    const record = await beginAssessment({
      ownerId,
      consumer: kind !== 'expiry' ? 'failure-triage' : 'static-review-checklist',
      subject:
        kind !== 'expiry'
          ? { run: { id: setup.runId, project: setup.project, step: 'validation', snapshotHash } }
          : {
              suggestion: {
                kind: 'static-review-checklist',
                source: { classification: 'synthetic', ref: 'synthetic:d07-assessment-expiry' },
                context: 'Pre-client expiry fixture; no provider was invoked.',
              },
            },
    });
    const file = path.join(directory, `${record.id}.json`);
    const item = { id: record.id, file, kind };
    if (authority)
      Object.assign(item, {
        ownerId,
        ownerGeneration,
        runId: setup.runId,
        allowedHashes: [digest(await readFile(file))],
      });
    setup.assessments.push(item);
    await checkpoint();
    await finishAssessment(record, {
      status: 'completed',
      attempted: false,
      answers:
        kind !== 'expiry'
          ? { cause: { type: 'choice', choice: 'unclear', choices: ['unclear', 'test_harness'] } }
          : { color: { type: 'choice', choice: 'blue', choices: ['blue', 'red'] } },
    });
    if (kind === 'expiry') {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      setup.expiryAt = Date.now() + 90000;
      saved.startedAt = new Date(setup.expiryAt - 30 * 86400_000 - 1).toISOString();
      saved.completedAt = new Date(Date.parse(saved.startedAt) + 1).toISOString();
      serializeAssessment(saved);
      await writeAtomicJSON(file, saved);
      setup.expiringAssessmentId = record.id;
      setup.expiringFileSha256 = digest(await readFile(file));
    } else if (!authority) setup.assessmentId = record.id;
    if (authority) {
      const sourceSha256 = digest(await readFile(file));
      item.allowedHashes.push(sourceSha256);
      item.sourceSha256 = sourceSha256;
      item.feedbackRevision = 0;
      authorityResult = {
        authoritySeeded: true,
        assessmentId: record.id,
        ownerId,
        ownerGeneration,
        runId: setup.runId,
        sourceSha256,
        providerCalls: 0,
      };
    }
    await checkpoint();
  }
});
if (!authority) setup.assessmentSeededBeforeUi = true;
await checkpoint();
console.log(
  JSON.stringify(
    authorityResult ?? {
      ownerId: setup.ownerId,
      assessments: setup.assessments.map(({ id, kind }) => ({ id, kind })),
      expiryAt: setup.expiryAt,
      providerCalls: 0,
    },
  ),
);
