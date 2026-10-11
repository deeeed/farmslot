// Setup-time storage for owned proof simulators. Stop the app before writing.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function seedIOSGatewayProfile({ simulator, bundleId, profile, seenVersion }) {
  const terminated = spawnSync('xcrun', ['simctl', 'terminate', simulator, bundleId], {
    encoding: 'utf8',
  });
  // simctl reports "found nothing to terminate" when the app is not running, which is the goal.
  if (terminated.status !== 0 && !/found nothing to terminate/i.test(terminated.stderr)) {
    throw new Error(`simctl terminate failed: ${terminated.stderr.trim()}`);
  }
  const data = execFileSync('xcrun', ['simctl', 'get_app_container', simulator, bundleId, 'data'], {
    encoding: 'utf8',
  }).trim();
  const storage = path.join(
    data,
    'Library/Application Support',
    bundleId,
    'RCTAsyncLocalStorage_V1',
  );
  const manifestPath = path.join(storage, 'manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : {};
  const values = {
    '@farmslot:gatewayProfiles': JSON.stringify([profile]),
    '@farmslot:activeGatewayProfileId': profile.id,
    '@farmslot:gatewayUrl': profile.url,
  };
  if (seenVersion) values['@farmslot:whats-new-seen-version'] = seenVersion;
  for (const [key, value] of Object.entries(values)) {
    // A value an earlier run stored out of line would shadow nothing once the
    // manifest holds it inline, but it would be left behind; remove it.
    fs.rmSync(path.join(storage, createHash('md5').update(key).digest('hex')), { force: true });
    manifest[key] = value;
  }
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
}
