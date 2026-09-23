import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RunTicketData } from '@farmslot/protocol';

import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import {
  executeGradeStep,
  mergeInitialContextIntoTicketData,
  prepareProfileDecisionLabel,
} from './task-steps.js';

test('prepare profile decision label resolves the configured implicit profile', () => {
  const run = { prepareProfile: undefined } as Pick<Run, 'prepareProfile'>;
  assert.equal(
    prepareProfileDecisionLabel(run, {
      prepare: {
        core: { phases: ['git'] },
        default: 'sandbox',
        profiles: { sandbox: { phases: ['git', 'preflight'] } },
      },
    }),
    'core',
  );
  assert.equal(prepareProfileDecisionLabel({ prepareProfile: 'sandbox' }), 'sandbox');
});

const profileFitSlotId = 'profile-fit-bound-cli-slot';

const compatibleSlot = {
  slot: profileFitSlotId,
  platform: 'cli',
  resources: { 'ios-sim': { device: 'simulator' } },
};

const cliSlot = { slot: profileFitSlotId, platform: 'cli', resources: {} };

const profileFitTicket: RunTicketData = {
  source: 'manual',
  title: 'Companion gateway proof',
  description: 'Update apps/companion pairing UI and gateway RPC.',
  acceptanceCriteria: ['Companion updates'],
  affectedArea: 'companion',
  stepsToReproduce: [],
  screenshots: [],
  labels: ['companion'],
};

