import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPublicationBranchPushed, PUBLICATION_PUSH_TIMEOUT_MS } from './publication-push.js';

test('a push the pre-push hook refuses stops publication with its error', () => {
  // TAT-4006 run 7721a02b: MetaMask/core's pre-push `yarn lint` refused the push, and
  // `gh pr create` then failed with only "Head sha can't be blank".
  const refused = {
    exitCode: 1,
    stdout:
      'Unlisted dependencies (1)\n@metamask/snaps-sdk  packages/bridge-controller/dist/x.d.ts\n',
    stderr: "error: failed to push some refs to 'github.com:MetaMask/core.git'\n",
  };
  assert.throws(
    () => assertPublicationBranchPushed(refused, 'TAT-4006-feat', '7721a02b-run'),
    /git push of TAT-4006-feat failed \(exit 1\); the repository's pre-push hook, the remote or the push timeout stopped it \(hook output is in the gateway log\): error: failed to push some refs/,
  );
  // A push killed at its timeout fails the same way.
  assert.throws(
    () => assertPublicationBranchPushed({ exitCode: 124, stdout: '', stderr: '' }, 'b', 'r'),
    /failed \(exit 124\).*no error output/,
  );
  assertPublicationBranchPushed({ exitCode: 0, stdout: '', stderr: '' }, 'b', 'r');
  // The hook's `yarn lint` took 165-171 s on that slot; the push must outlast it.
  assert.ok(PUBLICATION_PUSH_TIMEOUT_MS >= 300_000);
});
