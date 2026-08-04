import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  isTerminalAttachmentCleanupScope,
  TERMINAL_ATTACHMENT_CHUNK_BYTES,
  TERMINAL_ATTACHMENT_MAX_BYTES,
  type TerminalAttachmentUploadParams,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

import {
  expectedChunkBytes,
  isStaleTerminalAttachment,
  isTerminalAttachmentStoredName,
  resolveTerminalAttachmentPath,
  TERMINAL_ATTACHMENT_STALE_MS,
  terminalAttachmentDir,
  terminalAttachmentStoredName,
  validateTerminalAttachmentChunk,
} from './terminal-attachment-model.js';

const DIR = terminalAttachmentDir('/repo/slot', '.agent');

function uploadParams(
  overrides: Partial<TerminalAttachmentUploadParams> = {},
): TerminalAttachmentUploadParams {
  const bytes = Buffer.from('image-bytes');
  return {
    slotId: 'slot-1',
    attachmentId: 'att-1',
    filename: 'shot.png',
    mimeType: 'image/png',
    byteLength: bytes.byteLength,
    chunkIndex: 0,
    chunkCount: 1,
    contentBase64: bytes.toString('base64'),
    ...overrides,
  };
}

function expectMethodError(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof GatewayMethodError, `expected GatewayMethodError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

test('attachment dir lives under the project runtime dir', () => {
  assert.equal(DIR, '/repo/slot/.agent/.attachments');
  assert.equal(
    terminalAttachmentDir('/repo/slot', '.sandbox/x'),
    '/repo/slot/.sandbox/x/.attachments',
  );
});

test('stored names are derived from the attachment id, never the client filename', () => {
  const name = terminalAttachmentStoredName('att-1', 'image/png');
  assert.ok(isTerminalAttachmentStoredName(name));
  assert.equal(name, terminalAttachmentStoredName('att-1', 'image/png'));
  assert.notEqual(name, terminalAttachmentStoredName('att-2', 'image/png'));
  assert.ok(!name.includes('shot'));
  assert.ok(terminalAttachmentStoredName('../../etc/passwd', 'image/jpeg').endsWith('.jpg'));
  assert.ok(isTerminalAttachmentStoredName(terminalAttachmentStoredName('../../x', 'image/webp')));
});

test('stored paths cannot escape the attachment directory', () => {
  const stored = terminalAttachmentStoredName('att-1', 'image/png');
  assert.equal(resolveTerminalAttachmentPath(DIR, stored), `${DIR}/${stored}`);
  for (const escape of [
    '../evil.png',
    '../../etc/passwd',
    '/etc/passwd',
    'nested/att.png',
    'att-1.png',
    '',
  ]) {
    assert.equal(resolveTerminalAttachmentPath(DIR, escape), null, `expected null for ${escape}`);
  }
});

test('chunk validation rejects non-image MIME types', () => {
  expectMethodError(
    () => validateTerminalAttachmentChunk(uploadParams({ mimeType: 'application/pdf' })),
    'ATTACHMENT_UNSUPPORTED_MIME',
  );
  expectMethodError(
    () => validateTerminalAttachmentChunk(uploadParams({ mimeType: '' })),
    'ATTACHMENT_UNSUPPORTED_MIME',
  );
});

test('chunk validation enforces the byte limit', () => {
  expectMethodError(
    () =>
      validateTerminalAttachmentChunk(
        uploadParams({ byteLength: TERMINAL_ATTACHMENT_MAX_BYTES + 1, chunkCount: 17 }),
      ),
    'ATTACHMENT_TOO_LARGE',
  );
  expectMethodError(
    () => validateTerminalAttachmentChunk(uploadParams({ byteLength: 0 })),
    'ATTACHMENT_INVALID_SIZE',
  );
});

test('chunk validation rejects a payload that does not match the declared chunk', () => {
  expectMethodError(
    () => validateTerminalAttachmentChunk(uploadParams({ byteLength: 99 })),
    'ATTACHMENT_SIZE_MISMATCH',
  );
  expectMethodError(
    () => validateTerminalAttachmentChunk(uploadParams({ chunkIndex: 3 })),
    'ATTACHMENT_INVALID_CHUNK',
  );
  expectMethodError(
    () => validateTerminalAttachmentChunk(uploadParams({ chunkCount: 4 })),
    'ATTACHMENT_INVALID_CHUNK',
  );
  expectMethodError(
    () => validateTerminalAttachmentChunk(uploadParams({ attachmentId: '  ' })),
    'ATTACHMENT_INVALID_ID',
  );
});

test('multi-chunk uploads declare per-chunk sizes that sum to the whole image', () => {
  const byteLength = TERMINAL_ATTACHMENT_CHUNK_BYTES + 100;
  assert.equal(expectedChunkBytes(byteLength, 0), TERMINAL_ATTACHMENT_CHUNK_BYTES);
  assert.equal(expectedChunkBytes(byteLength, 1), 100);
  const tail = validateTerminalAttachmentChunk(
    uploadParams({
      byteLength,
      chunkCount: 2,
      chunkIndex: 1,
      contentBase64: Buffer.alloc(100, 7).toString('base64'),
    }),
  );
  assert.equal(tail.chunk.byteLength, 100);
});

test('a valid single-chunk upload passes through with its decoded bytes', () => {
  const validated = validateTerminalAttachmentChunk(uploadParams());
  assert.equal(validated.attachmentId, 'att-1');
  assert.equal(validated.mimeType, 'image/png');
  assert.equal(validated.chunk.toString(), 'image-bytes');
});

test('the stale sweep is bounded and fails closed on an unusable timestamp', () => {
  const now = 10_000_000_000;
  assert.equal(isStaleTerminalAttachment(now - 1000, now), false);
  assert.equal(isStaleTerminalAttachment(now - TERMINAL_ATTACHMENT_STALE_MS - 1, now), true);
  // A node build predating the mtimeMs field must not make every staged file look ancient.
  for (const unusable of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isStaleTerminalAttachment(unusable, now), false);
  }
});

test('cleanup scopes are validated before anything is deleted', () => {
  for (const scope of ['all', 'stale']) {
    assert.equal(isTerminalAttachmentCleanupScope(scope), true);
  }
  // Anything unrecognised must be refused rather than falling through to delete-everything.
  for (const scope of ['ALL', 'everything', '', null, undefined, 0, {}]) {
    assert.equal(
      isTerminalAttachmentCleanupScope(scope),
      false,
      `${String(scope)} must be refused`,
    );
  }
});