test('GRADE does not offer a companion profile on a bound CLI slot without simulator resources', async (t) => {
  const run = createRun({
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    ticketOrPr: 'PROFILE-FIT-INCOMPATIBLE-BOUND-SLOT',
    slotId: profileFitSlotId,
    ticketData: profileFitTicket,
    mode: 'interactive',
    engineState: {
      evalExperiment: { experimentId: 'profile-fit-incompatible' },
    } as Run['engineState'],
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  let description = '';
  const result = await executeGradeStep(run.id, run, new Map(), {
    createEngineDecision: async (_runId, reason, text, choices) => {
      assert.equal(reason, 'prepare_profile_mismatch');
      description = text;
      assert.deepEqual(
        choices.map((choice) => choice.id),
        ['continue', 'abort'],
      );
      return 'continue';
    },
    getFleetStatus: async () => ({ slots: [cliSlot] }) as never,
    loadProjectVarsOrNull: async () =>
      ({
        projectJson: {
          prepare: {
            default: 'sandbox',
            profiles: { sandbox: { phases: ['git'] }, 'sandbox-companion': { phases: ['git'] } },
          },
        },
      }) as never,
  });
  assert.match(description, /Slot profile-fit-bound-cli-slot cannot use the suggestion/);
  assert.match(description, /ios-sim, android-emu, android-device/);
  assert.equal(getRun(run.id)?.prepareProfile, undefined);
  assert.equal(getRun(run.id)?.engineState?.validationPlan, undefined);
  assert.ok(result.outputs?.profileFitOverride);
});

test('GRADE leaves the configured core baseline unblocked', async (t) => {
  const run = createRun({
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    ticketOrPr: 'PROFILE-FIT-CORE',
    slotId: profileFitSlotId,
    ticketData: profileFitTicket,
    mode: 'interactive',
    engineState: {
      evalExperiment: { experimentId: 'profile-fit-core-test' },
    } as Run['engineState'],
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });

  let decisionCalls = 0;
  await executeGradeStep(run.id, run, new Map(), {
    createEngineDecision: async () => {
      decisionCalls += 1;
      return 'continue';
    },
    getFleetStatus: async () => ({ slots: [compatibleSlot] }) as never,
    loadProjectVarsOrNull: async () =>
      ({
        projectJson: {
          prepare: {
            core: { phases: ['git'] },
            profiles: { sandbox: { phases: ['git'] }, 'sandbox-companion': { phases: ['git'] } },
          },
        },
      }) as never,
  });
  assert.equal(decisionCalls, 0);
});

test('GRADE advises on a core companion ticket when the bound slot cannot host a simulator', async (t) => {
  const run = createRun({
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    ticketOrPr: 'PROFILE-FIT-CORE-NO-SIM',
    slotId: profileFitSlotId,
    ticketData: profileFitTicket,
    mode: 'interactive',
    engineState: {
      evalExperiment: { experimentId: 'profile-fit-core-no-sim' },
    } as Run['engineState'],
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  const result = await executeGradeStep(run.id, run, new Map(), {
    createEngineDecision: async (_id, reason, text, choices) => {
      assert.equal(reason, 'prepare_profile_mismatch');
      assert.match(text, /Start a new run on a compatible slot/);
      assert.deepEqual(
        choices.map((choice) => choice.id),
        ['continue', 'abort'],
      );
      return 'continue';
    },
    getFleetStatus: async () => ({ slots: [cliSlot] }) as never,
    loadProjectVarsOrNull: async () =>
      ({
        projectJson: {
          prepare: {
            core: { phases: ['git'] },
            profiles: {
              sandbox: { phases: ['git'] },
              'sandbox-companion': { phases: ['git'] },
            },
          },
        },
      }) as never,
  });
  assert.ok(result.outputs?.profileFitOverride);
  assert.equal(getRun(run.id)?.prepareProfile, undefined);
  assert.equal(getRun(run.id)?.engineState?.validationPlan, undefined);
});

test('GRADE keeps the validation plan when continuing with a compatible bound slot', async (t) => {
  const run = createRun({
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    ticketOrPr: 'PROFILE-FIT-CONTINUE-PLAN',
    slotId: profileFitSlotId,
    ticketData: profileFitTicket,
    mode: 'interactive',
    engineState: {
      evalExperiment: { experimentId: 'profile-fit-continue-plan' },
    } as Run['engineState'],
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  const result = await executeGradeStep(run.id, run, new Map(), {
    createEngineDecision: async (_id, _reason, _text, choices) => {
      assert.deepEqual(
        choices.map((choice) => choice.id),
        ['continue', 'abort'],
      );
      return 'continue';
    },
    getFleetStatus: async () => ({ slots: [compatibleSlot] }) as never,
    loadProjectVarsOrNull: async () =>
      ({
        projectJson: {
          prepare: {
            default: 'sandbox',
            profiles: {
              sandbox: { phases: ['git'] },
              'sandbox-companion': { phases: ['git'] },
            },
          },
        },
      }) as never,
  });
  assert.equal(getRun(run.id)?.prepareProfile, undefined);
  assert.ok(getRun(run.id)?.engineState?.validationPlan?.length);
  assert.ok(result.outputs?.profileFitOverride);
});

test('GRADE does not offer profile advice before a slot is bound', async (t) => {
  const run = createRun({
    project: 'farmslot-farm',
    flowType: 'fix-bug',
    ticketOrPr: 'PROFILE-FIT-UNBOUND',
    ticketData: profileFitTicket,
    mode: 'interactive',
    engineState: { evalExperiment: { experimentId: 'profile-fit-unbound' } } as Run['engineState'],
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  const result = await executeGradeStep(run.id, run, new Map(), {
    createEngineDecision: async () => {
      throw new Error('Unbound GRADE must not ask for profile advice');
    },
    getFleetStatus: async () => {
      throw new Error('Unbound GRADE must not query fleet');
    },
    loadProjectVarsOrNull: async () =>
      ({
        projectJson: {
          prepare: {
            default: 'sandbox',
            profiles: {
              sandbox: { phases: ['git'] },
              'sandbox-companion': { phases: ['git'] },
            },
          },
        },
      }) as never,
  });
  assert.equal(result.outputs?.profileFitOverride, undefined);
  assert.equal(getRun(run.id)?.prepareProfile, undefined);
});

const trackerTicket: RunTicketData = {
  source: 'jira',
  title: 'Tracker title',
  description: 'Live tracker description',
  acceptanceCriteria: ['Tracker AC'],
  affectedArea: '',
  stepsToReproduce: [],
  screenshots: [],
  labels: [],
  jiraKey: 'TAT-78001',
};

test('tracker ticket data keeps live fields and gains structured backlog spec context', () => {
  const merged = mergeInitialContextIntoTicketData(
    trackerTicket,
    [
      'Backlog markdown spec (.backlog/specs/tat-78001.md):',
      '',
      '## Acceptance Criteria',
      '',
      '- Spec AC',
      '',
      '## Backlog Notes',
      '',
      'Operator note',
      '',
      '## Backlog Source',
      '',
      'jira TAT-78001',
    ].join('\n'),
  );

  assert.equal(merged.jiraKey, 'TAT-78001');
  assert.match(merged.description, /Live tracker description/);
  assert.match(merged.description, /Backlog markdown spec/);
  // ACs land in acceptanceCriteria only — the appended context must not carry
  // the spec's AC section into the description a second time.
  assert.doesNotMatch(merged.description, /## Acceptance Criteria/);
  assert.match(merged.description, /Operator note/);
  assert.deepEqual(merged.acceptanceCriteria, ['Tracker AC', 'Spec AC']);
});

test('ticket context merge is idempotent across grade retries', () => {
  const context = '## Acceptance Criteria\n\n- Spec AC\n\n## Backlog Notes\n\nOperator note';
  const once = mergeInitialContextIntoTicketData(trackerTicket, context);
  const twice = mergeInitialContextIntoTicketData(once, context);

  assert.strictEqual(twice, once);
  assert.equal(twice.description.match(/Additional Farmslot context/g)?.length, 1);
  assert.deepEqual(twice.acceptanceCriteria, ['Tracker AC', 'Spec AC']);
});

test('a context that is only an AC section adds criteria without touching the description', () => {
  const merged = mergeInitialContextIntoTicketData(
    trackerTicket,
    '## Acceptance Criteria\n\n- Spec AC',
  );
  assert.equal(merged.description, trackerTicket.description);
  assert.deepEqual(merged.acceptanceCriteria, ['Tracker AC', 'Spec AC']);
});

test('manual ticket data already carrying the spec is not duplicated', () => {
  const manualTicket = {
    ...trackerTicket,
    source: 'manual' as const,
    description: '## Acceptance Criteria\n\n- Spec AC',
    acceptanceCriteria: ['Spec AC'],
  };

  assert.strictEqual(
    mergeInitialContextIntoTicketData(manualTicket, manualTicket.description),
    manualTicket,
  );
});

test('tracker fetch fallback still gains the attached spec', () => {
  const fallbackTicket = {
    ...trackerTicket,
    source: 'manual' as const,
    description: '',
    acceptanceCriteria: [],
  };
  const merged = mergeInitialContextIntoTicketData(
    fallbackTicket,
    [
      'Backlog markdown spec (.backlog/specs/tat-78001.md):',
      '## Acceptance Criteria',
      '- Spec AC',
      '',
      'Backlog notes:',
      'Legacy queued note',
      '',
      'Backlog source: jira TAT-78001',
    ].join('\n'),
  );

  assert.match(merged.description, /Backlog markdown spec/);
  assert.deepEqual(merged.acceptanceCriteria, ['Spec AC']);
});
