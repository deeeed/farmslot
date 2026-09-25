import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { writeAtomicJSON } from '../core/atomic-json.js';

import { assertNoCredentials } from './record-validation.js';

const MAX_BYTES = 20 * 1024 * 1024;
// Bounded assessment packets may reach 64 KiB; include the audit envelope on disk.
const INPUT_MAX_BYTES = 72 * 1024;
const ID = /^[a-f0-9]{64}$/;
let tail: Promise<unknown> = Promise.resolve();
function directory(owner: string, kind: 'reports' | 'evaluations' | 'inputs') {
  return path.join(
    farmslotHome(),
    `assessment-${kind}`,
    createHash('sha256').update(owner).digest('hex'),
  );
}
async function prune(dir: string) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json') && ID.test(n.slice(0, -5)));
  let retained = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    if ((await stat(file)).mtimeMs < Date.now() - 30 * 86400_000) await rm(file);
    else retained++;
  }
  return retained;
}
export function saveAssessmentArtifact(
  owner: string,
  kind: 'reports' | 'evaluations' | 'inputs',
  id: string,
  value: unknown,
): Promise<void> {
  const operation = tail.then(async () => {
    if (!ID.test(id)) throw new Error('Invalid artifact ID');
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > (kind === 'inputs' ? INPUT_MAX_BYTES : MAX_BYTES))
      throw new Error('Assessment artifact exceeds limit');
    assertNoCredentials(bytes);
    const dir = directory(owner, kind);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await prune(dir)) >= (kind === 'inputs' ? 5000 : 100))
      throw new Error(
        'Assessment artifact limit reached; export retained artifacts before removing them locally',
      );
    await writeAtomicJSON(path.join(dir, `${id}.json`), value);
  });
  // The caller receives the failure; subsequent independent writes can still proceed.
  tail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}
export async function readAssessmentArtifact(
  owner: string,
  kind: 'reports' | 'evaluations' | 'inputs',
  id: string,
): Promise<unknown> {
  if (!ID.test(id)) throw new Error('Invalid artifact ID');
  const file = path.join(directory(owner, kind), `${id}.json`);
  const metadata = await stat(file);
  if (metadata.size > (kind === 'inputs' ? INPUT_MAX_BYTES : MAX_BYTES))
    throw new Error('Assessment artifact exceeds limit');
  if (metadata.mtimeMs < Date.now() - 30 * 86400_000)
    throw new Error('Assessment artifact expired');
  const bytes = await readFile(file, 'utf8');
  assertNoCredentials(bytes);
  return JSON.parse(bytes);
}
