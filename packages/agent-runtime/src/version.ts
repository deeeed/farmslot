import { readFileSync } from 'node:fs';

import { isRecord } from '@farmslot/protocol';

const manifest: unknown = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
if (
  !isRecord(manifest) ||
  typeof manifest.version !== 'string' ||
  typeof manifest.minimumRuntimeVersion !== 'string'
)
  throw new Error('The installed agent-runtime package has no valid runtime version declaration.');

export const RUNTIME_VERSION = manifest.version;
export const MINIMUM_RUNTIME_VERSION = manifest.minimumRuntimeVersion;
