import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { RUN_ARTIFACT_MEDIA_GRANT_PARAM, type RunArtifactMediaGrant } from '@farmslot/protocol';

const LIFETIME_MS = 15 * 60 * 1000;

export function createRunArtifactMediaGrants(now = Date.now) {
  const key = randomBytes(32);
  const sign = (url: URL, claims: string) =>
    createHmac('sha256', key).update(`${url.pathname}?${url.searchParams}\n${claims}`).digest();

  return {
    issue(source: URL, sha256: string): RunArtifactMediaGrant {
      const url = new URL(source);
      url.searchParams.delete('token');
      url.searchParams.delete('password');
      url.searchParams.delete(RUN_ARTIFACT_MEDIA_GRANT_PARAM);
      const claims = `${now() + LIFETIME_MS}.${sha256}`;
      const mac = sign(url, claims).toString('base64url');
      url.searchParams.set(RUN_ARTIFACT_MEDIA_GRANT_PARAM, `${claims}.${mac}`);
      return { url: `${url.pathname}${url.search}` };
    },

    verify(source: URL): string | undefined {
      const url = new URL(source);
      const grants = url.searchParams.getAll(RUN_ARTIFACT_MEDIA_GRANT_PARAM);
      if (grants.length !== 1) return undefined;
      const match = /^(\d{1,16})\.([a-f0-9]{64})\.([\w-]{43})$/u.exec(grants[0]!);
      if (!match) return undefined;
      const [, expires, sha256, encodedMac] = match;
      if (Number(expires) <= now()) return undefined;
      url.searchParams.delete(RUN_ARTIFACT_MEDIA_GRANT_PARAM);
      const mac = Buffer.from(encodedMac!, 'base64url');
      if (mac.toString('base64url') !== encodedMac) return undefined;
      return timingSafeEqual(sign(url, `${expires}.${sha256}`), mac) ? sha256 : undefined;
    },
  };
}

export const runArtifactMediaGrants = createRunArtifactMediaGrants();
