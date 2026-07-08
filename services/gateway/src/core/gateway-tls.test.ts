import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_GATEWAY_TLS_PORT,
  loadGatewayTlsMaterial,
  parseGatewayTlsConfig,
} from './gateway-tls.js';

const opensslAvailable = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;

test('parseGatewayTlsConfig returns null when TLS env is unset', () => {
  assert.equal(parseGatewayTlsConfig({}), null);
});

test('parseGatewayTlsConfig throws a teaching error when only one of cert/key is set', () => {
  assert.throws(
    () => parseGatewayTlsConfig({ FARMSLOT_GATEWAY_TLS_CERT: '/tmp/c.pem' }),
    /FARMSLOT_GATEWAY_TLS_KEY.*certs setup/s,
  );
  assert.throws(
    () => parseGatewayTlsConfig({ FARMSLOT_GATEWAY_TLS_KEY: '/tmp/k.pem' }),
    /FARMSLOT_GATEWAY_TLS_CERT.*certs setup/s,
  );
});

test('parseGatewayTlsConfig defaults the port to 7778 and honours an override', () => {
  const base = { FARMSLOT_GATEWAY_TLS_CERT: '/c.pem', FARMSLOT_GATEWAY_TLS_KEY: '/k.pem' };
  assert.equal(parseGatewayTlsConfig(base)?.port, DEFAULT_GATEWAY_TLS_PORT);
  assert.equal(parseGatewayTlsConfig({ ...base, FARMSLOT_GATEWAY_TLS_PORT: '9443' })?.port, 9443);
});

test('parseGatewayTlsConfig rejects a non-numeric or out-of-range port', () => {
  const base = { FARMSLOT_GATEWAY_TLS_CERT: '/c.pem', FARMSLOT_GATEWAY_TLS_KEY: '/k.pem' };
  assert.throws(
    () => parseGatewayTlsConfig({ ...base, FARMSLOT_GATEWAY_TLS_PORT: 'nope' }),
    /invalid/,
  );
  assert.throws(
    () => parseGatewayTlsConfig({ ...base, FARMSLOT_GATEWAY_TLS_PORT: '99999' }),
    /invalid/,
  );
});

test('loadGatewayTlsMaterial throws a teaching error when the cert path is unreadable', () => {
  assert.throws(
    () =>
      loadGatewayTlsMaterial({
        FARMSLOT_GATEWAY_TLS_CERT: '/does/not/exist.pem',
        FARMSLOT_GATEWAY_TLS_KEY: '/does/not/exist-key.pem',
      }),
    /cert not readable.*certs setup/s,
  );
});

test(
  'loadGatewayTlsMaterial reads cert + key and the gateway HTTPS server starts',
  { skip: !opensslAvailable },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fs-tls-'));
    try {
      const certPath = path.join(dir, 'cert.pem');
      const keyPath = path.join(dir, 'key.pem');
      const gen = spawnSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          keyPath,
          '-out',
          certPath,
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
        ],
        { stdio: 'ignore' },
      );
      assert.equal(gen.status, 0, 'openssl should generate a throwaway cert');

      const env = { FARMSLOT_GATEWAY_TLS_CERT: certPath, FARMSLOT_GATEWAY_TLS_KEY: keyPath };
      const material = loadGatewayTlsMaterial(env);
      assert.ok(material);
      assert.equal(material.port, DEFAULT_GATEWAY_TLS_PORT);
      assert.ok(material.cert.length > 0 && material.key.length > 0);

      // "server starts with cert": the material is valid TLS input for an https server.
      const server = createHttpsServer({ cert: material.cert, key: material.key }, (_req, res) => {
        res.writeHead(200);
        res.end('ok');
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      assert.ok((server.address() as { port: number }).port > 0);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
