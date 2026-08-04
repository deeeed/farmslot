import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type {
  TerminalAttachmentDeliverResult,
  TerminalAttachmentUploadResult,
} from '@farmslot/protocol';
import { TERMINAL_ATTACHMENT_CHUNK_BYTES, TERMINAL_ATTACHMENT_MAX_BYTES } from '@farmslot/protocol';

import {
  formatAttachmentSize,
  type ImageCandidate,
  imageCandidatesFromClipboard,
  imageCandidatesFromDrop,
  isTerminalAttachmentActive,
  isTerminalAttachmentRetryable,
  type TerminalAttachment,
  TerminalAttachmentQueue,
  type TerminalAttachmentTransport,
  terminalAttachmentStatusLabel,
} from './terminal-attachment-model.js';

function fakeFile(size: number, type = 'image/png', name = 'shot.png'): File {
  return {
    size,
    type,
    name,
    slice: (start: number, end: number) => ({ start, end }),
  } as unknown as File;
}

function clipboard(items: Array<{ kind: string; file: File | null }>, types: string[] = []) {
  return {
    items: items.map((item) => ({ kind: item.kind, getAsFile: () => item.file })),
    files: [],
    types,
  } as unknown as DataTransfer;
}

interface Recorder {
  uploads: Array<{ chunkIndex: number; chunkCount: number }>;
  delivers: string[];
  removed: string[];
  /** Phase/percent readings captured at each onChange — the queue mutates records in place. */
  readings: Array<{ phase: string; uploadPercent: number }>;
}

function harness(options: {
  deliver?: (id: string) => Promise<TerminalAttachmentDeliverResult>;
  uploadFails?: boolean;
}): {
  queue: TerminalAttachmentQueue;
  recorder: Recorder;
} {
  const recorder: Recorder = { uploads: [], delivers: [], removed: [], readings: [] };
  let seq = 0;
  const transport: TerminalAttachmentTransport = {
    async uploadChunk(params): Promise<TerminalAttachmentUploadResult> {
      recorder.uploads.push({ chunkIndex: params.chunkIndex, chunkCount: params.chunkCount });
      if (options.uploadFails) throw new Error('transport interrupted');
      const receivedBytes = Math.min(
        (params.chunkIndex + 1) * TERMINAL_ATTACHMENT_CHUNK_BYTES,
        params.byteLength,
      );
      const complete = params.chunkIndex === params.chunkCount - 1;
      return {
        attachmentId: params.attachmentId,
        complete,
        receivedBytes,
        byteLength: params.byteLength,
        mimeType: 'image/png',
        ...(complete
          ? {
              storedPath: `/repo/.agent/.attachments/${params.attachmentId}.png`,
              storedName: `${params.attachmentId}.png`,
              sha256: 'deadbeef',
              runner: 'claude',
              deliverySupported: true,
              reused: false,
            }
          : {}),
      };
    },
    async deliver(params) {
      recorder.delivers.push(params.attachmentId);
      return (
        (await options.deliver?.(params.attachmentId)) ?? {
          attachmentId: params.attachmentId,
          status: 'delivered',
          runner: 'claude',
          detail: 'Delivered shot.png to claude',
        }
      );
    },
    async readChunkBase64() {
      return 'AAAA';
    },
    newId: () => `att-${++seq}`,
    revokePreview: (url) => recorder.removed.push(url),
  };
  const queue = new TerminalAttachmentQueue(transport, () => {
    const first = queue.list()[0];
    if (first) recorder.readings.push({ phase: first.phase, uploadPercent: first.uploadPercent });
  });
  return { queue, recorder };
}

const CANDIDATE: ImageCandidate = {
  file: fakeFile(1024),
  filename: 'shot.png',
  mimeType: 'image/png',
};

test('clipboard text alone produces no attachment candidates', () => {
  assert.deepEqual(imageCandidatesFromClipboard(clipboard([{ kind: 'string', file: null }])), []);
  assert.deepEqual(imageCandidatesFromClipboard(null), []);
  assert.deepEqual(
    imageCandidatesFromClipboard(clipboard([{ kind: 'file', file: fakeFile(10, 'text/plain') }])),
    [],
  );
});

test('clipboard and drop image payloads land on the same candidate shape', () => {
  const file = fakeFile(2048, 'image/png', 'pasted.png');
  const pasted = imageCandidatesFromClipboard(clipboard([{ kind: 'file', file }]));
  const dropped = imageCandidatesFromDrop({
    files: [file],
    items: [],
    types: ['Files'],
  } as unknown as DataTransfer);
  assert.equal(pasted.length, 1);
  assert.deepEqual(pasted, dropped);
  assert.equal(pasted[0]!.mimeType, 'image/png');
});

test('a successful attachment walks upload → uploaded → delivering → attached', async () => {
  const { queue, recorder } = harness({});
  await queue.add(CANDIDATE, 'blob:preview');
  const phases = recorder.readings
    .map((reading) => reading.phase)
    .filter((phase, index, all) => phase !== all[index - 1]);
  assert.deepEqual(phases, ['uploading', 'uploaded', 'delivering', 'attached']);
  assert.deepEqual(recorder.uploads, [{ chunkIndex: 0, chunkCount: 1 }]);
  assert.deepEqual(recorder.delivers, ['att-1']);
  assert.equal(queue.list()[0]!.uploadPercent, 100);
});

