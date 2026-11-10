import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readSupportFiles,
  RUNNER_OBSERVABILITY_SOURCE_FILES,
} from '../../../../scripts/lib/runner-observability-bundle.mjs';

import type { NodeSupportFile } from './files.js';

export async function runnerObservabilityFixtureFiles(): Promise<NodeSupportFile[]> {
  const files = await readSupportFiles(
    fileURLToPath(new URL('../../../../', import.meta.url)),
    RUNNER_OBSERVABILITY_SOURCE_FILES,
  );
  return files.map((file) => {
    const bytes = Buffer.from(file.contentBase64, 'base64');
    return {
      ...file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
  });
}

export async function seedRunnerObservabilityFixture(root: string): Promise<void> {
  await Promise.all(
    (await runnerObservabilityFixtureFiles()).map(async (file) => {
      const destination = path.join(root, file.relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(file.contentBase64, 'base64'));
      await chmod(destination, file.mode);
    }),
  );
}

export function isSupportHomeCommand(command: string): boolean {
  return command.startsWith("printf '%s");
}

export function fakeSupportHomeResult(command: string) {
  if (!isSupportHomeCommand(command)) return undefined;
  const hash = /support\/([a-f0-9]{64})/.exec(command)?.[1];
  if (!hash) throw new Error('Support-home probe has no bundle hash');
  return { exitCode: 0, stdout: `/tmp/node-home/farmslot-node/support/${hash}\n`, stderr: '' };
}
