// Covers the current evaluator because it explicitly injects boundedAssessmentFetch,
// which resolves global fetch after this preload. This is not a general network sandbox;
// future transports need equivalent guards.
// Test-process preload: any unexpected provider fetch is counted and blocked.
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.env.TRIAGE_NETWORK_GUARD;
if (!file) throw new Error('Test network guard requires its counter file');
globalThis.fetch = async () => {
  writeFileSync(file, String(Number(readFileSync(file, 'utf8')) + 1), { mode: 0o600 });
  throw new Error('Provider transport blocked by evaluation proof');
};