test('uploaded is never reported as Attached', () => {
  const uploaded: TerminalAttachment = {
    id: 'a',
    filename: 'shot.png',
    mimeType: 'image/png',
    byteLength: 10,
    previewUrl: 'blob:x',
    phase: 'uploaded',
    uploadPercent: 100,
    detail: '',
  };
  assert.equal(terminalAttachmentStatusLabel(uploaded), 'Uploaded to slot');
  assert.equal(terminalAttachmentStatusLabel({ ...uploaded, phase: 'attached' }), 'Attached');
  assert.equal(
    terminalAttachmentStatusLabel({ ...uploaded, phase: 'uploading', uploadPercent: 42 }),
    'Uploading 42%',
  );
});

test('multi-chunk uploads report determinate progress', async () => {
  const { queue, recorder } = harness({});
  await queue.add(
    { ...CANDIDATE, file: fakeFile(TERMINAL_ATTACHMENT_CHUNK_BYTES * 2) },
    'blob:preview',
  );
  assert.deepEqual(recorder.uploads, [
    { chunkIndex: 0, chunkCount: 2 },
    { chunkIndex: 1, chunkCount: 2 },
  ]);
  const percents = recorder.readings.map((reading) => reading.uploadPercent);
  assert.ok(
    percents.includes(50),
    `expected an intermediate 50% reading, saw ${percents.join(',')}`,
  );
});

test('an interrupted upload stays retryable and never claims Attached', async () => {
  const { queue, recorder } = harness({ uploadFails: true });
  await queue.add(CANDIDATE, 'blob:preview');
  const attachment = queue.list()[0]!;
  assert.equal(attachment.phase, 'failed');
  assert.equal(attachment.detail, 'transport interrupted');
  assert.ok(isTerminalAttachmentRetryable(attachment));
  assert.deepEqual(recorder.delivers, []);
});

test('retry re-runs a failed attachment, and repeated sends cannot deliver it twice', async () => {
  let failNext = true;
  const recorderRef: { delivers: string[] } = { delivers: [] };
  let seq = 0;
  const transport: TerminalAttachmentTransport = {
    async uploadChunk(params) {
      if (failNext) {
        failNext = false;
        throw new Error('transport interrupted');
      }
      return {
        attachmentId: params.attachmentId,
        complete: true,
        receivedBytes: params.byteLength,
        byteLength: params.byteLength,
        mimeType: 'image/png',
        storedPath: '/repo/.agent/.attachments/att.png',
        runner: 'codex',
        deliverySupported: true,
        reused: false,
      };
    },
    async deliver(params) {
      recorderRef.delivers.push(params.attachmentId);
      return {
        attachmentId: params.attachmentId,
        status: 'delivered',
        runner: 'codex',
        detail: 'ok',
      };
    },
    async readChunkBase64() {
      return 'AAAA';
    },
    newId: () => `att-${++seq}`,
    revokePreview: () => {},
  };
  const queue = new TerminalAttachmentQueue(transport, () => {});
  await queue.add(CANDIDATE, 'blob:preview');
  assert.equal(queue.list()[0]!.phase, 'failed');

  await queue.send('att-1');
  assert.equal(queue.list()[0]!.phase, 'attached');
  assert.deepEqual(recorderRef.delivers, ['att-1']);

  // Second submit on an already-delivered attachment must be a no-op.
  await queue.send('att-1');
  assert.deepEqual(recorderRef.delivers, ['att-1']);
});

test('an unsupported runner surfaces its own phase and detail', async () => {
  const { queue } = harness({
    deliver: async (id) => ({
      attachmentId: id,
      status: 'unsupported',
      runner: 'opencode',
      detail: 'Runner opencode has no verified image attachment support',
    }),
  });
  await queue.add(CANDIDATE, 'blob:preview');
  const attachment = queue.list()[0]!;
  assert.equal(attachment.phase, 'unsupported');
  assert.equal(terminalAttachmentStatusLabel(attachment), 'Unsupported runner');
  assert.match(attachment.detail, /no verified image attachment support/);
  assert.equal(isTerminalAttachmentRetryable(attachment), false);
});

test('oversized images are rejected client-side without touching the transport', async () => {
  const { queue, recorder } = harness({});
  await queue.add(
    { ...CANDIDATE, file: fakeFile(TERMINAL_ATTACHMENT_MAX_BYTES + 1) },
    'blob:preview',
  );
  assert.equal(queue.list()[0]!.phase, 'failed');
  assert.deepEqual(recorder.uploads, []);
  assert.match(queue.list()[0]!.detail, /limit is 8\.0 MB/);
});

test('remove drops the card and releases its preview URL', async () => {
  const { queue, recorder } = harness({});
  await queue.add(CANDIDATE, 'blob:preview');
  queue.remove('att-1');
  assert.deepEqual(queue.list(), []);
  assert.deepEqual(recorder.removed, ['blob:preview']);
});

test('active attachments block removal, settled ones do not', () => {
  const base: TerminalAttachment = {
    id: 'a',
    filename: 'shot.png',
    mimeType: 'image/png',
    byteLength: 10,
    previewUrl: 'blob:x',
    phase: 'uploading',
    uploadPercent: 0,
    detail: '',
  };
  assert.ok(isTerminalAttachmentActive(base));
  assert.ok(isTerminalAttachmentActive({ ...base, phase: 'delivering' }));
  for (const phase of ['uploaded', 'attached', 'unsupported', 'failed'] as const) {
    assert.equal(isTerminalAttachmentActive({ ...base, phase }), false);
  }
});

test('size formatting stays readable across magnitudes', () => {
  assert.equal(formatAttachmentSize(512), '512 B');
  assert.equal(formatAttachmentSize(2048), '2.0 KB');
  assert.equal(formatAttachmentSize(3 * 1024 * 1024), '3.0 MB');
});
