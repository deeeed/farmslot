import { writeFile } from 'node:fs/promises';

import type { Run } from '@farmslot/protocol';

import { defaultAssessmentProviders } from '../../services/gateway/src/assessment/default-providers.js';
import { getAssessmentConfig } from '../../services/gateway/src/assessment/config.js';
import {
  digest,
  prepareAdmittedTriage,
  textDigest,
} from '../../services/gateway/src/assessment/failure-triage/packet.js';
import type { TriagePacket } from '../../services/gateway/src/assessment/failure-triage/types.js';
import { assertNoCredentials } from '../../services/gateway/src/assessment/record-validation.js';
import { readTriageFile } from '../../services/gateway/src/intelligence/triage/policy.js';
import {
  registeredFailureLogs,
  triageFailureHash,
} from '../../services/gateway/src/intelligence/triage/snapshot.js';

const options: Record<string, string> = {};
const sources: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === '--list') {
    options.list = 'true';
    continue;
  }
  if (!['--run-json', '--step', '--source', '--origin', '--reference', '--out'].includes(key))
    throw new Error('Unknown draft option');
  const value = process.argv[++i];
  if (!value || value.startsWith('--')) throw new Error('Missing draft option value');
  if (key === '--source') sources.push(value);
  else options[key.slice(2)] = value;
}
if (!options['run-json']) throw new Error('--run-json is required');
// Local operator input only. The gateway later rechecks the canonical run and hashes.
const parsed = JSON.parse(await readTriageFile(options['run-json'], 2 * 1024 * 1024));
const run: Run = parsed.run ?? parsed;
if (
  !run ||
  typeof run.id !== 'string' ||
  !/^[a-f0-9-]{36}$/.test(run.id) ||
  run.flowType !== 'dev' ||
  !Array.isArray(run.steps)
)
  throw new Error('Provide a failed development run export');
const step = run.steps
  .filter((s) => s.status === 'failed' && (!options.step || s.name === options.step))
  .at(-1);
if (!step) throw new Error('Select a recorded failed step');
const registry = await registeredFailureLogs(step);
const failureHash = triageFailureHash(run, step);
if (options.list) {
  assertNoCredentials(
    JSON.stringify({
      runId: run.id,
      project: run.project,
      step: step.name,
      sources: registry.map((e) => ({ id: e.id, label: e.label })),
    }),
  );
  console.log(
    JSON.stringify(
      {
        runId: run.id,
        project: run.project,
        step: step.name,
        failureHash,
        sources: registry
          .filter((e) => e.exists)
          .map((e) => ({ id: e.id, label: e.label, bytes: e.size })),
      },
      null,
      2,
    ),
  );
} else {
  if (
    !sources.length ||
    sources.length > 4 ||
    new Set(sources).size !== sources.length ||
    !['public', 'synthetic'].includes(options.origin) ||
    !options.reference ||
    !options.out
  )
    throw new Error(
      'Select 1..4 distinct source IDs, --origin public|synthetic, --reference and a new --out file',
    );
  if (options.origin === 'public' && !options.reference.startsWith('https://'))
    throw new Error('Public origin requires an HTTPS reference');
  const evidence = await Promise.all(
    sources.map(async (id, index) => {
      const entry = registry.find((e) => e.id === id && e.exists);
      if (!entry) throw new Error('Source ID is not registered');
      const text = await readTriageFile(entry.path, 12000);
      return { id: `e${index + 1}`, text, digest: textDigest(text), required: true };
    }),
  );
  const packet: TriagePacket = {
    version: 1,
    caseId: run.id,
    failure: { runId: run.id, status: 'failed', step: step.name },
    evidence,
  };
  const config = getAssessmentConfig();
  const provider = config.provider && defaultAssessmentProviders().get(config.provider);
  const prepared = prepareAdmittedTriage(
    packet,
    digest(packet),
    provider ? process.env[provider.credentialEnv]?.trim() : '',
    Math.min(12000, config.maxStateBytes),
  );
  const draft = {
    approval: {
      runId: run.id,
      project: run.project,
      step: step.name,
      failureHash,
      sources: sources.map((logId, i) => ({ logId, digest: evidence[i].digest })),
      origin: { kind: options.origin, reference: options.reference },
    },
    sanitizedPreview: prepared.packet,
  };
  assertNoCredentials(JSON.stringify(draft));
  await writeFile(options.out, JSON.stringify(draft, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      out: options.out,
      sources: sources.length,
      providerCalls: 0,
      policyChanged: false,
    }),
  );
}
