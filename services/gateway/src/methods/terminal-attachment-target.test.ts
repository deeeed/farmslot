// @farmslot:serial — writes slot fixtures into the shared repo `pool/` directory.
//
// Regression guard for the routing an image attachment inherits. A postmortem terminal
// (`bareSession: true`) is attached to the slot's bare PTY, so attachment upload/delivery must
// resolve to that bare session — never to the still-active run's primary context, whose pane the
// operator is not looking at and whose runner may differ.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { TERMINAL_ATTACHMENT_CHUNK_BYTES } from '@farmslot/protocol';

import { poolDir } from '../core/config.js';
import { createRun, deleteRun, updateRun } from '../runs/store.js';

import { resolveAgentOrBareTarget } from './terminal.js';
import { terminalAttachmentUpload } from './terminal-attachment.js';

const SLOT_ID = 'runner-browser-attach-1';
const testPoolFile = path.join(poolDir, `attachment-target-fixture-${process.pid}.json`);

before(() => {
  mkdirSync(poolDir, { recursive: true });
  writeFileSync(
    testPoolFile,
    JSON.stringify(
      {
        machine: 'attachment-target-test',
        project: 'example-browser-farm',
        platform: 'browser',
        os: 'darwin',
        host: 'localhost',
        ssh_user: 'test',
        slots: [{ id: SLOT_ID, repo: '/tmp/farmslot-attachment-target', session: 'mat-1' }],
      },
      null,
      2,
    ),
    'utf-8',
  );
});

after(() => {
  rmSync(testPoolFile, { force: true });
});

/** Seed an active run whose only agent context lives in a role window with its own runner. */
function seedRunWithReviewContext(t: { after: (fn: () => unknown) => void }): void {
  const run = createRun({
    flowType: 'review-pr',
    project: 'example-browser-farm',
    ticketOrPr: `example-org/example-browser#${Date.now()}`,
    slotId: SLOT_ID,
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  updateRun(run.id, {
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'Review',
        status: 'working',
        slotId: SLOT_ID,
        runId: run.id,
        runner: 'codex',
        target: { session: 'mat-1', window: 'review', pane: '0', target: 'mat-1:review.0' },
      },
    ],
  });
}

test('bareSession attachments resolve to the bare PTY, not the active run context', async (t) => {
  seedRunWithReviewContext(t);

  // Without bareSession the active run wins — this is the path a live terminal uses.
  const contextual = await resolveAgentOrBareTarget(SLOT_ID, {});
  assert.equal(contextual.target, 'mat-1:review');
  assert.equal(contextual.runner, 'codex');

  // Postmortem: same slot, same active run, but the operator is on the bare PTY.
  const bare = await resolveAgentOrBareTarget(SLOT_ID, { bareSession: true });
  assert.equal(bare.target, 'mat-1');
  assert.equal(bare.session, 'mat-1');
  // No agent context resolved, so no context runner may leak into provider selection.
  assert.equal(bare.runner, undefined);
});

test('terminal.attachment.upload honours bareSession when binding the upload target', async (t) => {
  seedRunWithReviewContext(t);

  const attachmentId = `att-bare-${process.pid}`;
  const byteLength = TERMINAL_ATTACHMENT_CHUNK_BYTES + 10;
  const first = await terminalAttachmentUpload({
    slotId: SLOT_ID,
    bareSession: true,
    attachmentId,
    filename: 'postmortem.png',
    mimeType: 'image/png',
    byteLength,
    chunkIndex: 0,
    chunkCount: 2,
    contentBase64: Buffer.alloc(TERMINAL_ATTACHMENT_CHUNK_BYTES, 1).toString('base64'),
  });
  assert.equal(first.complete, false);

  // The second chunk drops bareSession, so it resolves to the run context's pane. The upload
  // must refuse rather than stitch one image out of bytes bound to two different panes — which
  // only happens if the first chunk was genuinely bound to the bare session.
  await assert.rejects(
    () =>
      terminalAttachmentUpload({
        slotId: SLOT_ID,
        attachmentId,
        filename: 'postmortem.png',
        mimeType: 'image/png',
        byteLength,
        chunkIndex: 1,
        chunkCount: 2,
        contentBase64: Buffer.alloc(10, 1).toString('base64'),
      }),
    /started against mat-1 but this chunk resolved to mat-1:review/,
  );
});
