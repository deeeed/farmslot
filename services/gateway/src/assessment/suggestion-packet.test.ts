import assert from 'node:assert/strict';
import test from 'node:test';

import type { AssessmentSuggestionInput } from '@farmslot/protocol';

import { suggestionPacket } from './suggestion-packet.js';

const pr = { host: 'github.com', repo: 'example/app', number: 42, headSha: 'a'.repeat(40) };
const source = { classification: 'synthetic' as const, ref: 'synthetic:public-fixture' };

const checklist: AssessmentSuggestionInput = {
  kind: 'static-review-checklist',
  source,
  pr,
  context: 'A navigation link changed.',
  items: [
    {
      id: 'nav',
      text: 'Navigation preserves the original destination',
      evidence: 'src/nav.ts:12 before /home, after /account',
    },
  ],
};

test('static checklist returns one bounded per-item question and retains the exact context for feedback', () => {
  const packet = suggestionPacket(checklist);
  assert.deepEqual(Object.keys(packet.questions), ['item_nav']);
  assert.equal(packet.questions.item_nav?.type, 'choice');
  assert.equal(packet.subject.suggestion?.items?.[0]?.evidence, checklist.items?.[0]?.evidence);
  assert.equal(packet.subject.pr?.headSha, pr.headSha);
  assert.equal(packet.state.kind, checklist.kind);
  assert.equal('pr' in packet.state, false);
  assert.match(packet.packetHash, /^[a-f0-9]{64}$/);
});

test('copilot chooses only an existing named read; routing returns existing depth or abstain', () => {
  const copilot = suggestionPacket(
    {
      kind: 'copilot-context',
      source,
      runId: 'run-123',
      context: 'A failed step has no recent output.',
      candidates: [
        { id: 'status', description: 'Read run status' },
        { id: 'logs', description: 'Read bounded worker log' },
      ],
    },
    { id: 'run-123', project: 'example', status: 'failed' },
  );
  assert.deepEqual(
    Object.keys(
      copilot.questions.next_read?.type === 'choice' ? copilot.questions.next_read.criteria : {},
    ),
    ['status', 'logs', 'abstain'],
  );
  assert.equal(copilot.subject.run?.id, 'run-123');
  assert.equal('run' in copilot.state, false);
  assert.notEqual(
    copilot.packetHash,
    suggestionPacket(
      {
        kind: 'copilot-context',
        source,
        runId: 'run-456',
        context: 'A failed step has no recent output.',
        candidates: [
          { id: 'status', description: 'Read run status' },
          { id: 'logs', description: 'Read bounded worker log' },
        ],
      },
      { id: 'run-456', project: 'example', status: 'failed' },
    ).packetHash,
  );
  assert.equal(copilot.subject.run?.snapshotHash, copilot.packetHash);
  assert.deepEqual(
    Object.keys(
      suggestionPacket({
        kind: 'review-routing',
        source,
        pr,
        context: 'The PR changes runtime routing.',
      }).questions,
    ),
    ['route'],
  );
});

test('public source keeps the selected PR host in its identity', () => {
  const host = 'git.example.com';
  const packet = suggestionPacket({
    ...checklist,
    pr: { ...pr, host },
    source: { classification: 'public', ref: `https://${host}/example/app/pull/42` },
  });
  assert.equal(packet.subject.pr?.host, host);
  assert.equal(packet.subject.suggestion?.source?.ref, `https://${host}/example/app/pull/42`);
});

test('unadmitted input, unrelated public URL, malformed identities and extra fields refuse before transport', () => {
  assert.throws(
    () =>
      suggestionPacket({
        ...checklist,
        source: { classification: 'public', ref: 'https://github.com/example/app/pull/420' },
      }),
    /Public source/,
  );
  assert.throws(
    () =>
      suggestionPacket({
        ...checklist,
        source: { classification: 'public', ref: 'https://user:pw@github.com/example/app/pull/42' },
      }),
    /Public source/,
  );
  assert.throws(
    () =>
      suggestionPacket({
        ...checklist,
        source: { classification: 'private' as 'public', ref: 'private:fixture' },
      }),
    /Admit/,
  );
  assert.throws(
    () => suggestionPacket({ ...checklist, items: [{ ...checklist.items![0], evidence: '' }] }),
    /checklist/,
  );
  assert.throws(
    () =>
      suggestionPacket({
        ...checklist,
        candidates: [{ id: 'other', description: 'Read anything' }],
      }),
    /context candidates/,
  );
  assert.throws(
    () => suggestionPacket({ ...checklist, unexpected: 'leak' } as AssessmentSuggestionInput),
    /Invalid suggestion input/,
  );
  assert.throws(
    () =>
      suggestionPacket(
        {
          kind: 'copilot-context',
          source: {
            classification: 'public',
            ref: 'https://user:password@example.com/logs',
          },
          runId: 'run-123',
          context: 'Read status',
          candidates: [
            { id: 'status', description: 'Read status' },
            { id: 'logs', description: 'Read logs' },
          ],
        },
        { id: 'run-123', project: 'example', status: 'failed' },
      ),
    /credentials or parameters/,
  );
});
