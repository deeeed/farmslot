import assert from 'node:assert/strict';
import test from 'node:test';

import { ignoreFixtureMatches, skillsFixtureMatches } from './fixture-content.js';

test('local excludes keep seed rules with installer additions and reject lost or negated rules', () => {
  const seed = '# local fixture paths\n.agents/\ntemp/\n';
  assert.equal(ignoreFixtureMatches(seed, seed + '# managed skills\n.skills-cache/\n'), true);
  assert.equal(ignoreFixtureMatches(seed, '.agents/\n.skills-cache/\n'), false);
  assert.equal(ignoreFixtureMatches(seed, seed + '!.agents/\n'), false);
});

const seed =
  'CONSENSYS_SKILLS_DIR=../consensys-skills\nSKILLS_DOMAINS=perps,agentic\nSKILLS_MATURITY=experimental\n';
const vars = {
  remoteRepo: '/workspace/mobile',
  machineEnv: { METAMASK_SKILLS_DIR: '/workspace/metamask-skills' },
};
const installed =
  seed.replace('../consensys-skills', '/workspace/consensys-skills') +
  'METAMASK_SKILLS_DIR=/workspace/metamask-skills\nMETAMASK_SKILLS_TARGET_REPO=metamask-mobile\n';

test('skills readiness accepts the settings written by normal source/target reconciliation', () => {
  const matches = (text: string) =>
    skillsFixtureMatches(seed, text, vars, 'git@github.com:MetaMask/metamask-mobile.git');
  assert.equal(matches(seed), true);
  assert.equal(matches(installed), true);
  assert.equal(
    matches(installed.replace('SKILLS_MATURITY=experimental', 'SKILLS_MATURITY="experimental"')),
    true,
  );
});

test('skills readiness still rejects missing seeds, wrong sources, selection, target and unknown settings', () => {
  const matches = (text: string) =>
    skillsFixtureMatches(seed, text, vars, 'git@github.com:MetaMask/metamask-mobile.git');
  for (const wrong of [
    installed.replace('SKILLS_DOMAINS=perps,agentic\n', ''),
    installed.replace('perps,agentic', 'perps'),
    installed.replace('/workspace/consensys-skills', '/workspace/old-skills'),
    installed.replace('/workspace/metamask-skills', '/workspace/old-public-skills'),
    installed.replace(
      'METAMASK_SKILLS_TARGET_REPO=metamask-mobile',
      'METAMASK_SKILLS_TARGET_REPO=core',
    ),
    installed + 'SKILLS_AUTO_UPDATE=0\n',
  ])
    assert.equal(matches(wrong), false, wrong);
});
