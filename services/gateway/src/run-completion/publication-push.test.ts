import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPublicationBranchPushed, PUBLICATION_PUSH_TIMEOUT_MS } from './publication-push.js';

test('a push the pre-push hook refuses stops publication with its error', () => {
  const refused = {
    exitCode: 1,
    stdout: 'Unlisted dependencies (1)\nfixture-dependency  packages/fixture/dist/x.d.ts\n',
    stderr: "error: failed to push some refs to 'fixture.invalid:example/repo.git'\n",
  };
  assert.throws(
    () => assertPublicationBranchPushed(refused, 'fix/fixture', 'fixture-run'),
    /git push of fix\/fixture failed \(exit 1\); the repository's pre-push hook, the remote or the push timeout stopped it \(hook output is in the gateway log\): error: failed to push some refs/,
  );
  assert.throws(
    () => assertPublicationBranchPushed({ exitCode: 124, stdout: '', stderr: '' }, 'b', 'r'),
    /git push timed out after 900000 ms.*pre-push hook budget/,
  );
  assertPublicationBranchPushed({ exitCode: 0, stdout: '', stderr: '' }, 'b', 'r');
  assert.equal(PUBLICATION_PUSH_TIMEOUT_MS, 900_000);
});
