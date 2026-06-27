import fs from 'node:fs';
import path from 'node:path';

import { EVIDENCE_DIR, hostSlug } from './common.mjs';

export function evidencePath(scenario, runner, outDir = EVIDENCE_DIR) {
  return path.join(outDir, `runner-validate-${hostSlug()}-${runner}-${scenario}.json`);
}

export function writeEvidence(report, scenario, runner, outDir = EVIDENCE_DIR) {
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = evidencePath(scenario, runner, outDir);
  const body = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    host: hostSlug(),
    scenario,
    ...report,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(body, null, 2)}\n`);
  return outPath;
}