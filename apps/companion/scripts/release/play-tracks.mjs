#!/usr/bin/env node
import { createSign } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tracks = ['internal', 'alpha'];
const versions = (track) =>
  (track.releases || []).flatMap((release) => release.versionCodes || []).map(Number);

export function readBuild(file) {
  const builds = JSON.parse(readFileSync(file, 'utf8'));
  const build = Array.isArray(builds) && builds.length === 1 ? builds[0] : null;
  if (
    !build?.id ||
    build.status !== 'FINISHED' ||
    build.platform !== 'ANDROID' ||
    build.buildProfile !== 'production' ||
    build.distribution !== 'STORE' ||
    !/^[1-9]\d*$/.test(build.appBuildVersion || '')
  ) {
    throw new Error('Expected one finished production Android store build with a versionCode');
  }
  return { buildId: build.id, versionCode: Number(build.appBuildVersion) };
}

export async function createPlayClient(packageName, keyFile, fetchImpl = fetch) {
  let key;
  try {
    key = JSON.parse(readFileSync(keyFile, 'utf8'));
  } catch {
    throw new Error('Cannot read the configured Google Play service account');
  }
  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: tokenUrl, iat: now, exp: now + 3600 })}`;
  let assertion;
  try {
    assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url')}`;
  } catch {
    throw new Error('Cannot sign with the configured Google Play service account');
  }
  const auth = await fetchImpl(tokenUrl, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!auth.ok) throw new Error(`Google Play authentication failed (HTTP ${auth.status})`);
  const token = (await auth.json()).access_token;
  if (!token) throw new Error('Google Play authentication returned no access token');
  return async (method, suffix, body) => {
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/edits${suffix}`;
    const response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404 && method === 'GET' && /\/tracks\/(internal|alpha)$/.test(suffix))
      return { releases: [] };
    if (!response.ok)
      throw new Error(`Google Play ${method} request failed (HTTP ${response.status})`);
    return response.status === 204 ? undefined : response.json();
  };
}

export async function readTracks(client) {
  const edit = await client('POST', '', {});
  try {
    const result = {};
    for (const track of tracks) result[track] = await client('GET', `/${edit.id}/tracks/${track}`);
    return result;
  } finally {
    await client('DELETE', `/${edit.id}`);
  }
}

export async function snapshotTracks(client, build) {
  const before = await readTracks(client);
  for (const track of tracks) {
    if (build.versionCode <= Math.max(0, ...versions(before[track])))
      throw new Error(
        `VersionCode ${build.versionCode} is not newer than ${track}; refusing duplicate submission or rollback`,
      );
  }
  return { ...build, before };
}

export async function promoteAndVerify(client, snapshot) {
  const { versionCode } = snapshot;
  const edit = await client('POST', '', {});
  let committed = false;
  try {
    const internal = await client('GET', `/${edit.id}/tracks/internal`);
    const release = (internal.releases || []).find((entry) =>
      (entry.versionCodes || []).some((code) => Number(code) === versionCode),
    );
    if (!release)
      throw new Error(`Internal track does not contain submitted versionCode ${versionCode}`);
    const alpha = await client('GET', `/${edit.id}/tracks/alpha`);
    if (Math.max(0, ...versions(alpha)) >= versionCode)
      throw new Error('Alpha already has this or a newer release; refusing replacement');
    await client('PUT', `/${edit.id}/tracks/alpha`, {
      track: 'alpha',
      releases: [
        {
          status: release.status,
          versionCodes: [String(versionCode)],
          ...(release.name ? { name: release.name } : {}),
          ...(release.releaseNotes ? { releaseNotes: release.releaseNotes } : {}),
        },
      ],
    });
    await client('POST', `/${edit.id}:commit`, {});
    committed = true;
  } finally {
    if (!committed) await client('DELETE', `/${edit.id}`);
  }
  const after = await readTracks(client);
  for (const track of tracks) {
    if (
      !versions(after[track]).includes(versionCode) ||
      versionCode <= Math.max(0, ...versions(snapshot.before[track]))
    )
      throw new Error(`${track} did not move to versionCode ${versionCode}`);
  }
  return { versionCode, internal: versions(after.internal), alpha: versions(after.alpha) };
}

async function main() {
  const [action, buildFile, stateFile] = process.argv.slice(2);
  const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const profile = JSON.parse(readFileSync(path.join(app, 'eas.json'), 'utf8')).submit.production
    .android;
  const client = await createPlayClient(
    profile.applicationId,
    path.resolve(app, profile.serviceAccountKeyPath),
  );
  if (action === 'snapshot')
    writeFileSync(stateFile, JSON.stringify(await snapshotTracks(client, readBuild(buildFile))), {
      mode: 0o600,
    });
  else if (action === 'promote')
    console.log(
      JSON.stringify(await promoteAndVerify(client, JSON.parse(readFileSync(stateFile, 'utf8')))),
    );
  else throw new Error('Expected snapshot or promote action');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[release] ${error.message}`);
    process.exitCode = 1;
  });
}
