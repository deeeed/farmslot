import type { Run } from '@farmslot/protocol';

import { ghRequest } from '../integrations/github-client.js';

import { reviewPRIdentity } from './session-mode.js';

export async function readPRCompletionHead(run: Run): Promise<string> {
  const pr = reviewPRIdentity(run, { requirePRContext: true });
  if (!pr) throw new Error('PR completion has no bound pull request');
  const result = await ghRequest(
    [
      'pr',
      'view',
      String(pr.prNumber),
      '--repo',
      pr.repository,
      '--json',
      'headRefOid',
      '--jq',
      '.headRefOid',
    ],
    { force: true },
  );
  const head = result.stdout.trim();
  if (!/^[a-f0-9]{40}$/i.test(head)) throw new Error('PR completion pushed head is unavailable');
  return head;
}
