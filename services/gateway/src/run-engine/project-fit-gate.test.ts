import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectConfig, Run, RunTicketData } from '@farmslot/protocol';

import { detectProjectMismatchForConfigs } from './project-fit-gate.js';

function projectConfig(
  name: string,
  jiraProject: string,
  repo: string,
  apps: string[],
): ProjectConfig {
  return {
    name,
    repoUrl: `https://github.com/${repo}`,
    defaultBranch: 'main',
    apps,
    paths: { runtimeDir: '.agent', artifactDir: '.task' },
    defaults: {},
    hooks: {},
    health: {},
    ci: { repo, watchChecks: [], checkGroups: [], botPatterns: [] },
    jira: { project: jiraProject },
  };
}

function run(project: string, ticketOrPr = 'PROJ-3215'): Run {
  return {
    id: 'run-12345678',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'created',
    project,
    ticketOrPr,
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as Run;
}

const ticketData: RunTicketData = {
  source: 'jira',
  title: 'Mobile Perps banner is shown after closing position',
  description: 'The Example Mobile App wallet should update the Perps banner.',
  acceptanceCriteria: ['Mobile wallet perps state is validated.'],
  affectedArea: 'mobile wallet',
  stepsToReproduce: [],
  screenshots: [],
  labels: ['mobile'],
};

test('project fit gate accepts the current project when it is the only matching candidate', async () => {
  const result = await detectProjectMismatchForConfigs(run('example-mobile-farm'), ticketData, [
    projectConfig('example-mobile-farm', 'PROJ', 'example-org/example-mobile', ['mobile']),
  ]);

  assert.equal(result, null);
});

test('project fit gate rejects a wrong project when exactly one candidate matches the ticket prefix', async () => {
  const result = await detectProjectMismatchForConfigs(run('example-browser-farm'), ticketData, [
    projectConfig('example-mobile-farm', 'PROJ', 'example-org/example-mobile', ['mobile']),
  ]);

  assert.deepEqual(result, {
    suggestedProject: 'example-mobile-farm',
    normalizedTicket: 'PROJ-3215',
    confidence: 'high',
    rationale: 'Only one configured project matches this ticket prefix/repo.',
  });
});

test('project fit gate accepts medium confidence selector results for multi-candidate tickets', async () => {
  const result = await detectProjectMismatchForConfigs(
    run('example-browser-farm'),
    ticketData,
    [
      projectConfig('example-mobile-farm', 'PROJ', 'example-org/example-mobile', ['mobile']),
      projectConfig('example-browser-farm', 'PROJ', 'example-org/example-browser', ['extension']),
    ],
    async () => ({
      suggestedProject: 'example-mobile-farm',
      confidence: 'medium',
      rationale: 'Ticket title and affected area mention Mobile.',
    }),
  );

  assert.deepEqual(result, {
    suggestedProject: 'example-mobile-farm',
    normalizedTicket: 'PROJ-3215',
    confidence: 'medium',
    rationale: 'Ticket title and affected area mention Mobile.',
  });
});

test('project fit gate ignores low confidence selector results', async () => {
  const result = await detectProjectMismatchForConfigs(
    run('example-browser-farm'),
    ticketData,
    [
      projectConfig('example-mobile-farm', 'PROJ', 'example-org/example-mobile', ['mobile']),
      projectConfig('example-browser-farm', 'PROJ', 'example-org/example-browser', ['extension']),
    ],
    async () => ({
      suggestedProject: 'example-mobile-farm',
      confidence: 'low',
      rationale: 'Ticket metadata is ambiguous.',
    }),
  );

  assert.equal(result, null);
});

test('project fit gate falls back to deterministic metadata when the selector is unavailable', async (t) => {
  const originalWarn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = originalWarn;
  });

  const result = await detectProjectMismatchForConfigs(
    run('example-browser-farm'),
    ticketData,
    [
      projectConfig('example-mobile-farm', 'PROJ', 'example-org/example-mobile', ['mobile']),
      projectConfig('example-browser-farm', 'PROJ', 'example-org/example-browser', ['extension']),
    ],
    async () => {
      throw new Error('classifier offline');
    },
  );

  assert.equal(result?.suggestedProject, 'example-mobile-farm');
  assert.equal(result?.normalizedTicket, 'PROJ-3215');
  assert.equal(result?.confidence, 'high');
});

test('project fit gate matches GitHub issue refs by configured repo', async () => {
  const result = await detectProjectMismatchForConfigs(
    run('example-browser-farm', 'example-org/example-mobile#123'),
    null,
    [
      projectConfig('example-mobile-farm', 'PROJ', 'example-org/example-mobile', ['mobile']),
      projectConfig('example-browser-farm', 'PROJ', 'example-org/example-browser', ['extension']),
    ],
  );

  assert.deepEqual(result, {
    suggestedProject: 'example-mobile-farm',
    normalizedTicket: 'example-org/example-mobile#123',
    confidence: 'high',
    rationale: 'Only one configured project matches this ticket prefix/repo.',
  });
});
