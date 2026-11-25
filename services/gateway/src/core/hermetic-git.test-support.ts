// Import first, for its side effect: git in this test file, both its fixtures and the code under
// test, reads no global or system config and no farm git identity, as on a CI runner. A developer
// machine whose global config signs commits (commit.gpgsign) otherwise makes slot prepare refuse
// the fixture slot ("Commit signing is not ready") before it reaches the step under test, and a
// farm identity in ~/.farmslot would be copied into the fixture slot and sign its commits.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
// loadGitIdentity reads <FARMSLOT_HOME>/git-identity.json: always a private home, even when the
// shell running the suite exports the farm's (a Farmslot-started machine shell does).
const home = mkdtempSync(path.join(tmpdir(), 'farmslot-git-home-'));
process.env.FARMSLOT_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));
