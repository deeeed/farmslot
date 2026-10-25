// Setup before the UI starts, using the actual private actor and owning assessment store.
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
} from '../../../services/gateway/src/assessment/store.ts';
import { writeAtomicJSON } from '../../../services/gateway/src/core/atomic-json.ts';
import { runWithPrincipalOwner } from '../../../services/gateway/src/security/work-originator.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.cwd(), root);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
assert.equal(process.env.FARMSLOT_ASSESSMENT_HISTORY_PROOF, '1');
const output = path.resolve(process.env.FARMSLOT_TRIAGE_PROOF_SETUP);
const setup = JSON.parse(await readFile(output, 'utf8'));
assert(setup.setupOnly && setup.home === process.env.FARMSLOT_HOME);
assert(!setup.assessments && !output.startsWith(root + '/'));
const target = await automationGatewayTarget();
assert.equal(new URL(target.url).hostname, '127.0.0.1');
assert.equal(new URL(target.url).port, '7913');
const socket = new WebSocket(target.url);
let principal;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Private assessment setup deadline')), 10000);
    const finish = (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    socket.once('error', () => finish(new Error('Private setup authentication transport failed')));
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
const directory = path.join(setup.home, 'assessments');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
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
setup.assessments = [];
setup.ownerId = principal.id;
setup.ownerGeneration = principal.generation ?? 0;
const checkpoint = () => writeFile(output, JSON.stringify(setup) + '\n', { mode: 0o600 });
await checkpoint();
await runWithPrincipalOwner(
  { ownerId: setup.ownerId, ownerGeneration: setup.ownerGeneration },
  async () => {
    for (const kind of ['outcome', 'expiry']) {
      const snapshotHash = digest(
        JSON.stringify({ runId: setup.runId, kind, case: path.basename(path.dirname(output)) }),
      );
      const record = await beginAssessment({
        ownerId: setup.ownerId,
        consumer: kind === 'outcome' ? 'failure-triage' : 'static-review-checklist',
        subject:
          kind === 'outcome'
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
      setup.assessments.push({ id: record.id, file, kind });
      await checkpoint();
      await finishAssessment(record, {
        status: 'completed',
        attempted: false,
        answers:
          kind === 'outcome'
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
      } else setup.assessmentId = record.id;
      await checkpoint();
    }
  },
);
setup.assessmentSeededBeforeUi = true;
await checkpoint();
console.log(
  JSON.stringify({
    ownerId: setup.ownerId,
    assessments: setup.assessments.map(({ id, kind }) => ({ id, kind })),
    expiryAt: setup.expiryAt,
    providerCalls: 0,
  }),
);
