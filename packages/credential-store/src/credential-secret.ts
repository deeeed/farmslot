import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import type { StoredSecret } from './credential-store.js';

export const SCRYPT_PARAMETERS = {
  N: 32_768,
  r: 8,
  p: 1,
  dkLen: 32,
  maxmem: 67_108_864,
} as const;

export function generateCredentialSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function generateCredentialId(): string {
  return randomBytes(16).toString('hex');
}

export function formatCredentialWire(credentialId: string, secret: string): string {
  return `fs_${credentialId}_${secret}`;
}

export function parseCredentialWire(
  presented: string,
): { credentialId: string; secret: string } | null {
  if (!presented.startsWith('fs_')) return null;
  const separator = presented.indexOf('_', 3);
  if (separator <= 3 || separator === presented.length - 1) return null;
  const credentialId = presented.slice(3, separator);
  if (!/^[a-f0-9]{32}$/u.test(credentialId)) return null;
  return { credentialId, secret: presented.slice(separator + 1) };
}

export function hashSecret(secret: string): StoredSecret {
  const salt = randomBytes(16);
  const hash = derive(secret, salt);
  return {
    scheme: 'scrypt-v1',
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
  };
}

export function verifySecret(presented: string, stored: StoredSecret): boolean {
  if (stored.scheme !== 'scrypt-v1') return false;
  const salt = decodeBase64(stored.salt);
  const expected = decodeBase64(stored.hash);
  if (!salt || salt.length !== 16 || !expected || expected.length !== SCRYPT_PARAMETERS.dkLen) {
    return false;
  }
  const actual = derive(presented, salt);
  return timingSafeEqual(actual, expected);
}

export function safeEqualSecret(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    const padded = Buffer.alloc(expectedBuffer.length);
    actualBuffer.copy(padded, 0, 0, Math.min(actualBuffer.length, expectedBuffer.length));
    timingSafeEqual(padded, expectedBuffer);
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function verificationCacheKey(presented: string): string {
  return createHash('sha256').update(presented).digest('base64');
}

function derive(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, SCRYPT_PARAMETERS.dkLen, {
    N: SCRYPT_PARAMETERS.N,
    r: SCRYPT_PARAMETERS.r,
    p: SCRYPT_PARAMETERS.p,
    maxmem: SCRYPT_PARAMETERS.maxmem,
  });
}

function decodeBase64(value: string): Buffer | null {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}
