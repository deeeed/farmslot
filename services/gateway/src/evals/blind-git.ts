import { readFileSync } from 'node:fs';

import { shSingleQuote } from '../../../../scripts/lib/shell-quote.mjs';

export interface BlindGitSpec {
  slotId: string;
  slotEpoch: number;
  repo: string;
  capsule: string;
  runId: string;
  branch: string;
  baseSha: string;
  referenceCommits: string[];
}

const script = readFileSync(new URL('./blind-git.py', import.meta.url), 'utf8');

export function buildBlindGitCommand(
  action: 'plan' | 'isolate' | 'verify' | 'restore',
  spec: BlindGitSpec,
): string {
  return `python3 - ${shSingleQuote(JSON.stringify({ ...spec, action }))} <<'FARMSLOT_BLIND_GIT_PY'\n${script}\nFARMSLOT_BLIND_GIT_PY`;
}
