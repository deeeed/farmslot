import assert from 'node:assert/strict';
import test from 'node:test';

import { NativeStderrCapture } from './stderr.js';

test('stderr redaction handles split credentials, color and quoted unknown secrets', () => {
  const capture = new NativeStderrCapture({ API_TOKEN: 'private-value' });
  capture.write(Buffer.from('\u001b[31mprivate-'));
  capture.write(
    Buffer.from(
      'value\u001b[0m\nAuthorization: Bearer other-token\n{"password":"unknown secret with spaces"}\n',
    ),
  );
  capture.end();
  assert.deepEqual(capture.snapshot(), [
    '[redacted]',
    'Authorization: [redacted]',
    '{"password":[redacted]}',
  ]);
});

test('stderr retains the last fifty lines and omits oversized partial lines', () => {
  const capture = new NativeStderrCapture({});
  capture.write(Buffer.from('x'.repeat(5000)));
  capture.write(Buffer.from('\nlast line'));
  capture.end();
  assert.deepEqual(capture.snapshot(), ['[stderr line omitted: too long]', 'last line']);
  capture.write(Buffer.from(Array.from({ length: 60 }, (_, index) => `${index}\n`).join('')));
  capture.end();
  assert.equal(capture.snapshot().length, 50);
  assert.equal(capture.snapshot()[0], '10');
  assert.equal(capture.snapshot().at(-1), '59');
});

test('stderr redacts quoted HTTP headers with escaped values', () => {
  const capture = new NativeStderrCapture({});
  capture.write(
    Buffer.from(
      '{"Cookie":"session=unknown-secret", "Authorization":"custom \\"credential\\"", "Set-Cookie":"other-secret"}\n',
    ),
  );
  capture.end();
  assert.deepEqual(capture.snapshot(), [
    '{"Cookie":"[redacted]", "Authorization":"[redacted]", "Set-Cookie":"[redacted]"}',
  ]);
});

test('a short auth environment value cannot hide an unknown credential assignment', () => {
  const capture = new NativeStderrCapture({ AUTH_KIND: 'token' });
  capture.write(Buffer.from('token=unknown-secret\n'));
  capture.end();
  assert.ok(!capture.snapshot().join('\n').includes('unknown-secret'));
});
