import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildBlindGitCommand } from '../evals/blind-git.js';

import { CREDENTIAL_SHAPES, isSecretValue } from './credential-redaction.js';

// Fake values only: provider shapes, near misses, references, paths, URLs and prose.
const FIXTURES = [
  'sk-ant-FAKEfixture0123456789',
  'sk-FAKEfixture01234567',
  'sk-short',
  'ghp_FAKEfixture0123456789abcd',
  'github_pat_FAKE_fixture_0123456789',
  'ATATTFAKEfixture0123456789=',
  'xoxb-FAKE-fixture-01',
  'AKIAFAKEFIXTURE01234',
  'AKIAFAKEFIXTURE012345',
  `npm_${'A1'.repeat(18)}`,
  `AIza${'b2'.repeat(17)}x`,
  'hf_FAKEfixture0123456789abcdefghij',
  'xai-FAKEfixture0123456789',
  'fw_FAKEfixture0123456789',
  'Fake0Secret1Key2Abc',
  'fake0secret1key2abc',
  'FAKE0SECRET1KEY2ABC',
  'fakesecretkeyvalueonly',
  'Fake0Secret1',
  'GLM-5.3-Flash-s1234',
  'local',
  '$LITELLM_API_KEY',
  '${FARMSLOT_PI_ROUTER_KEY}',
  'org/Repo-Name-2026',
  '~/.pi/agent/Models2026.json',
  './Fixture/Path0123456789',
  'http://192.0.2.1:8890/v1',
  'https://Example0Host1.invalid/v1',
  'Fake0Secret1 With2Space',
  'max_tokens',
  'enable_thinking',
  '',
];

test('Python and TypeScript classify credential shapes identically from one shared file', () => {
  const python = spawnSync(
    'python3',
    [
      '-c',
      `import json, runpy, sys
blind = runpy.run_path(sys.argv[1], run_name='fixture')
print(json.dumps([blind['credential_shaped'](value) for value in json.loads(sys.argv[2])]))`,
      fileURLToPath(new URL('../evals/blind-git.py', import.meta.url)),
      JSON.stringify(FIXTURES),
    ],
    { encoding: 'utf8', timeout: 4500 },
  );
  assert.equal(python.status, 0, python.stderr);
  const typescript = FIXTURES.map((value) => isSecretValue(value));
  assert.deepEqual(JSON.parse(python.stdout), typescript);
  // The fixtures exercise both outcomes.
  assert.ok(typescript.includes(true) && typescript.includes(false));
});

test('the node receives the gateway credential shapes with every blind Git request', () => {
  const command = buildBlindGitCommand('boundary', {
    slotId: 'slot',
    slotEpoch: 1,
    repo: '/blind-shapes-fixture/repo',
    capsule: '/blind-shapes-fixture/capsule',
    runId: 'run',
    branch: 'blind',
    baseSha: 'a'.repeat(40),
    referenceCommits: [],
  });
  const request = command.match(/python3 - '([^']*)'/u)?.[1];
  assert.ok(request, command.slice(0, 200));
  assert.deepEqual(JSON.parse(request).credentialShapes, CREDENTIAL_SHAPES);
});
