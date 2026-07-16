import type {
  FamilyArtifactFootprint,
  FamilyObservabilitySnapshot,
  FamilyReport,
  FleetStatus,
  FleetSummary,
  MonitorViolation,
  PendingDecision,
  PRStatus,
  Run,
  SlotHealth,
  SlotRunHistoryEntry,
  SlotStatus,
  TaskProgressStructured,
  TaskSchema,
} from '@farmslot/protocol';

export interface RecipeProvenanceScenario {
  id: string;
  label: string;
  expectation: string;
  run: Run;
}

export function mockHealth(overrides?: Partial<SlotHealth>): SlotHealth {
  return {
    ssh: 'OK',
    device: 'emu:OK',
    devserver: 'OK',
    cdp: 'Wallet',
    fixtures: 'OK',
    ...overrides,
  };
}

export function mockSlot(overrides?: Partial<SlotStatus>): SlotStatus {
  return {
    slot: 'runner-local-mobile-1',
    machine: 'runner-local',
    platform: 'ios',
    project: 'example-mobile',
    health: mockHealth(),
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: true,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: 'claude',
    model: 'sonnet',
    resources: { 'dev-server': { port: 8081 }, 'ios-sim': { simulator: 'mm-1' } },
    deviceName: 'playground-1',
    taskPhase: null,
    taskStepProgress: null,
    ...overrides,
  };
}

export function mockFleetSlots(): SlotStatus[] {
  return [
    mockSlot({
      slot: 'runner-local-mobile-1',
      machine: 'runner-local',
      platform: 'ios',
      lifecycle: 'busy',
      phase: 'working',
      agent: 'working',
      taskId: 'PROJ-2501',
      branch: 'fix/proj-2501',
      dispatchedAt: new Date(Date.now() - 45 * 60000).toISOString(),
      agentContexts: [
        {
          id: 'fix-bug',
          role: 'fix-bug',
          label: 'Bugfix',
          status: 'working',
          runId: 'pipe-mid-monitor',
          taskFile: '.task/fix/PROJ-2501/TASK.md',
          signalFile: '.task/fix/PROJ-2501/SIGNAL.json',
          runner: 'claude',
          model: 'sonnet',
          nudgeCount: 1,
          target: { session: 'example-1', window: 'bugfix', target: 'example-1:bugfix' },
        },
        {
          id: 'rev-codex',
          role: 'self-review',
          label: 'Self-review',
          status: 'working',
          runId: 'pipe-mid-monitor',
          taskFile: '.task/fix/PROJ-2501/SELF-REVIEW.md',
          signalFile: '.task/fix/PROJ-2501/SELF-REVIEW-SIGNAL.json',
          runner: 'codex',
          model: 'gpt-5',
          updatedAt: '2026-07-09T12:01:00Z',
          target: {
            session: 'example-1',
            window: 'rev-codex',
            target: 'example-1:rev-codex',
          },
        },
        {
          id: 'rev-claude',
          role: 'self-review',
          label: 'Self-review',
          status: 'complete',
          runId: 'pipe-mid-monitor',
          taskFile: '.task/fix/PROJ-2501/SELF-REVIEW.md',
          signalFile: '.task/fix/PROJ-2501/SELF-REVIEW-SIGNAL.json',
          runner: 'claude',
          model: 'opus',
          updatedAt: '2026-07-09T12:02:00Z',
          target: {
            session: 'example-1',
            window: 'rev-claude',
            target: 'example-1:rev-claude',
          },
        },
        {
          id: 'ci-fix',
          role: 'ci-fix',
          label: 'CI fix',
          status: 'waiting',
          runId: 'pipe-mid-monitor',
          taskFile: '.task/fix/PROJ-2501/CI-FIX.md',
          signalFile: '.task/fix/PROJ-2501/CI-FIX-SIGNAL.json',
          runner: 'claude',
          model: 'sonnet',
          target: { session: 'example-1', window: 'ci-fix', target: 'example-1:ci-fix' },
        },
      ],
    }),
    mockSlot({
      slot: 'runner-local-mobile-2',
      machine: 'runner-local',
      platform: 'ios',
      lifecycle: 'ready',
      phase: null,
      warm: true,
      agent: 'idle',
    }),
    mockSlot({
      slot: 'runner-local-mobile-3',
      machine: 'runner-local',
      platform: 'ios',
      lifecycle: 'ready',
      phase: null,
      warm: false,
      agent: 'no-tmux',
      health: mockHealth({ devserver: 'OFF', cdp: 'OFF' }),
    }),
    mockSlot({
      slot: 'runner-local-audio-1',
      machine: 'runner-local',
      platform: 'ios',
      lifecycle: 'manual',
      phase: null,
      project: 'example-audio',
    }),
    mockSlot({
      slot: 'runner-a-example-1',
      machine: 'runner-a',
      platform: 'android',
      lifecycle: 'busy',
      phase: 'working',
      agent: 'working',
      taskId: 'PROJ-2499',
      branch: 'fix/proj-2499',
      dispatchedAt: new Date(Date.now() - 120 * 60000).toISOString(),
    }),
    mockSlot({
      slot: 'runner-a-example-2',
      machine: 'runner-a',
      platform: 'android',
      lifecycle: 'ready',
      phase: null,
      warm: true,
      agent: 'idle',
    }),
    mockSlot({
      slot: 'runner-b-mobile-1',
      machine: 'runner-b',
      platform: 'android',
      lifecycle: 'disabled',
      phase: null,
      enabled: false,
      health: mockHealth({ ssh: 'FAIL', device: '-', devserver: '-', cdp: '-', fixtures: '-' }),
    }),
    mockSlot({
      slot: 'runner-local-echobridge-1',
      machine: 'runner-local',
      platform: 'ios',
      lifecycle: 'ready',
      phase: null,
      warm: true,
      project: 'echobridge',
    }),
  ];
}

export function mockFleetStatus(): FleetStatus {
  const slots = mockFleetSlots();
  const summary: FleetSummary = {
    total: slots.length,
    ready: slots.filter((s) => s.lifecycle === 'ready').length,
    busy: slots.filter((s) => s.lifecycle === 'busy').length,
    held: slots.filter((s) => s.lifecycle === 'held').length,
    manual: slots.filter((s) => s.lifecycle === 'manual').length,
    disabled: slots.filter((s) => s.lifecycle === 'disabled').length,
    blocked: 0,
    warmCount: slots.filter((s) => s.lifecycle === 'ready' && s.warm).length,
  };
  return { checkedAt: new Date().toISOString(), slots, summary };
}

export function mockPRList(): PRStatus[] {
  return [
    {
      pr: 27901,
      title: 'fix: resolve keychain unlock race condition on Android',
      summary:
        'Fixes race condition where SecureKeychain.get() returns null during biometric prompt, causing unlock failure on Android 14+',
      repo: 'example-org/example-mobile',
      headRef: null,
      project: 'example-mobile-farm',
      slot: 'runner-local-mobile-1',
      session: 'example-1',
      checks: [
        { name: 'e2e-android', status: 'pass', watchName: 'e2e-android' },
        { name: 'e2e-ios', status: 'pending', watchName: 'e2e-ios' },
        { name: 'lint', status: 'pass', watchName: 'lint' },
        { name: 'unit-tests', status: 'pass', watchName: 'unit-tests' },
        { name: 'docs-quality', status: 'skipped', watchName: 'docs-quality' },
      ],
      checkSummary: { passed: 3, failed: 0, pending: 1, skipped: 1, total: 5 },
      allPassed: false,
      anyFailed: false,
      failedNames: [],
      botComments: [],
      actionableBotComments: [],
      prState: 'OPEN',
      merged: false,
      mergeable: 'MERGEABLE',
      mergeConflict: false,
      reviewDecision: '',
      recommendation: 'WORKING',
    },
    {
      pr: 27888,
      title: 'feat: add perps trading confirmation modal',
      summary:
        'Adds order review modal before placing perps trades, showing fees, margin, and liquidation price',
      repo: 'example-org/example-mobile',
      headRef: null,
      project: 'example-mobile-farm',
      slot: 'runner-a-example-1',
      session: 'example-1',
      checks: [
        { name: 'e2e-android', status: 'fail', watchName: 'e2e-android' },
        { name: 'e2e-ios', status: 'pass', watchName: 'e2e-ios' },
        { name: 'lint', status: 'pass', watchName: 'lint' },
        { name: 'unit-tests', status: 'pass', watchName: 'unit-tests' },
      ],
      checkSummary: { passed: 3, failed: 1, pending: 0, skipped: 0, total: 4 },
      allPassed: false,
      anyFailed: true,
      failedNames: ['e2e-android'],
      botComments: [
        {
          author: 'examplebot',
          label: 'bugbot',
          action: 'review',
          bodyPreview: 'Found 2 issues...',
          createdAt: new Date().toISOString(),
          source: 'bugbot',
          workerResponded: false,
        },
      ],
      actionableBotComments: [
        {
          author: 'examplebot',
          label: 'bugbot',
          action: 'review',
          bodyPreview: 'Found 2 issues...',
          createdAt: new Date().toISOString(),
          source: 'bugbot',
          workerResponded: false,
        },
      ],
      prState: 'OPEN',
      merged: false,
      mergeable: 'MERGEABLE',
      mergeConflict: false,
      reviewDecision: '',
      recommendation: 'NEEDS_ATTENTION',
    },
    {
      pr: 27850,
      title: 'fix: correct token balance display for ERC-721 assets',
      summary: null,
      repo: 'example-org/example-mobile',
      headRef: null,
      project: 'example-mobile-farm',
      slot: null,
      session: null,
      checks: [
        { name: 'e2e-android', status: 'pass', watchName: 'e2e-android' },
        { name: 'e2e-ios', status: 'pass', watchName: 'e2e-ios' },
        { name: 'lint', status: 'pass', watchName: 'lint' },
        { name: 'unit-tests', status: 'pass', watchName: 'unit-tests' },
      ],
      checkSummary: { passed: 4, failed: 0, pending: 0, skipped: 0, total: 4 },
      allPassed: true,
      anyFailed: false,
      failedNames: [],
      botComments: [],
      actionableBotComments: [],
      prState: 'OPEN',
      merged: false,
      mergeable: 'MERGEABLE',
      mergeConflict: false,
      reviewDecision: 'APPROVED',
      recommendation: 'READY',
    },
    {
      pr: 27812,
      title: 'feat: preserve family merge milestone after workflow completion',
      summary: 'Owned family finished all work; PR is now waiting for a human merge.',
      repo: 'example-org/example-mobile',
      headRef: null,
      project: 'example-mobile-farm',
      slot: null,
      session: null,
      checks: [
        { name: 'e2e-android', status: 'pass', watchName: 'e2e-android' },
        { name: 'e2e-ios', status: 'pass', watchName: 'e2e-ios' },
        { name: 'lint', status: 'pass', watchName: 'lint' },
        { name: 'unit-tests', status: 'pass', watchName: 'unit-tests' },
      ],
      checkSummary: { passed: 4, failed: 0, pending: 0, skipped: 0, total: 4 },
      allPassed: true,
      anyFailed: false,
      failedNames: [],
      botComments: [],
      actionableBotComments: [],
      prState: 'OPEN',
      merged: false,
      mergeable: 'MERGEABLE',
      mergeConflict: false,
      reviewDecision: 'APPROVED',
      recommendation: 'WAITING_FOR_MERGE',
      ownedFamily: true,
      familyId: 'family-pr-wait',
      familyRootTicketOrPr: 'PROJ-3021',
      familyRunCount: 3,
      activeFamilyRunCount: 0,
      workflowState: 'complete',
      mergeState: 'waiting_for_merge',
      latestRunId: 'run-family-pr-wait',
    },
    {
      pr: 27777,
      title: 'fix: merged family now shows business completion',
      summary: 'Merged successfully after passive merge-wait.',
      repo: 'example-org/example-mobile',
      headRef: null,
      project: 'example-mobile-farm',
      slot: null,
      session: null,
      checks: [
        { name: 'e2e-android', status: 'pass', watchName: 'e2e-android' },
        { name: 'e2e-ios', status: 'pass', watchName: 'e2e-ios' },
        { name: 'lint', status: 'pass', watchName: 'lint' },
        { name: 'unit-tests', status: 'pass', watchName: 'unit-tests' },
      ],
      checkSummary: { passed: 4, failed: 0, pending: 0, skipped: 0, total: 4 },
      allPassed: true,
      anyFailed: false,
      failedNames: [],
      botComments: [],
      actionableBotComments: [],
      prState: 'MERGED',
      merged: true,
      mergeable: 'MERGEABLE',
      mergeConflict: false,
      reviewDecision: 'APPROVED',
      recommendation: 'MERGED',
      ownedFamily: true,
      familyId: 'family-pr-merged',
      familyRootTicketOrPr: 'PROJ-2888',
      familyRunCount: 2,
      activeFamilyRunCount: 0,
      workflowState: 'complete',
      mergeState: 'merged',
      latestRunId: 'run-family-pr-merged',
    },
    {
      pr: 27712,
      title: 'fix: family closed without merge',
      summary: 'PR was closed after work completed, without merge.',
      repo: 'example-org/example-mobile',
      headRef: null,
      project: 'example-mobile-farm',
      slot: null,
      session: null,
      checks: [
        { name: 'e2e-android', status: 'pass', watchName: 'e2e-android' },
        { name: 'e2e-ios', status: 'pass', watchName: 'e2e-ios' },
      ],
      checkSummary: { passed: 2, failed: 0, pending: 0, skipped: 0, total: 2 },
      allPassed: true,
      anyFailed: false,
      failedNames: [],
      botComments: [],
      actionableBotComments: [],
      prState: 'CLOSED',
      merged: false,
      mergeable: 'UNKNOWN',
      mergeConflict: false,
      reviewDecision: '',
      recommendation: 'CLOSED_WITHOUT_MERGE',
      ownedFamily: true,
      familyId: 'family-pr-closed',
      familyRootTicketOrPr: 'PROJ-2666',
      familyRunCount: 2,
      activeFamilyRunCount: 0,
      workflowState: 'complete',
      mergeState: 'closed_without_merge',
      latestRunId: 'run-family-pr-closed',
    },
  ];
}

export function mockViolations(): MonitorViolation[] {
  return [
    {
      slotId: 'runner-local-mobile-1',
      type: 'stuck',
      message: 'No terminal output for 15 minutes, step 4/8 incomplete',
      nudgeSent: new Date(Date.now() - 2 * 60000).toISOString(),
      timestamp: new Date(Date.now() - 3 * 60000).toISOString(),
    },
    {
      slotId: 'runner-a-example-1',
      type: 'idle',
      message: 'Agent shows shell prompt, no Claude session active',
      nudgeSent: null,
      timestamp: new Date(Date.now() - 10 * 60000).toISOString(),
    },
    {
      slotId: 'runner-b-mobile-1',
      type: 'error',
      message: 'CDP connection refused — app may have crashed',
      nudgeSent: null,
      timestamp: new Date(Date.now() - 1 * 60000).toISOString(),
    },
  ];
}

export function mockTaskMarkdown(): string {
  return `# TASK: Fix PROJ-2501 — Keychain unlock race condition

**Branch:** fix/proj-2501
**PR:** #27901

## Steps

- [x] Read the Jira ticket and understand the bug
- [x] Reproduce the issue locally
- [x] Identify root cause in SecurityManager.ts
- [ ] Implement fix: add mutex lock around keychain access
- [ ] Add unit tests for concurrent keychain operations
- [ ] Run full test suite
- [ ] Create PR with description
- [ ] Verify CI passes
`;
}

export function mockTaskSchema(): TaskSchema {
  return {
    flowType: 'fix-bug',
    title: 'Fix PROJ-2501 — Keychain unlock race condition',
    totalSteps: 8,
    phases: [
      {
        name: 'Investigate',
        steps: [
          { index: 1, name: 'Read the Jira ticket and understand the bug' },
          { index: 2, name: 'Reproduce the issue locally' },
          { index: 3, name: 'Identify root cause in SecurityManager.ts' },
        ],
      },
      {
        name: 'Implement',
        steps: [
          {
            index: 4,
            name: 'Implement fix: add mutex lock around keychain access',
            artifacts: ['src/core/SecurityManager.ts'],
          },
          {
            index: 5,
            name: 'Add unit tests for concurrent keychain operations',
            artifacts: ['tests/SecurityManager.test.ts'],
          },
        ],
      },
      {
        name: 'Validate',
        steps: [
          { index: 6, name: 'Run full test suite' },
          { index: 7, name: 'Create PR with description' },
          { index: 8, name: 'Verify CI passes' },
        ],
      },
    ],
  };
}

export function mockStructuredProgress(completedCount: number): TaskProgressStructured {
  const schema = mockTaskSchema();

  let globalIdx = 0;
  let foundFirstPending = false;
  let currentPhase: string | null = null;
  let currentStep: string | null = null;
  let completedSteps = 0;

  const phases = schema.phases.map((phase) => {
    let phaseCompleted = 0;
    const steps = phase.steps.map((step) => {
      globalIdx++;
      const isDone = globalIdx <= completedCount;
      let status: 'done' | 'running' | 'pending';
      if (isDone) {
        status = 'done';
        phaseCompleted++;
        completedSteps++;
      } else if (!foundFirstPending) {
        status = 'running';
        foundFirstPending = true;
        currentPhase = phase.name;
        currentStep = step.name;
      } else {
        status = 'pending';
      }
      return {
        index: step.index,
        name: step.name,
        status,
        ...(step.artifacts ? { artifacts: step.artifacts } : {}),
      };
    });
    return {
      name: phase.name,
      steps,
      completedSteps: phaseCompleted,
      totalSteps: phase.steps.length,
    };
  });

  return {
    schema,
    phases,
    completedSteps,
    totalSteps: schema.totalSteps,
    currentPhase,
    currentStep,
  };
}

export interface MockFileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size?: number;
  children?: MockFileEntry[];
}

export function mockFileTree(): MockFileEntry[] {
  return [
    {
      name: 'src',
      type: 'directory',
      path: 'src',
      children: [
        {
          name: 'components',
          type: 'directory',
          path: 'src/components',
          children: [
            { name: 'App.tsx', type: 'file', path: 'src/components/App.tsx', size: 2450 },
            { name: 'Header.tsx', type: 'file', path: 'src/components/Header.tsx', size: 1120 },
          ],
        },
        {
          name: 'utils',
          type: 'directory',
          path: 'src/utils',
          children: [
            { name: 'helpers.ts', type: 'file', path: 'src/utils/helpers.ts', size: 890 },
            { name: 'constants.ts', type: 'file', path: 'src/utils/constants.ts', size: 340 },
          ],
        },
        { name: 'index.ts', type: 'file', path: 'src/index.ts', size: 180 },
      ],
    },
    { name: 'package.json', type: 'file', path: 'package.json', size: 1240 },
    { name: 'tsconfig.json', type: 'file', path: 'tsconfig.json', size: 520 },
    { name: 'README.md', type: 'file', path: 'README.md', size: 3200 },
    { name: '.gitignore', type: 'file', path: '.gitignore', size: 120 },
  ];
}

export function mockGitChanges() {
  return {
    branch: 'fix/button-alignment',
    ahead: 3,
    behind: 1,
    changes: [
      { path: 'src/components/Button.tsx', status: 'M' as const },
      { path: 'src/components/Header.tsx', status: 'M' as const },
      { path: 'src/components/NewModal.tsx', status: 'A' as const },
      { path: 'src/utils/old-helper.ts', status: 'D' as const },
      { path: 'src/styles/theme.css', status: 'M' as const },
      {
        path: 'src/components/Card.tsx',
        status: 'R' as const,
        oldPath: 'src/components/OldCard.tsx',
      },
      { path: 'test/Button.test.tsx', status: 'A' as const },
      { path: 'docs/CHANGELOG.md', status: '?' as const },
    ],
  };
}

export function mockMetroLines(): string[] {
  return [
    '[11:23:44] info  Starting Metro bundler...',
    '[11:23:45] info  Metro waiting on port 8081',
    '[11:23:45] info  Developer settings:',
    '[11:23:45] info    - Fast Refresh: enabled',
    '[11:23:46] info  Loading dependency graph...',
    '[11:23:48] info  Dependency graph loaded (2.1s)',
    '[11:23:50] info  BUNDLE  ./index.js',
    '[11:23:52] info  BUNDLE  ./index.js (platform=ios, dev=true)',
    '[11:23:55] info  BUNDLE  completed in 4892ms',
    '[11:24:01] warn  Module not found: @react-native/assets-registry (falling back to default)',
    '[11:24:01] warn  Duplicate module name: react-native-screens',
    '[11:24:05] info  BUNDLE  ./index.js (platform=ios, dev=true)',
    '[11:24:08] info  BUNDLE  completed in 2541ms',
    '[11:24:10] info  HMR update sent to client',
    "[11:24:15] error TypeError: Cannot read property 'map' of undefined",
    '[11:24:15] error   at transformModule (node_modules/metro/src/DeltaBundler/Worker.js:85:5)',
    '[11:24:15] error   at processTicksAndRejections (internal/process.js:85:5)',
    '[11:24:20] info  HMR client connected',
    '[11:24:22] info  BUNDLE  ./index.js (platform=ios, dev=true)',
    '[11:24:24] info  BUNDLE  completed in 1823ms',
    '[11:24:30] warn  Require cycle: src/components/App.tsx -> src/hooks/useAuth.ts -> src/components/App.tsx',
    '[11:24:35] info  HMR update sent to client',
    '[11:24:40] info  BUNDLE  ./index.js (platform=android, dev=true)',
    '[11:24:43] info  BUNDLE  completed in 3201ms',
    '[11:24:50] info  HMR update sent to client',
    '[11:24:55] error ReferenceError: __DEV__ is not defined',
    '[11:24:55] error   at Object.<anonymous> (src/config/env.ts:12:1)',
    '[11:25:00] info  BUNDLE  ./index.js (platform=ios, dev=true)',
    '[11:25:02] info  BUNDLE  completed in 1944ms',
    '[11:25:05] info  HMR update sent to client',
  ];
}

export function mockWorkspaceFiles(): Map<string, string> {
  const files = new Map<string, string>();

  files.set(
    'TASK.md',
    `# TASK: Fix PROJ-2501 — Keychain unlock race condition

**Branch:** fix/proj-2501
**PR:** #27901

## Steps

- [x] Read the Jira ticket and understand the bug
- [x] Reproduce the issue locally
- [x] Identify root cause in SecurityManager.ts
- [ ] Implement fix: add mutex lock around keychain access
- [ ] Add unit tests for concurrent keychain operations
- [ ] Run full test suite
- [ ] Create PR with description
- [ ] Verify CI passes
`,
  );

  files.set(
    'recipe.json',
    JSON.stringify(
      {
        name: 'fix-keychain-race',
        slot: 'runner-local-mobile-1',
        steps: [
          { action: 'checkout', branch: 'fix/proj-2501' },
          { action: 'install_deps' },
          { action: 'run_tests', suite: 'unit' },
          { action: 'build', variant: 'debug' },
        ],
      },
      null,
      2,
    ),
  );

  files.set(
    'src/components/App.tsx',
    `import React from 'react';
import { SecurityManager } from '../core/SecurityManager';
import { Header } from './Header';

export const App: React.FC = () => {
  const [unlocked, setUnlocked] = React.useState(false);

  React.useEffect(() => {
    SecurityManager.checkAuth().then(setUnlocked);
  }, []);

  return (
    <div className="app">
      <Header />
      {unlocked ? <MainView /> : <LockScreen />}
    </div>
  );
};
`,
  );

  files.set(
    'src/components/Header.tsx',
    `import React from 'react';

interface HeaderProps {
  title?: string;
}

export const Header: React.FC<HeaderProps> = ({ title = 'Example App' }) => (
  <header className="header">
    <h1>{title}</h1>
    <nav className="header-nav">
      <span>Portfolio</span>
      <span>Activity</span>
      <span>Settings</span>
    </nav>
  </header>
);
`,
  );

  files.set(
    'src/utils/helpers.ts',
    `export function formatBalance(wei: bigint, decimals = 18): string {
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = wei / divisor;
  const frac = wei % divisor;
  return \`\${whole}.\${frac.toString().padStart(decimals, '0').slice(0, 4)}\`;
}

export function truncateAddress(addr: string): string {
  return \`\${addr.slice(0, 6)}...\${addr.slice(-4)}\`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
`,
  );

  files.set(
    'src/utils/constants.ts',
    `export const RPC_TIMEOUT = 30_000;
export const MAX_RETRIES = 3;
export const DEFAULT_CHAIN_ID = '0x1';
`,
  );

  files.set(
    'src/index.ts',
    `export { App } from './components/App';
export { formatBalance, truncateAddress } from './utils/helpers';
`,
  );

  return files;
}

export function mockWorkspaceDiffs(): Map<string, string> {
  const diffs = new Map<string, string>();

  diffs.set(
    'src/components/Button.tsx',
    [
      'diff --git a/src/components/Button.tsx b/src/components/Button.tsx',
      'index aa11bb2..cc33dd4 100644',
      '--- a/src/components/Button.tsx',
      '+++ b/src/components/Button.tsx',
      '@@ -5,8 +5,12 @@',
      ' interface ButtonProps {',
      '   label: string;',
      '   onPress: () => void;',
      '+  variant?: "primary" | "secondary";',
      '+  disabled?: boolean;',
      ' }',
      ' ',
      '-export const Button: React.FC<ButtonProps> = ({ label, onPress }) => (',
      '-  <Pressable onPress={onPress} style={styles.button}>',
      '+export const Button: React.FC<ButtonProps> = ({ label, onPress, variant = "primary", disabled }) => (',
      '+  <Pressable',
      '+    onPress={onPress}',
      '+    disabled={disabled}',
      '+    style={[styles.button, styles[variant], disabled && styles.disabled]}>',
      '     <Text style={styles.label}>{label}</Text>',
      '   </Pressable>',
      ' );',
    ].join('\n'),
  );

  diffs.set(
    'src/components/Header.tsx',
    [
      'diff --git a/src/components/Header.tsx b/src/components/Header.tsx',
      'index ee55ff6..1122334 100644',
      '--- a/src/components/Header.tsx',
      '+++ b/src/components/Header.tsx',
      '@@ -3,7 +3,9 @@',
      ' interface HeaderProps {',
      '   title?: string;',
      ' }',
      ' ',
      '-export const Header: React.FC<HeaderProps> = ({ title = "App" }) => (',
      '+export const Header: React.FC<HeaderProps> = ({ title = "Example App" }) => (',
      '   <header className="header">',
      '-    <h1>{title}</h1>',
      '+    <img src="/logo.svg" alt="logo" />',
      '+    <h1 className="header-title">{title}</h1>',
      '   </header>',
      ' );',
    ].join('\n'),
  );

  diffs.set(
    'src/styles/theme.css',
    [
      'diff --git a/src/styles/theme.css b/src/styles/theme.css',
      'index 5566778..9900aab 100644',
      '--- a/src/styles/theme.css',
      '+++ b/src/styles/theme.css',
      '@@ -1,4 +1,6 @@',
      ' :root {',
      '   --color-primary: #037dd6;',
      '+  --color-primary-hover: #0260a4;',
      '+  --color-error: #d73a49;',
      '   --font-family: "Euclid Circular B", sans-serif;',
      ' }',
    ].join('\n'),
  );

  return diffs;
}

export function mockRuns(): Run[] {
  const now = Date.now();
  return [
    {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      familyId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      flowType: 'fix-bug',
      status: 'blocked',
      project: 'example-mobile',
      ticketOrPr: 'PROJ-2501',
      slotId: 'runner-local-mobile-1',
      branch: 'fix/proj-2501',
      taskFile: 'tasks/PROJ-2501.md',
      tags: ['demo', 'mobile'],
      steps: [
        {
          name: 'grade',
          status: 'done',
          startedAt: new Date(now - 50 * 60000).toISOString(),
          completedAt: new Date(now - 49 * 60000).toISOString(),
          durationMs: 60000,
        },
        {
          name: 'find-slot',
          status: 'done',
          startedAt: new Date(now - 49 * 60000).toISOString(),
          completedAt: new Date(now - 48 * 60000).toISOString(),
          durationMs: 60000,
        },
        {
          name: 'write-task',
          status: 'done',
          startedAt: new Date(now - 48 * 60000).toISOString(),
          completedAt: new Date(now - 47 * 60000).toISOString(),
          durationMs: 60000,
        },
        {
          name: 'prepare',
          status: 'done',
          startedAt: new Date(now - 47 * 60000).toISOString(),
          completedAt: new Date(now - 43 * 60000).toISOString(),
          durationMs: 240000,
        },
        {
          name: 'dispatch',
          status: 'done',
          startedAt: new Date(now - 43 * 60000).toISOString(),
          completedAt: new Date(now - 42 * 60000).toISOString(),
          durationMs: 60000,
        },
        { name: 'monitor', status: 'running', startedAt: new Date(now - 42 * 60000).toISOString() },
        { name: 'complete', status: 'pending' },
      ],
      grade: {
        difficulty: 'high',
        rationale: 'Race condition in keychain — cross-component concurrency issue',
        modelRecommendation: 'sonnet',
        score: 7,
      },
      decisions: [],
      metrics: { nudgeCount: 1, model: 'sonnet', runner: 'claude' },
      agentContexts: [
        {
          id: 'fix-bug',
          role: 'fix-bug',
          label: 'Bugfix',
          status: 'working',
          slotId: 'runner-local-mobile-1',
          runId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          taskFile: '.task/fix/PROJ-2501/TASK.md',
          signalFile: '.task/fix/PROJ-2501/SIGNAL.json',
          runner: 'claude',
          model: 'sonnet',
          nudgeCount: 1,
          target: { session: 'example-1', window: 'bugfix', target: 'example-1:bugfix' },
        },
        {
          id: 'self-review',
          role: 'self-review',
          label: 'Self-review',
          status: 'working',
          slotId: 'runner-local-mobile-1',
          runId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          taskFile: '.task/fix/PROJ-2501/SELF-REVIEW.md',
          signalFile: '.task/fix/PROJ-2501/SELF-REVIEW-SIGNAL.json',
          runner: 'claude',
          model: 'sonnet',
          target: {
            session: 'example-1',
            window: 'self-review',
            target: 'example-1:self-review',
          },
        },
        {
          id: 'ci-fix',
          role: 'ci-fix',
          label: 'CI fix',
          status: 'waiting',
          slotId: 'runner-local-mobile-1',
          runId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          taskFile: '.task/fix/PROJ-2501/CI-FIX.md',
          signalFile: '.task/fix/PROJ-2501/CI-FIX-SIGNAL.json',
          runner: 'claude',
          model: 'sonnet',
          target: { session: 'example-1', window: 'ci-fix', target: 'example-1:ci-fix' },
        },
      ],
      createdAt: new Date(now - 50 * 60000).toISOString(),
      updatedAt: new Date(now - 2 * 60000).toISOString(),
    },
    {
      id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
      familyId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
      flowType: 'review-pr',
      status: 'preparing',
      project: 'example-mobile',
      ticketOrPr: '#27888',
      slotId: 'runner-a-example-1',
      branch: null,
      taskFile: null,
      steps: [
        { name: 'grade', status: 'skipped' },
        {
          name: 'find-slot',
          status: 'done',
          startedAt: new Date(now - 10 * 60000).toISOString(),
          completedAt: new Date(now - 9 * 60000).toISOString(),
          durationMs: 60000,
        },
        { name: 'prepare', status: 'running', startedAt: new Date(now - 9 * 60000).toISOString() },
        { name: 'dispatch', status: 'pending' },
        { name: 'monitor', status: 'pending' },
        { name: 'complete', status: 'pending' },
      ],
      decisions: [],
      metrics: { nudgeCount: 0, model: 'sonnet', runner: 'claude' },
      createdAt: new Date(now - 10 * 60000).toISOString(),
      updatedAt: new Date(now - 1 * 60000).toISOString(),
    },
    {
      id: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
      familyId: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
      flowType: 'fix-bug',
      status: 'done',
      project: 'example-mobile',
      ticketOrPr: 'PROJ-2499',
      slotId: 'runner-a-example-2',
      branch: 'fix/proj-2499',
      taskFile: 'tasks/PROJ-2499.md',
      steps: [
        { name: 'grade', status: 'done', durationMs: 45000 },
        { name: 'find-slot', status: 'done', durationMs: 30000 },
        { name: 'prepare', status: 'done', durationMs: 280000 },
        { name: 'dispatch', status: 'done', durationMs: 55000 },
        { name: 'monitor', status: 'done', durationMs: 2400000 },
        { name: 'complete', status: 'done', durationMs: 120000 },
      ],
      decisions: [],
      metrics: {
        nudgeCount: 0,
        model: 'sonnet',
        runner: 'claude',
        outcome: 'success',
        disposition: 'already_fixed',
        terminalEvidence: {
          reportPath: 'artifacts/no-change-report.md',
          artifacts: ['artifacts/already-fixed-ac1.png'],
          confidence: 'high',
        },
        durationMs: 2930000,
      },
      createdAt: new Date(now - 120 * 60000).toISOString(),
      updatedAt: new Date(now - 71 * 60000).toISOString(),
      completedAt: new Date(now - 71 * 60000).toISOString(),
    },
    {
      id: 'd4e5f6a7-b8c9-0123-defa-234567890123',
      familyId: 'd4e5f6a7-b8c9-0123-defa-234567890123',
      flowType: 'dev',
      status: 'failed',
      project: 'example-audio',
      ticketOrPr: 'AUD-42',
      slotId: 'runner-local-audio-1',
      branch: 'feat/aud-42',
      taskFile: 'tasks/AUD-42.md',
      steps: [
        { name: 'grade', status: 'done', durationMs: 50000 },
        { name: 'find-slot', status: 'done', durationMs: 25000 },
        { name: 'prepare', status: 'failed', detail: 'yarn install failed: lockfile conflict' },
        { name: 'dispatch', status: 'skipped' },
        { name: 'monitor', status: 'skipped' },
        { name: 'complete', status: 'skipped' },
      ],
      decisions: [],
      metrics: {
        nudgeCount: 0,
        model: 'opus',
        runner: 'claude',
        outcome: 'failure',
        durationMs: 185000,
      },
      createdAt: new Date(now - 180 * 60000).toISOString(),
      updatedAt: new Date(now - 177 * 60000).toISOString(),
      completedAt: new Date(now - 177 * 60000).toISOString(),
      error: 'yarn install failed: lockfile conflict',
    },
  ].map((run) => ({ lane: 'production', variant: null, ...run }) as Run);
}

export function mockPipelineRuns(): Run[] {
  const now = Date.now();
  return [
    // 1. Mid-monitor: fix-bug, monitoring with task progress
    {
      id: 'pipe-mid-monitor',
      familyId: 'pipe-mid-monitor',
      flowType: 'fix-bug',
      status: 'monitoring',
      project: 'example-mobile',
      ticketOrPr: 'PROJ-2501',
      slotId: 'runner-local-mobile-1',
      branch: 'fix/proj-2501',
      taskFile: 'tasks/PROJ-2501.md',
      steps: [
        { name: 'grade', status: 'done', durationMs: 17000 },
        { name: 'find-slot', status: 'done', durationMs: 8000 },
        { name: 'write-task', status: 'done', durationMs: 45000 },
        { name: 'prepare', status: 'done', durationMs: 240000 },
        { name: 'dispatch', status: 'done', durationMs: 12000 },
        { name: 'monitor', status: 'done', durationMs: 2400000 },
        {
          name: 'self-review',
          status: 'done',
          durationMs: 180000,
          outputs: { verdict: 'pass', issues: [] },
        },
        {
          name: 'complete',
          status: 'done',
          durationMs: 45000,
          outputs: {
            prNumber: null,
            ciRepo: 'AcmeOrg/acme-mobile',
            artifactsCopied: true,
            prCommentPosted: false,
            prTitleUpdated: false,
            prMarkedReady: false,
            packageId: 'pkg-pipe-mid-monitor',
            packageHash: 'abc123def4567890abc123def4567890abc123def4567890abc123def4567890',
            publicationTarget: 'ready',
            publicationStatus: 'not_published',
            reviewSatisfied: true,
            slotDisposition: 'released',
            artifacts: [],
          },
        },
        {
          name: 'human-gate',
          status: 'running',
          startedAt: new Date(now - 2 * 60000).toISOString(),
          detail: 'Approve Publish pending',
        },
        { name: 'finalize', status: 'pending' },
        { name: 'ci-watch', status: 'pending' },
      ],
      engineState: {
        publishGate: {
          reviewDepth: {
            minimumIndependentReviews: 1,
            extraLoopsRequested: 2,
            requireCrossRunner: true,
            requestedBy: 'dispatch',
          },
          pendingReviewPlan: [
            { order: 1, runner: 'cursor' },
            { order: 2, runner: 'codex' },
          ],
        },
      },
      grade: {
        difficulty: 'high',
        rationale: 'Race condition in keychain — cross-component concurrency issue',
        modelRecommendation: 'sonnet',
        score: 7,
      },
      decisions: [
        {
          id: 'dec-local-first-gate',
          type: 'engine_human_gate',
          title: 'Run pipe-mid-monitor — publish gate',
          description: 'Local package is ready for human publication approval',
          actions: [
            { id: 'approve-publish', label: 'Approve Publish', style: 'primary' },
            { id: 'hold', label: 'Hold', style: 'secondary' },
            { id: 'send-feedback', label: 'Send Feedback', style: 'secondary' },
            { id: 'request-extra-review', label: 'Request Extra Review', style: 'secondary' },
            {
              id: 'request-external-review',
              label: 'Request Independent Review (runner diversity)',
              style: 'secondary',
            },
          ],
          createdAt: new Date(now - 2 * 60000).toISOString(),
          payload: {
            kind: 'ready',
            prNumber: null,
            repo: 'AcmeOrg/acme-mobile',
            diffStat: { files: 4, additions: 128, deletions: 12 },
            workerReport:
              'Implementation completed locally. Package is ready for review before any PR exists.',
            branch: 'fix/proj-2501',
            slotId: 'runner-local-mobile-1',
            headSha: 'abc123def4567890',
            artifactManifest: [
              { path: 'report.md', purpose: 'report', sizeBytes: 1234 },
              { path: 'artifacts/diff.txt', purpose: 'diff', sizeBytes: 4820 },
              { path: 'before-keychain-race.png', purpose: 'screenshot-before', sizeBytes: 76000 },
              { path: 'after-keychain-race.png', purpose: 'screenshot-after', sizeBytes: 82000 },
              { path: 'after-keychain-race.mp4', purpose: 'video-after', sizeBytes: 2500000 },
              { path: 'artifacts/self-review-1.md', purpose: 'review', sizeBytes: 1380 },
              { path: 'artifacts/independent-review-2.md', purpose: 'review', sizeBytes: 920 },
            ],
            selfReviewVerdict: 'pass',
            selfReviewSummary:
              'Loop 1 requested missing lock cleanup coverage and a clearer failure-path assertion. The worker fixed both, then loop 2 passed the independent review with zero unresolved findings.',
            recipeJson: JSON.stringify({
              entry: 'unlock',
              nodes: {
                unlock: { action: 'tap biometric unlock', next: 'assert' },
                assert: { action: 'assert wallet loaded', next: null },
              },
            }),
            recipeQualityArtifact: {
              version: 1,
              verdict: 'pass',
              compact: {
                verdict: 'PASS',
                reasons: [
                  'Recipe proves the keychain race recovery path.',
                  'Evidence includes before/after captures for the unlock transition.',
                ],
                better_version_guidance: [],
              },
              dimensions: {},
              structural_findings: [],
              contextual_findings: [],
              suggested_recipe_delta: [],
              training_fields: {
                project: 'acme-mobile-farm',
                flow_type: 'fix-bug',
                proof_mode: 'mixed',
              },
              meta: {
                producer: 'worker',
                fallback_used: false,
                legacy_task: false,
                artifact_required: true,
                source_signals: ['recipe-quality.json'],
              },
            },
            qualityReport: {
              acVerdicts: [
                {
                  ac: 'Unlock succeeds after biometric prompt',
                  verdict: 'RELEVANT_HIGH',
                  reasoning:
                    'After evidence shows wallet loaded after biometric prompt completion.',
                },
                {
                  ac: 'No keychain race regression',
                  verdict: 'RELEVANT_LOW',
                  reasoning: 'Recipe covers happy path; race timing proof is partial.',
                },
                {
                  ac: 'CI remains green',
                  verdict: 'MISSING',
                  reasoning: 'CI watch has not run yet because publication approval is pending.',
                },
              ],
              overallScore: 70,
              overrides: [],
            },
            workerLearnings:
              'Self-review found that keychain race tests need explicit timing assertions. Future recipes should include a delayed biometric callback node.',
            acceptanceCriteria: [
              'Unlock succeeds after biometric prompt',
              'No keychain race regression',
              'CI remains green after publication',
            ],
            prPackage: {
              id: 'pkg-pipe-mid-monitor',
              packageHash: 'abc123def4567890abc123def4567890abc123def4567890abc123def4567890',
              artifactPath: 'artifacts/pr-package.json',
              branch: 'fix/proj-2501',
              remoteBranchRef: 'origin/fix/proj-2501',
              headSha: 'abc123def4567890',
              diffStat: { files: 4, additions: 128, deletions: 12 },
              draftTitle: 'fix: resolve PROJ-2501 keychain race',
              draftBody: [
                '## Summary',
                'Fix keychain race handling before publication.',
                '',
                '## Validation',
                '- Typecheck passed',
                '- Recipe passed',
                '- Independent self-review loops: 2',
                '',
                '## Visuals',
                '- Before/after captures are attached below.',
              ].join('\n'),
              evidenceManifest: [
                {
                  path: 'before-keychain-race.png',
                  purpose: 'screenshot-before',
                  sizeBytes: 76000,
                },
                { path: 'after-keychain-race.png', purpose: 'screenshot-after', sizeBytes: 82000 },
                { path: 'after-keychain-race.mp4', purpose: 'video-after', sizeBytes: 2500000 },
              ],
              selectedEvidenceKeys: [
                'before-keychain-race.png',
                'after-keychain-race.png',
                'after-keychain-race.mp4',
              ],
              validationSummaryPath: 'artifacts/report.md',
              validationSummaryHash: 'valhash',
              reviewArtifactIds: [
                'artifacts/self-review-1.json',
                'artifacts/independent-review-2.json',
              ],
              dispatchMode: 'autonomous',
              gatePolicy: {
                owner: 'human',
                dispatchMode: 'autonomous',
                publishAuthority: 'human',
                reason: 'v1 autonomous fix-bug runs still require human publication approval',
              },
              publicationTarget: 'ready',
              publicationStatus: 'not_published',
              createdAt: new Date(now - 3 * 60000).toISOString(),
            },
            reviewDepth: {
              minimumIndependentReviews: 1,
              requireCrossRunner: true,
              extraLoopsRequested: 1,
              requestedBy: 'human-gate',
            },
            independentReviews: [
              {
                id: 'self-review-1',
                source: 'self-review',
                runner: 'claude',
                model: 'sonnet',
                crossRunner: false,
                loopNumber: 1,
                verdict: 'issues',
                unresolvedCount: 2,
                reviewSnapshot: {
                  source: 'local-git',
                  baseRef: 'main',
                  baseSha: '6d90188f9f1c4a72b2d1f7a8a8bcb77a210f0050',
                  headRef: 'fix/proj-2501',
                  headSha: '9f8e7d6c5b4a3a21000000000000000000000000',
                  diffPath: 'artifacts/review-loop-1/review.diff',
                  diffHash: 'review-loop-1-hash',
                  diffStat: { files: 4, additions: 116, deletions: 12 },
                  capturedAt: new Date(now - 8 * 60000).toISOString(),
                },
                taskProgressArtifactPath:
                  'tasks/fix-bug/proj-2501/artifacts/review-loop-1/self-review.md',
                startedAt: new Date(now - 12 * 60000).toISOString(),
                completedAt: new Date(now - 9 * 60000).toISOString(),
                artifactPaths: [
                  'artifacts/self-review-1.json',
                  'artifacts/self-review-1.md',
                  'artifacts/review-loop-1/review.diff',
                  'artifacts/review-loop-1/self-review.md',
                ],
              },
              {
                id: 'independent-review-2',
                source: 'human-gate',
                runner: 'codex',
                model: 'gpt-5.5',
                crossRunner: true,
                loopNumber: 2,
                verdict: 'pass',
                unresolvedCount: 0,
                reviewSnapshot: {
                  source: 'local-git',
                  baseRef: 'main',
                  baseSha: '6d90188f9f1c4a72b2d1f7a8a8bcb77a210f0050',
                  headRef: 'fix/proj-2501',
                  headSha: 'a1b2c3d4e5f6a7b8000000000000000000000000',
                  diffPath: 'artifacts/independent-review-2/review-loop-1/review.diff',
                  diffHash: 'review-loop-2-hash',
                  diffStat: { files: 4, additions: 128, deletions: 12 },
                  capturedAt: new Date(now - 4 * 60000).toISOString(),
                },
                fixDelta: {
                  source: 'local-git',
                  baseSha: '9f8e7d6c5b4a3a21000000000000000000000000',
                  headSha: 'a1b2c3d4e5f6a7b8000000000000000000000000',
                  fixBaseSha: '9f8e7d6c5b4a3a21000000000000000000000000',
                  fixHeadSha: 'a1b2c3d4e5f6a7b8000000000000000000000000',
                  diffPath: 'artifacts/independent-review-2/review-loop-2/fix-delta.diff',
                  diffHash: 'fix-delta-hash',
                  diffStat: { files: 2, additions: 12, deletions: 0 },
                  capturedAt: new Date(now - 5 * 60000).toISOString(),
                },
                taskProgressArtifactPath:
                  'tasks/fix-bug/proj-2501/artifacts/independent-review-2/review-loop-2/self-review.md',
                startedAt: new Date(now - 8 * 60000).toISOString(),
                completedAt: new Date(now - 3 * 60000).toISOString(),
                artifactPaths: [
                  'artifacts/independent-review-2.json',
                  'artifacts/independent-review-2.md',
                  'artifacts/independent-review-2/review-loop-1/review.diff',
                  'artifacts/independent-review-2/review-loop-2/fix-delta.diff',
                  'artifacts/independent-review-2/review-loop-2/self-review.md',
                ],
              },
            ],
            gatePolicy: {
              owner: 'human',
              dispatchMode: 'autonomous',
              publishAuthority: 'human',
              reason: 'v1 autonomous fix-bug runs still require human publication approval',
            },
            publicationTarget: 'ready',
            publicationStatus: 'not_published',
          },
        },
      ],
      metrics: { nudgeCount: 1, model: 'sonnet', runner: 'claude' },
      agentContexts: [
        {
          id: 'fix-bug',
          role: 'fix-bug',
          label: 'Bugfix',
          status: 'working',
          slotId: 'runner-local-mobile-1',
          runId: 'pipe-mid-monitor',
          taskFile: '.task/fix/PROJ-2501/TASK.md',
          signalFile: '.task/fix/PROJ-2501/SIGNAL.json',
          runner: 'claude',
          model: 'sonnet',
          nudgeCount: 1,
          target: { session: 'example-1', window: 'bugfix', target: 'example-1:bugfix' },
        },
        {
          id: 'rev-codex',
          role: 'self-review',
          label: 'Self-review',
          status: 'working',
          slotId: 'runner-local-mobile-1',
          runId: 'pipe-mid-monitor',
          taskFile: '.task/fix/PROJ-2501/SELF-REVIEW.md',
          signalFile: '.task/fix/PROJ-2501/SELF-REVIEW-SIGNAL.json',
          runner: 'codex',
          model: 'gpt-5',
          updatedAt: '2026-07-09T12:01:00Z',
          target: {
            session: 'example-1',
            window: 'rev-codex',
            target: 'example-1:rev-codex',
          },
        },
        {
          id: 'rev-claude',
          role: 'self-review',
          label: 'Self-review',
          status: 'complete',
          slotId: 'runner-local-mobile-1',
          runId: 'pipe-mid-monitor',
          taskFile: '.task/fix/PROJ-2501/SELF-REVIEW.md',
          signalFile: '.task/fix/PROJ-2501/SELF-REVIEW-SIGNAL.json',
          runner: 'claude',
          model: 'opus',
          updatedAt: '2026-07-09T12:02:00Z',
          target: {
            session: 'example-1',
            window: 'rev-claude',
            target: 'example-1:rev-claude',
          },
        },
        {
          id: 'ci-fix',
          role: 'ci-fix',
          label: 'CI fix',
          status: 'waiting',
          slotId: 'runner-local-mobile-1',
          runId: 'pipe-mid-monitor',
          taskFile: '.task/fix/PROJ-2501/CI-FIX.md',
          signalFile: '.task/fix/PROJ-2501/CI-FIX-SIGNAL.json',
          runner: 'claude',
          model: 'sonnet',
          target: { session: 'example-1', window: 'ci-fix', target: 'example-1:ci-fix' },
        },
      ],
      createdAt: new Date(now - 50 * 60000).toISOString(),
      updatedAt: new Date(now - 2 * 60000).toISOString(),
    },
    // 2. Blocked: fix-bug with pending decision
    {
      id: 'pipe-blocked',
      familyId: 'pipe-blocked',
      flowType: 'fix-bug',
      status: 'blocked',
      project: 'example-mobile',
      ticketOrPr: 'PROJ-2510',
      slotId: 'runner-a-example-1',
      branch: null,
      taskFile: null,
      steps: [
        { name: 'grade', status: 'done', durationMs: 22000 },
        { name: 'find-slot', status: 'done', durationMs: 5000 },
        { name: 'write-task', status: 'pending' },
        { name: 'prepare', status: 'pending' },
        { name: 'dispatch', status: 'pending' },
        { name: 'monitor', status: 'pending' },
        { name: 'self-review', status: 'pending' },
        { name: 'complete', status: 'pending' },
        { name: 'human-gate', status: 'pending' },
        { name: 'finalize', status: 'pending' },
        { name: 'ci-watch', status: 'pending' },
      ],
      decisions: [
        {
          id: 'dec-collision',
          type: 'collision_check',
          title: 'Slot collision',
          description: 'runner-a-example-1 has uncommitted work on branch fix/proj-2499',
          actions: [
            { id: 'force', label: 'Force', style: 'danger' },
            { id: 'skip', label: 'Skip', style: 'secondary' },
            { id: 'wait', label: 'Wait', style: 'primary' },
          ],
          createdAt: new Date(now - 3 * 60000).toISOString(),
        },
      ],
      metrics: { nudgeCount: 0, model: 'sonnet', runner: 'claude' },
      createdAt: new Date(now - 5 * 60000).toISOString(),
      updatedAt: new Date(now - 3 * 60000).toISOString(),
    },
    // 3. Completed: fix-bug, all done with ci-watch
    {
      id: 'pipe-completed',
      familyId: 'pipe-completed',
      flowType: 'fix-bug',
      status: 'done',
      project: 'example-mobile',
      ticketOrPr: 'PROJ-2499',
      slotId: 'runner-a-example-2',
      branch: 'fix/proj-2499',
      taskFile: 'tasks/PROJ-2499.md',
      steps: [
        { name: 'grade', status: 'done', durationMs: 15000 },
        { name: 'find-slot', status: 'done', durationMs: 6000 },
        { name: 'write-task', status: 'done', durationMs: 38000 },
        { name: 'prepare', status: 'done', durationMs: 280000 },
        { name: 'dispatch', status: 'done', durationMs: 10000 },
        { name: 'monitor', status: 'done', durationMs: 2400000 },
        {
          name: 'self-review',
          status: 'done',
          durationMs: 185000,
          outputs: { verdict: 'pass', issues: [], retryCount: 0 },
        },
        {
          name: 'complete',
          status: 'done',
          durationMs: 45000,
          outputs: {
            prNumber: 27906,
            ciRepo: 'AcmeOrg/acme-mobile',
            artifactsCopied: true,
            prCommentPosted: true,
            prTitleUpdated: true,
            prMarkedReady: true,
            retrospectiveCreated: false,
            slotDisposition: 'ci-watch',
            artifacts: [],
          },
        },
        {
          name: 'human-gate',
          status: 'done',
          durationMs: 30000,
          outputs: { resolvedAction: 'ready', waitDurationMs: 30000 },
        },
        {
          name: 'finalize',
          status: 'done',
          durationMs: 8000,
          outputs: {
            commentPosted: true,
            metricsSavedToTask: true,
            costEstimate: 2.47,
            model: 'sonnet',
            runner: 'claude',
            session: {
              inputTokens: 45200,
              outputTokens: 12800,
              totalTokens: 58000,
              costUsd: 2.47,
              model: 'sonnet',
              sessionDurationMs: 2400000,
              numCompactions: 3,
              numTurns: 42,
            },
            artifactPath: 'artifacts/session-metrics.json',
          },
        },
        { name: 'ci-watch', status: 'done', durationMs: 900000 },
      ],
      grade: {
        difficulty: 'medium',
        rationale: 'Standard state management fix',
        modelRecommendation: 'sonnet',
        score: 4,
      },
      decisions: [
        {
          id: 'dec-gate',
          type: 'engine_human_gate',
          title: 'Run pipe-completed — ready check',
          description: 'Worker finished, branch fix/proj-2499',
          actions: [
            { id: 'ready', label: 'Mark Ready', style: 'primary' },
            { id: 'hold', label: 'Hold', style: 'secondary' },
          ],
          createdAt: new Date(now - 62 * 60000).toISOString(),
          resolvedAt: new Date(now - 61 * 60000).toISOString(),
          resolvedAction: 'ready',
          selectionData: { comment: 'LGTM, nice fix' },
        },
        {
          id: 'dec-retro',
          type: 'retrospective',
          title: 'Run retrospective',
          description: 'Clean run, 0 nudges, all CI green',
          actions: [
            { id: 'accept', label: 'Accept', style: 'primary' },
            { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
          ],
          createdAt: new Date(now - 70 * 60000).toISOString(),
          resolvedAt: new Date(now - 69 * 60000).toISOString(),
          resolvedAction: 'accept',
        },
      ],
      metrics: {
        nudgeCount: 0,
        model: 'sonnet',
        runner: 'claude',
        outcome: 'success',
        durationMs: 3694000,
        costEstimate: 2.47,
      },
      createdAt: new Date(now - 120 * 60000).toISOString(),
      updatedAt: new Date(now - 58 * 60000).toISOString(),
      completedAt: new Date(now - 58 * 60000).toISOString(),
    },
    // 4. Early-stage: review-pr, preparing
    {
      id: 'pipe-early',
      familyId: 'pipe-early',
      flowType: 'review-pr',
      status: 'preparing',
      project: 'example-mobile',
      ticketOrPr: '#27888',
      slotId: 'runner-local-mobile-2',
      branch: null,
      taskFile: null,
      steps: [
        { name: 'grade', status: 'skipped' },
        { name: 'find-slot', status: 'done', durationMs: 4000 },
        { name: 'prepare', status: 'running', startedAt: new Date(now - 3 * 60000).toISOString() },
        { name: 'dispatch', status: 'pending' },
        { name: 'monitor', status: 'pending' },
        { name: 'complete', status: 'pending' },
      ],
      decisions: [],
      metrics: { nudgeCount: 0, model: 'sonnet', runner: 'claude' },
      createdAt: new Date(now - 5 * 60000).toISOString(),
      updatedAt: new Date(now - 1 * 60000).toISOString(),
    },
    // 5. Failed: dev, prepare failed
    {
      id: 'pipe-failed',
      familyId: 'pipe-failed',
      flowType: 'dev',
      status: 'failed',
      project: 'example-audio',
      ticketOrPr: 'AUD-42',
      slotId: 'runner-local-audio-1',
      branch: 'feat/aud-42',
      taskFile: 'tasks/AUD-42.md',
      steps: [
        { name: 'find-slot', status: 'done', durationMs: 25000 },
        { name: 'write-task', status: 'done', durationMs: 30000 },
        { name: 'prepare', status: 'failed', detail: 'yarn install failed: lockfile conflict' },
        { name: 'dispatch', status: 'pending' },
        { name: 'monitor', status: 'pending' },
        { name: 'complete', status: 'pending' },
      ],
      decisions: [],
      metrics: {
        nudgeCount: 0,
        model: 'opus',
        runner: 'claude',
        outcome: 'failure',
        durationMs: 185000,
      },
      createdAt: new Date(now - 180 * 60000).toISOString(),
      updatedAt: new Date(now - 177 * 60000).toISOString(),
      completedAt: new Date(now - 177 * 60000).toISOString(),
      error: 'yarn install failed: lockfile conflict',
    },
    // 6. Self-review running: fix-bug, mid-review with progress
    {
      id: 'pipe-self-review-running',
      familyId: 'pipe-self-review-running',
      flowType: 'fix-bug',
      status: 'self-reviewing',
      project: 'example-mobile',
      ticketOrPr: 'PROJ-2520',
      slotId: 'runner-local-mobile-3',
      branch: 'fix/proj-2520',
      taskFile: 'tasks/PROJ-2520.md',
      steps: [
        { name: 'grade', status: 'done', durationMs: 14000 },
        { name: 'find-slot', status: 'done', durationMs: 5000 },
        { name: 'write-task', status: 'done', durationMs: 40000 },
        { name: 'prepare', status: 'done', durationMs: 220000 },
        { name: 'dispatch', status: 'done', durationMs: 11000 },
        { name: 'monitor', status: 'done', durationMs: 1800000 },
        {
          name: 'self-review',
          status: 'running',
          startedAt: new Date(now - 3 * 60000).toISOString(),
          detail: 'Review: 7/11 steps',
        },
        { name: 'complete', status: 'pending' },
        { name: 'human-gate', status: 'pending' },
        { name: 'finalize', status: 'pending' },
        { name: 'ci-watch', status: 'pending' },
      ],
      grade: {
        difficulty: 'medium',
        rationale: 'Icon naming fix',
        modelRecommendation: 'sonnet',
        score: 3,
      },
      decisions: [],
      metrics: { nudgeCount: 0, model: 'sonnet', runner: 'claude' },
      createdAt: new Date(now - 40 * 60000).toISOString(),
      updatedAt: new Date(now - 1 * 60000).toISOString(),
    },
    // 7. Self-review done with issues + retry: fix-bug, now in complete step
    {
      id: 'pipe-self-review-issues',
      familyId: 'pipe-self-review-issues',
      flowType: 'fix-bug',
      status: 'completing',
      project: 'example-mobile',
      ticketOrPr: 'PROJ-2368',
      slotId: 'runner-local-mobile-3',
      branch: 'fix/proj-2368',
      taskFile: 'tasks/PROJ-2368.md',
      steps: [
        { name: 'grade', status: 'done', durationMs: 12000 },
        { name: 'find-slot', status: 'done', durationMs: 4000 },
        { name: 'write-task', status: 'done', durationMs: 35000 },
        { name: 'prepare', status: 'done', durationMs: 200000 },
        { name: 'dispatch', status: 'done', durationMs: 9000 },
        { name: 'monitor', status: 'done', durationMs: 2500000 },
        {
          name: 'self-review',
          status: 'done',
          durationMs: 620000,
          detail: 'Fix: 11/11 steps',
          outputs: {
            verdict: 'issues',
            issues: [
              {
                file: 'PerpsFlipPositionConfirmSheet.test.tsx',
                line: 238,
                description: 'Stale mock entry',
              },
              {
                file: 'PerpsOrderHeader.test.tsx',
                line: 85,
                description: 'Hardcoded testID string',
              },
              {
                file: 'PerpsFlipPositionConfirmSheet.test.tsx',
                description: 'No ArrowRight assertion',
              },
              { file: 'PerpsAdjustMarginView.test.tsx', description: 'No icon assertions' },
            ],
            retryCount: 1,
            feedbackSent: true,
          },
        },
        { name: 'complete', status: 'running', startedAt: new Date(now - 1 * 60000).toISOString() },
        { name: 'human-gate', status: 'pending' },
        { name: 'finalize', status: 'pending' },
        { name: 'ci-watch', status: 'pending' },
      ],
      grade: {
        difficulty: 'low',
        rationale: 'Icon name replacement',
        modelRecommendation: 'sonnet',
        score: 2,
      },
      decisions: [],
      metrics: { nudgeCount: 0, model: 'sonnet', runner: 'claude' },
      createdAt: new Date(now - 55 * 60000).toISOString(),
      updatedAt: new Date(now - 1 * 60000).toISOString(),
    },
    // 8. Publish gate requested an optional independent review after initial package
    {
      id: 'pipe-gate-extra-review',
      familyId: 'pipe-gate-extra-review',
      flowType: 'fix-bug',
      status: 'human-gating',
      project: 'example-mobile',
      ticketOrPr: 'PROJ-2601',
      slotId: 'runner-local-mobile-2',
      branch: 'fix/proj-2601',
      taskFile: 'tasks/PROJ-2601.md',
      steps: [
        { name: 'grade', status: 'done', durationMs: 12000 },
        { name: 'find-slot', status: 'done', durationMs: 4000 },
        { name: 'write-task', status: 'done', durationMs: 35000 },
        { name: 'prepare', status: 'done', durationMs: 200000 },
        { name: 'dispatch', status: 'done', durationMs: 9000 },
        { name: 'monitor', status: 'done', durationMs: 1800000 },
        {
          name: 'self-review',
          status: 'done',
          durationMs: 260000,
          outputs: { verdict: 'pass', issues: [] },
        },
        {
          name: 'complete',
          status: 'done',
          durationMs: 45000,
          outputs: {
            packageHash: 'def456abc123def456abc123def456abc123def456abc123def456abc123def4',
            reviewSatisfied: false,
            publicationStatus: 'not_published',
          },
        },
        {
          name: 'human-gate',
          status: 'running',
          startedAt: new Date(now - 2 * 60000).toISOString(),
          detail: 'Running human-gate cursor review (1/1)...',
        },
        { name: 'finalize', status: 'pending' },
        { name: 'ci-watch', status: 'pending' },
      ],
      engineState: {
        publishGate: {
          reviewDepth: {
            minimumIndependentReviews: 1,
            extraLoopsRequested: 1,
            requireCrossRunner: true,
            requestedBy: 'human-gate',
          },
          pendingReviewPlan: [{ order: 1, runner: 'cursor' }],
          independentReviews: [
            {
              id: 'independent-review-1',
              source: 'dispatch',
              runner: 'codex',
              model: 'gpt-5.5',
              crossRunner: true,
              loopNumber: 2,
              verdict: 'pass',
              unresolvedCount: 0,
              feedbackSent: true,
              taskProgressArtifactPath:
                'tasks/fix-bug/proj-2601/artifacts/independent-review-1/review-loop-1/self-review.md',
              startedAt: new Date(now - 9 * 60000).toISOString(),
              completedAt: new Date(now - 5 * 60000).toISOString(),
              timeline: [
                {
                  kind: 'review',
                  loopNumber: 1,
                  runner: 'codex',
                  model: 'gpt-5.5',
                  startedAt: new Date(now - 9 * 60000).toISOString(),
                  completedAt: new Date(now - 8 * 60000).toISOString(),
                  durationMs: 60_000,
                },
                {
                  kind: 'worker-fix',
                  loopNumber: 2,
                  runner: 'claude',
                  model: 'sonnet',
                  startedAt: new Date(now - 8 * 60000).toISOString(),
                  completedAt: new Date(now - 6 * 60000).toISOString(),
                  durationMs: 120_000,
                },
                {
                  kind: 're-review',
                  loopNumber: 2,
                  runner: 'codex',
                  model: 'gpt-5.5',
                  startedAt: new Date(now - 6 * 60000).toISOString(),
                  completedAt: new Date(now - 5 * 60000).toISOString(),
                  durationMs: 60_000,
                },
              ],
              artifactPaths: ['artifacts/independent-review-1/review-loop-1/self-review.md'],
            },
          ],
        },
      },
      decisions: [
        {
          id: 'dec-extra-review',
          type: 'engine_human_gate',
          title: 'Run pipe-gate-extra-review — publish gate',
          description: 'Operator requested one more independent review before publication.',
          actions: [
            { id: 'approve-publish', label: 'Approve Publish', style: 'primary' },
            { id: 'request-extra-review', label: 'Request Extra Review', style: 'secondary' },
          ],
          createdAt: new Date(now - 4 * 60000).toISOString(),
          resolvedAt: new Date(now - 3 * 60000).toISOString(),
          resolvedAction: 'request-extra-review',
        },
      ],
      metrics: { nudgeCount: 0, model: 'sonnet', runner: 'claude' },
      createdAt: new Date(now - 55 * 60000).toISOString(),
      updatedAt: new Date(now - 1 * 60000).toISOString(),
    },
  ].map((run) => ({ lane: 'production', variant: null, ...run }) as Run);
}

export function mockRecipeProvenanceScenarios(): RecipeProvenanceScenario[] {
  const now = new Date().toISOString();
  const baseRun = {
    familyId: 'family-recipe-provenance',
    lane: 'production' as const,
    variant: null,
    flowType: 'dev' as const,
    mode: 'interactive' as const,
    status: 'monitoring' as const,
    project: 'example-mobile',
    ticketOrPr: 'DEV-RECIPE-PROVENANCE',
    slotId: 'runner-local-mobile-1',
    branch: 'feat/recipe-provenance',
    taskFile: 'tasks/DEV-RECIPE-PROVENANCE/TASK.md',
    steps: [
      { name: 'find-slot', status: 'done' as const, durationMs: 4000 },
      { name: 'write-task', status: 'done' as const, durationMs: 12000 },
      { name: 'prepare', status: 'done' as const, durationMs: 60000 },
      { name: 'dispatch', status: 'done' as const, durationMs: 5000 },
      { name: 'monitor', status: 'running' as const, startedAt: now },
      { name: 'complete', status: 'pending' as const },
    ],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'sonnet', runner: 'claude' },
    createdAt: now,
    updatedAt: now,
  };

  return [
    {
      id: 'decision-review',
      label: 'Decision-backed review',
      expectation:
        'Slot view should render the decision-backed recipe and keep pending review cues.',
      run: {
        ...baseRun,
        id: 'recipe-prov-decision',
        decisions: [
          {
            id: 'decision-review-1',
            type: 'engine_review_posting',
            title: 'Review posting',
            description: 'Decision-backed recipe context',
            actions: [{ id: 'post', label: 'Post', style: 'primary' }],
            createdAt: now,
            payload: {
              kind: 'review',
              prNumber: 28123,
              repo: 'AcmeOrg/acme-mobile',
              recommendation: 'APPROVE',
              reviewMd: 'Decision-backed review payload',
              lineComments: [],
              recipeJson: JSON.stringify({
                entry: 'decision',
                nodes: { decision: { action: 'assert', target: 'review', next: null } },
              }),
              workerLearnings:
                'Decision payload remains authoritative when no live recipe run is selected.',
            },
          },
        ],
      },
    },
    {
      id: 'live-recipe-run',
      label: 'Recipe-run backed live view',
      expectation:
        'Slot view should show live recipe-run artifacts even without any review/ready payload.',
      run: {
        ...baseRun,
        id: 'recipe-prov-live',
        liveRecipeContext: {
          source: 'recipe-run-artifacts',
          recipeRunId: 'recipe-run-live-1',
          artifactRoot: '/tmp/recipe-run-live-1',
          artifactManifest: [
            { path: 'artifacts/recipe.json', purpose: 'recipe' },
            { path: 'artifacts/artifact-manifest.json', purpose: 'artifact-manifest' },
            {
              path: 'artifacts/screenshots/live-proof',
              purpose: 'screenshot',
              type: 'screenshot',
              label: 'Live recipe proof screenshot',
              nodeId: 'live',
              mimeType: 'image/png',
            },
            {
              path: 'artifacts/summary.json',
              purpose: 'summary',
              type: 'summary',
              label: 'Live recipe summary',
            },
            { path: 'artifacts/review-loop-1/review.md', purpose: 'review' },
          ],
          usedTypedArtifactManifest: true,
          recipeJson: JSON.stringify({
            entry: 'live',
            nodes: { live: { action: 'assert', target: 'slot-view', next: null } },
          }),
          recipeQualityArtifact: null,
          qualityReport: null,
          workerLearnings:
            'Live recipe-run artifacts should light up slot-view before any decision exists.',
          isStale: false,
          selectionReason: 'latest-run',
        },
      },
    },
    {
      id: 'decision-vs-live-divergence',
      label: 'Decision vs live divergence',
      expectation:
        'Slot view should prefer the selected recipe-run values and provenance cue, not the decision copy.',
      run: {
        ...baseRun,
        id: 'recipe-prov-divergence',
        decisions: [
          {
            id: 'decision-review-divergence',
            type: 'engine_review_posting',
            title: 'Review posting',
            description: 'Decision and live recipe diverge',
            actions: [{ id: 'post', label: 'Post', style: 'primary' }],
            createdAt: now,
            payload: {
              kind: 'review',
              prNumber: 28124,
              repo: 'AcmeOrg/acme-mobile',
              recommendation: 'APPROVE',
              reviewMd: 'Decision payload says fallback artifact',
              lineComments: [],
              recipeJson: JSON.stringify({
                entry: 'decision-fallback',
                nodes: { fallback: { action: 'assert', target: 'final-artifacts', next: null } },
              }),
              workerLearnings: 'Decision payload lags behind the selected live rerun.',
            },
          },
        ],
        liveRecipeContext: {
          source: 'recipe-run-artifacts',
          recipeRunId: 'recipe-run-divergent',
          artifactRoot: '/tmp/recipe-run-divergent',
          artifactManifest: [{ path: 'artifacts/recipe.json', purpose: 'recipe' }],
          recipeJson: JSON.stringify({
            entry: 'live-rerun',
            nodes: { rerun: { action: 'assert', target: 'selected-rerun', next: null } },
          }),
          recipeQualityArtifact: null,
          qualityReport: null,
          workerLearnings: 'Selected rerun differs from the decision-backed snapshot.',
          isStale: false,
          selectionReason: 'user-selected',
        },
      },
    },
    {
      id: 'stale-selection',
      label: 'Stale selected recipe run',
      expectation: 'Slot view should show an explicit stale warning and no silent fallback.',
      run: {
        ...baseRun,
        id: 'recipe-prov-stale',
        liveRecipeContext: {
          source: 'recipe-run-artifacts',
          recipeRunId: 'recipe-run-stale',
          artifactRoot: '/tmp/missing-recipe-run',
          artifactManifest: null,
          recipeJson: null,
          recipeQualityArtifact: null,
          qualityReport: null,
          workerLearnings: null,
          isStale: true,
          selectionReason: 'user-selected',
        },
      },
    },
    {
      id: 'no-recipe',
      label: 'No recipe evidence',
      expectation:
        'Slot view should not open the recipe drawer when neither decision nor live recipe evidence exists.',
      run: {
        ...baseRun,
        id: 'recipe-prov-empty',
      },
    },
  ];
}

// ─── Recipe mock data (3 scenarios for #dev/recipe-graph) ───

export function mockRecipes(): Array<{ label: string; recipe: unknown }> {
  return [
    {
      label: 'Linear — balance display check',
      recipe: {
        title: 'balance-display-check',
        workflow: {
          entry: 'navigate_portfolio',
          nodes: {
            navigate_portfolio: { action: 'navigate', target: 'portfolio', next: 'eval_balance' },
            eval_balance: {
              action: 'eval_ref',
              ref: 'getPortfolioBalance',
              save_as: 'balance',
              next: 'assert_nonzero',
            },
            assert_nonzero: {
              action: 'eval_ref',
              ref: 'assertBalanceNonZero',
              next: 'take_screenshot',
            },
            take_screenshot: { action: 'screenshot', name: 'portfolio-balance', next: 'end_pass' },
            end_pass: { action: 'end', status: 'pass' },
          },
        },
      },
    },
    {
      label: 'Branching switch — send flow validation',
      recipe: {
        title: 'send-flow-validation',
        workflow: {
          entry: 'navigate_send',
          nodes: {
            navigate_send: { action: 'navigate', target: 'send', next: 'get_form_state' },
            get_form_state: {
              action: 'eval_ref',
              ref: 'getSendFormState',
              save_as: 'form_state',
              next: 'check_ready',
            },
            check_ready: {
              action: 'switch',
              cases: [
                {
                  label: 'ready',
                  when: { field: 'form_state', operator: 'equals', value: 'ready' },
                  next: 'fill_and_submit',
                },
                {
                  label: 'error',
                  when: { field: 'form_state', operator: 'equals', value: 'error' },
                  next: 'end_fail',
                },
              ],
              default: 'wait_load',
            },
            wait_load: { action: 'wait', duration: 2000, next: 'get_form_state' },
            fill_and_submit: {
              action: 'eval_ref',
              ref: 'fillAndSubmitSendForm',
              next: 'screenshot_result',
            },
            screenshot_result: { action: 'screenshot', name: 'send-result', next: 'end_pass' },
            end_pass: { action: 'end', status: 'pass' },
            end_fail: { action: 'end', status: 'fail' },
          },
        },
      },
    },
    {
      label: 'Retry loop — wallet unlock',
      recipe: {
        title: 'wallet-unlock-flow',
        workflow: {
          entry: 'attempt_unlock',
          nodes: {
            attempt_unlock: { action: 'eval_ref', ref: 'unlockWallet', next: 'check_unlock' },
            check_unlock: {
              action: 'eval_ref',
              ref: 'isWalletUnlocked',
              save_as: 'unlocked',
              next: 'branch_unlock',
            },
            branch_unlock: {
              action: 'switch',
              cases: [
                {
                  label: 'unlocked',
                  when: { field: 'unlocked', operator: 'equals', value: true },
                  next: 'screenshot_home',
                },
              ],
              default: 'retry_wait',
            },
            retry_wait: { action: 'wait', duration: 3000, next: 'attempt_unlock' },
            screenshot_home: { action: 'screenshot', name: 'wallet-home', next: 'end_pass' },
            end_pass: { action: 'end', status: 'pass' },
          },
        },
      },
    },
  ];
}

export function mockDecisions(): PendingDecision[] {
  return [
    {
      id: 'dec-001',
      type: 'plan_confirmation',
      slotId: 'runner-local-mobile-1',
      title: 'Confirm fix plan for PROJ-2501',
      description:
        'Worker proposes modifying SecurityManager.ts to fix keychain unlock race condition. 3 files changed.',
      context: { branch: 'fix/proj-2501', filesChanged: 3 },
      actions: [
        { id: 'approve', label: 'Approve Plan', style: 'primary' },
        { id: 'reject', label: 'Reject', style: 'danger' },
        { id: 'modify', label: 'Modify', style: 'secondary' },
      ],
      createdAt: new Date(Date.now() - 5 * 60000).toISOString(),
    },
    {
      id: 'dec-002',
      type: 'review_posting',
      slotId: 'runner-a-example-1',
      title: 'Post review for PR #27888',
      description: 'Review complete: 2 inline comments, 1 suggestion. Ready to post as COMMENT.',
      context: { pr: 27888, comments: 2, suggestions: 1 },
      actions: [
        { id: 'post', label: 'Post Review', style: 'primary' },
        { id: 'edit', label: 'Edit First', style: 'secondary' },
        { id: 'discard', label: 'Discard', style: 'danger' },
      ],
      createdAt: new Date(Date.now() - 2 * 60000).toISOString(),
    },
    {
      id: 'dec-003',
      type: 'blocked_alert',
      slotId: 'runner-b-mobile-1',
      title: 'Slot runner-b-mobile-1 unreachable',
      description: 'SSH connection failed 3 times. Machine may be offline.',
      context: { lastSeen: new Date(Date.now() - 3600000).toISOString() },
      actions: [
        { id: 'retry', label: 'Retry', style: 'primary' },
        { id: 'disable', label: 'Disable Slot', style: 'danger' },
      ],
      createdAt: new Date(Date.now() - 15 * 60000).toISOString(),
    },
    {
      id: 'dec-imp-001',
      type: 'improvement',
      slotId: 'runner-mobile-1',
      title: 'Template improvement proposed',
      description:
        'Based on worker learning: "Step 8 should check if metro is running before attempting reload"',
      context: {},
      payload: {
        kind: 'improvement',
        learningContent:
          'Step 8 should check if metro is running before attempting reload. When metro crashes mid-task, the reload command hangs for 60s before timing out. Adding a health check before reload would save time and provide a clearer error message.',
        rationale:
          'Adds a metro health check before reload in step 8. This prevents a 60s hang when metro has crashed, giving the worker an immediate signal to restart metro instead.',
        proposedChanges: [
          {
            filePath: 'projects/example-mobile-farm/templates/worker/fix-bug.md',
            before:
              '8. Reload the app to verify your changes:\n   ```bash\n   yarn a:reload\n   ```',
            after:
              '8. Check metro is running, then reload the app:\n   ```bash\n   # Verify metro is alive before reload (avoids 60s hang if crashed)\n   curl -sf http://localhost:{{port}}/status || { echo "Metro not running — restart with yarn watch"; exit 1; }\n   yarn a:reload\n   ```',
          },
        ],
        sourceRunId: 'run-abc123',
        project: 'example-mobile-farm',
      },
      actions: [
        { id: 'apply', label: 'Apply', style: 'primary' },
        { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
      ],
      createdAt: new Date(Date.now() - 1 * 60000).toISOString(),
    },
    {
      id: 'dec-retro-001',
      type: 'retrospective',
      slotId: 'runner-mobile-2',
      title: 'Run def456 retrospective — PROJ-2942',
      description:
        'Worker completed fix-bug flow. 2 nudges, 1 retry. Report: fixed perps market list view rendering.',
      context: {},
      actions: [
        { id: 'accept', label: 'Accept', style: 'primary' },
        { id: 'rework', label: 'Rework', style: 'secondary' },
        { id: 'dismiss', label: 'Dismiss', style: 'danger' },
      ],
      createdAt: new Date(Date.now() - 8 * 60000).toISOString(),
    },
  ];
}

export function mockFamilyObservabilitySnapshot(): FamilyObservabilitySnapshot {
  const generatedAt = new Date().toISOString();
  const footprint = (
    count: number,
    bytes: number,
    purpose: string,
    source: string,
    extension: string,
  ): FamilyArtifactFootprint => ({
    count,
    bytes,
    byPurpose: [{ key: purpose, count, bytes }],
    bySource: [{ key: source, count, bytes }],
    byExtension: [{ key: extension, count, bytes }],
  });
  const rootFootprint = footprint(3, 173000, 'screenshot', 'task-artifact', '.png');
  const reviewFootprint = footprint(2, 12400, 'input-diff', 'task-input', '.txt');
  const prCompleteFootprint = footprint(2, 2109000, 'diff', 'task-artifact', '.txt');
  return {
    familyId: 'family-proj-2501',
    familyRootTicketOrPr: 'PROJ-2501',
    project: 'example-mobile-farm',
    generatedAt,
    latestRunId: 'run-pr-complete',
    latestPrNumber: 27901,
    workflowState: 'complete',
    familyRunCount: 3,
    activeRunCount: 0,
    summary:
      'SecureKeychain race fix completed across implementation, review, and PR-complete follow-up.',
    diffStat: { files: 4, additions: 58, deletions: 11, available: true, runId: 'run-root' },
    familyChangeLedger: {
      summary: {
        runsWithDiff: 3,
        runsMissingDiff: 0,
        runsWithContributionDiff: 2,
        runsWithReviewInputDiff: 1,
        runsWithEmptyReviewInputDiff: 0,
        runsWithUnavailableReviewInputDiff: 0,
        totalContributionFiles: 6,
        totalContributionAdditions: 68,
        totalContributionDeletions: 12,
        reviewRounds: 1,
        bugbotFindingsAddressed: 2,
        humanReviewersRequestingChanges: 1,
        humanCommentsAddressed: 1,
        artifactFootprint: {
          count: 7,
          bytes: 2294400,
          byPurpose: [
            { key: 'video-after', count: 1, bytes: 2100000 },
            { key: 'screenshot', count: 3, bytes: 173000 },
            { key: 'input-diff', count: 2, bytes: 12400 },
            { key: 'diff', count: 1, bytes: 9000 },
          ],
          bySource: [
            { key: 'task-artifact', count: 5, bytes: 2282000 },
            { key: 'task-input', count: 2, bytes: 12400 },
          ],
          byExtension: [
            { key: '.mp4', count: 1, bytes: 2100000 },
            { key: '.png', count: 3, bytes: 173000 },
            { key: '.txt', count: 2, bytes: 21400 },
          ],
        },
      },
      entries: [
        {
          runId: 'run-root',
          familyId: 'family-proj-2501',
          parentRunId: null,
          familyRootTicketOrPr: 'PROJ-2501',
          lane: 'production',
          variant: null,
          flowType: 'fix-bug',
          project: 'example-mobile-farm',
          ticketOrPr: 'PROJ-2501',
          branch: 'fix/proj-2501',
          prNumber: 27901,
          createdAt: generatedAt,
          completedAt: generatedAt,
          changeKind: 'contribution',
          contributionDiff: {
            source: 'artifact',
            available: true,
            files: 4,
            additions: 58,
            deletions: 11,
            kind: 'contribution',
            artifactPath: 'artifacts/diff.txt',
            baseRef: 'main',
            baseSha: 'base123',
            headRef: 'fix/proj-2501',
            headSha: 'abc123',
            capturedAt: generatedAt,
          },
          artifactFootprint: rootFootprint,
          taskInputArtifacts: [],
          missingData: [],
        },
        {
          runId: 'run-review',
          familyId: 'family-proj-2501',
          parentRunId: 'run-root',
          familyRootTicketOrPr: 'PROJ-2501',
          lane: 'production',
          variant: null,
          flowType: 'review-pr',
          project: 'example-mobile-farm',
          ticketOrPr: 'example-org/example-mobile#27901',
          branch: 'fix/proj-2501',
          prNumber: 27901,
          createdAt: generatedAt,
          completedAt: generatedAt,
          changeKind: 'review-input',
          contributionDiff: {
            source: 'unavailable',
            available: false,
            files: 0,
            additions: 0,
            deletions: 0,
            kind: 'review-input',
            missingReason: 'review-run-no-contribution',
            capturedAt: generatedAt,
          },
          inputDiff: {
            source: 'artifact',
            available: true,
            files: 4,
            additions: 58,
            deletions: 11,
            kind: 'review-input',
            artifactPath: 'inputs/diff.txt',
            baseRef: 'main',
            baseSha: 'base123',
            headRef: 'fix/proj-2501',
            headSha: 'abc123',
            capturedAt: generatedAt,
          },
          inputCommit: {
            repository: 'example-org/example-mobile',
            prNumber: 27901,
            baseRef: 'main',
            baseSha: 'base123',
            headRef: 'fix/proj-2501',
            headSha: 'abc123',
            capturedAt: generatedAt,
            source: 'github-pr',
          },
          artifactFootprint: reviewFootprint,
          taskInputArtifacts: [
            {
              runId: 'run-review',
              familyId: 'family-proj-2501',
              path: 'inputs/diff.txt',
              purpose: 'input-diff',
              source: 'task-input',
            },
            {
              runId: 'run-review',
              familyId: 'family-proj-2501',
              path: 'inputs/commit.json',
              purpose: 'input-commit',
              source: 'task-input',
            },
          ],
          missingData: [],
        },
        {
          runId: 'run-pr-complete',
          familyId: 'family-proj-2501',
          parentRunId: 'run-root',
          familyRootTicketOrPr: 'PROJ-2501',
          lane: 'production',
          variant: null,
          flowType: 'pr-complete',
          project: 'example-mobile-farm',
          ticketOrPr: 'example-org/example-mobile#27901',
          branch: 'fix/proj-2501',
          prNumber: 27901,
          createdAt: generatedAt,
          completedAt: generatedAt,
          changeKind: 'follow-up',
          contributionDiff: {
            source: 'artifact',
            available: true,
            files: 2,
            additions: 10,
            deletions: 1,
            kind: 'contribution',
            artifactPath: 'artifacts/diff.txt',
            baseRef: 'main',
            baseSha: 'base123',
            headRef: 'fix/proj-2501',
            headSha: 'def456',
            capturedAt: generatedAt,
          },
          reviewSignals: {
            total: 4,
            real: 3,
            fixed: 3,
            botAddressed: 2,
            humanReviewersRequestingChanges: 1,
            humanCommentsAddressed: 1,
            unknownSource: 0,
          },
          artifactFootprint: prCompleteFootprint,
          taskInputArtifacts: [],
          missingData: ['recipe-json'],
        },
      ],
    },
    evidence: [
      {
        runId: 'run-root',
        familyId: 'family-proj-2501',
        path: 'artifacts/before.png',
        purpose: 'screenshot',
        source: 'task-artifact',
        sizeBytes: 82000,
      },
      {
        runId: 'run-root',
        familyId: 'family-proj-2501',
        path: 'artifacts/after.png',
        purpose: 'screenshot',
        source: 'task-artifact',
        sizeBytes: 91000,
      },
      {
        runId: 'run-pr-complete',
        familyId: 'family-proj-2501',
        path: 'artifacts/eval-after.png',
        purpose: 'screenshot',
        source: 'task-artifact',
        sizeBytes: 88000,
      },
      {
        runId: 'run-pr-complete',
        familyId: 'family-proj-2501',
        path: 'artifacts/after.mp4',
        purpose: 'video-after',
        source: 'task-artifact',
        sizeBytes: 2100000,
      },
    ],
    recipeQuality: {
      runId: 'run-root',
      semantic: 'good',
      score: 96,
      source: 'recipe-quality',
      reasoning: 'Canonical recipe-quality artifact recorded a passing verdict.',
    },
    learnings: [
      {
        id: 'learn-1',
        runId: 'run-root',
        source: 'worker-learnings',
        title: 'Worker learning',
        summary: 'Biometric prompt completion can race with keychain reads.',
        detail: 'Retry after biometric completion fixed the flake.',
        createdAt: generatedAt,
        severity: 'info',
      },
      {
        id: 'learn-2',
        runId: 'run-pr-complete',
        source: 'self-review',
        stepName: 'self-review',
        title: 'Self-review issue',
        summary: 'Missing zero-balance edge case test was added in follow-up.',
        createdAt: generatedAt,
        severity: 'warn',
      },
    ],
    runs: [
      {
        runId: 'run-root',
        familyId: 'family-proj-2501',
        parentRunId: null,
        flowType: 'fix-bug',
        lane: 'production',
        variant: null,
        status: 'done',
        project: 'example-mobile-farm',
        ticketOrPr: 'PROJ-2501',
        branch: 'fix/proj-2501',
        prNumber: 27901,
        summary: 'Root implementation of SecureKeychain retry handling',
        createdAt: generatedAt,
        updatedAt: generatedAt,
        completedAt: generatedAt,
        slotId: 'runner-local-mobile-1',
        workerReport:
          'Implemented retry handling around SecureKeychain.get() during biometric prompt completion.',
        workerLearnings: 'Retry handling should be centralized if reused elsewhere.',
        recipeJson: JSON.stringify({
          entry: 'start',
          nodes: {
            start: { action: 'tap', target: 'unlock', next: 'done' },
            done: { action: 'assert', target: 'wallet-loaded', next: null },
          },
        }),
        recipeQualityArtifact: {
          version: 1,
          verdict: 'pass',
          compact: {
            verdict: 'PASS',
            reasons: ['Used the real unlock flow and proved the success path.'],
            better_version_guidance: [],
          },
          dimensions: {},
          structural_findings: [],
          contextual_findings: [],
          suggested_recipe_delta: [],
          training_fields: {
            project: 'example-mobile-farm',
            flow_type: 'fix-bug',
            proof_mode: 'mixed',
          },
          meta: {
            producer: 'worker',
            fallback_used: false,
            legacy_task: false,
            artifact_required: true,
            source_signals: ['recipe-quality.json'],
          },
        },
        recipeQuality: {
          runId: 'run-root',
          semantic: 'good',
          score: 96,
          source: 'recipe-quality',
          reasoning: 'Canonical recipe-quality artifact recorded a passing verdict.',
        },
        diffStat: { files: 4, additions: 58, deletions: 11, available: true },
        artifacts: [
          {
            runId: 'run-root',
            familyId: 'family-proj-2501',
            path: 'artifacts/before.png',
            purpose: 'screenshot',
            source: 'task-artifact',
          },
          {
            runId: 'run-root',
            familyId: 'family-proj-2501',
            path: 'artifacts/after.png',
            purpose: 'screenshot',
            source: 'task-artifact',
          },
        ],
        learnings: [
          {
            id: 'learn-root',
            runId: 'run-root',
            source: 'worker-learnings',
            title: 'Worker learning',
            summary: 'Biometric prompt completion can race with keychain reads.',
            createdAt: generatedAt,
            severity: 'info',
          },
        ],
        steps: [
          {
            runId: 'run-root',
            stepName: 'write-task',
            status: 'done',
            durationMs: 24000,
            artifacts: [],
            learnings: [],
            missingData: [],
          },
          {
            runId: 'run-root',
            stepName: 'monitor',
            status: 'done',
            durationMs: 480000,
            artifacts: [
              {
                runId: 'run-root',
                familyId: 'family-proj-2501',
                stepName: 'monitor',
                path: 'artifacts/after.png',
                purpose: 'screenshot',
                source: 'step-output',
              },
            ],
            learnings: [],
            missingData: [],
          },
          {
            runId: 'run-root',
            stepName: 'complete',
            status: 'done',
            durationMs: 35000,
            artifacts: [
              {
                runId: 'run-root',
                familyId: 'family-proj-2501',
                stepName: 'complete',
                path: 'artifacts/recipe.json',
                purpose: 'recipe',
                source: 'step-output',
              },
            ],
            learnings: [],
            missingData: [],
          },
        ],
        acceptanceCriteria: [
          'Unlock succeeds after biometric prompt',
          'Recipe passes key happy path',
        ],
        ciChecks: [{ name: 'lint', status: 'completed', conclusion: 'success' }],
        selfReview: { verdict: 'pass', summary: null, issues: [] },
        familyScope: null,
        metrics: {
          nudgeCount: 1,
          model: 'sonnet',
          runner: 'claude',
          outcome: 'success',
          durationMs: 780000,
          costEstimate: 1.42,
          sessionTurns: 18,
          sessionInputTokens: 28400,
          sessionOutputTokens: 7200,
          sessionCacheCreation: 3100,
          sessionCacheRead: 14100,
          sessionTotalTokens: 35700,
          actualModel: 'claude-sonnet-4-6',
        },
        missingData: [],
      },
      {
        runId: 'run-review',
        familyId: 'family-proj-2501',
        parentRunId: 'run-root',
        flowType: 'review-pr',
        lane: 'production',
        variant: null,
        status: 'done',
        project: 'example-mobile-farm',
        ticketOrPr: 'example-org/example-mobile#27901',
        branch: 'fix/proj-2501',
        prNumber: 27901,
        summary: 'Review pass approved with one nit resolved later',
        createdAt: generatedAt,
        updatedAt: generatedAt,
        completedAt: generatedAt,
        slotId: 'runner-a-example-1',
        workerReport: null,
        workerLearnings: null,
        recipeJson: null,
        recipeQualityArtifact: null,
        recipeQuality: {
          runId: 'run-review',
          semantic: 'unknown',
          score: null,
          source: 'missing',
          reasoning: 'No recipe artifacts produced in review flow.',
        },
        diffStat: { files: 0, additions: 0, deletions: 0, available: false },
        artifacts: [],
        learnings: [],
        steps: [
          {
            runId: 'run-review',
            stepName: 'monitor',
            status: 'done',
            durationMs: 240000,
            artifacts: [],
            learnings: [],
            missingData: ['artifacts'],
          },
        ],
        acceptanceCriteria: [],
        ciChecks: [],
        selfReview: { verdict: null, summary: null, issues: [] },
        familyScope: null,
        missingData: ['worker-report', 'worker-learnings', 'recipe-json', 'diff-stat', 'artifacts'],
      },
      {
        runId: 'run-pr-complete',
        familyId: 'family-proj-2501',
        parentRunId: 'run-root',
        flowType: 'pr-complete',
        lane: 'production',
        variant: null,
        status: 'done',
        project: 'example-mobile-farm',
        ticketOrPr: 'example-org/example-mobile#27901',
        branch: 'fix/proj-2501',
        prNumber: 27901,
        summary: 'PR complete follow-up added missing edge-case coverage and closed the loop.',
        createdAt: generatedAt,
        updatedAt: generatedAt,
        completedAt: generatedAt,
        slotId: 'runner-local-mobile-2',
        workerReport: 'Added zero-balance test coverage and verified CI green.',
        workerLearnings: null,
        recipeJson: null,
        recipeQualityArtifact: {
          version: 1,
          verdict: 'warn',
          compact: {
            verdict: 'WARN',
            reasons: [
              'Follow-up relied on report fallback instead of a strong recipe-quality artifact.',
            ],
            better_version_guidance: ['Emit recipe-quality.json in follow-up review flows.'],
          },
          dimensions: {},
          structural_findings: [],
          contextual_findings: [],
          suggested_recipe_delta: [],
          training_fields: {
            project: 'example-mobile-farm',
            flow_type: 'pr-complete',
            proof_mode: 'unknown',
          },
          meta: {
            producer: 'gateway',
            fallback_used: true,
            fallback_source: 'fallback:report',
            legacy_task: true,
            artifact_required: false,
            source_signals: ['report.md'],
          },
        },
        recipeQuality: {
          runId: 'run-pr-complete',
          semantic: 'ok',
          score: null,
          source: 'recipe-quality',
          reasoning:
            'Gateway projected a warning recipe-quality verdict from fallback report data.',
        },
        diffStat: { files: 2, additions: 10, deletions: 1, available: true },
        artifacts: [
          {
            runId: 'run-pr-complete',
            familyId: 'family-proj-2501',
            path: 'artifacts/eval-after.png',
            purpose: 'screenshot',
            source: 'task-artifact',
          },
          {
            runId: 'run-pr-complete',
            familyId: 'family-proj-2501',
            path: 'artifacts/after.mp4',
            purpose: 'video-after',
            source: 'task-artifact',
          },
        ],
        learnings: [
          {
            id: 'learn-prc',
            runId: 'run-pr-complete',
            source: 'self-review',
            title: 'Self-review issue',
            summary: 'Missing zero-balance edge case test was added in follow-up.',
            createdAt: generatedAt,
            severity: 'warn',
          },
        ],
        steps: [
          {
            runId: 'run-pr-complete',
            stepName: 'self-review',
            status: 'done',
            durationMs: 120000,
            artifacts: [],
            learnings: [
              {
                id: 'learn-prc-step',
                runId: 'run-pr-complete',
                stepName: 'self-review',
                source: 'self-review',
                title: 'Self-review issue',
                summary: 'Missing zero-balance edge case test was added in follow-up.',
                createdAt: generatedAt,
                severity: 'warn',
              },
            ],
            missingData: [],
          },
        ],
        acceptanceCriteria: ['Edge-case tests added'],
        ciChecks: [{ name: 'CI', status: 'completed', conclusion: 'success' }],
        selfReview: {
          verdict: 'issues',
          summary: 'formatBalance.test.ts: Missing edge case for zero balance',
          issues: [
            {
              file: 'formatBalance.test.ts',
              line: 42,
              description: 'Missing edge case for zero balance',
            },
          ],
        },
        familyScope: {
          originalFamilyScopeSummary: 'Fix unlock race',
          currentTriggerSummary: 'PR complete follow-up',
          scopeVerdict: 'full-scope-addressed',
          notes: 'Follow-up preserved the original family scope.',
        },
        metrics: {
          nudgeCount: 0,
          model: 'sonnet',
          runner: 'claude',
          outcome: 'success',
          durationMs: 420000,
          costEstimate: 3.08,
          sessionTurns: 11,
          sessionInputTokens: 39200,
          sessionOutputTokens: 5200,
          sessionCacheCreation: 0,
          sessionCacheRead: 22600,
          sessionTotalTokens: 44400,
          actualModel: 'claude-opus-4-1',
        },
        missingData: ['recipe-json'],
      },
    ],
    experiments: [
      {
        experimentId: 'eval-template-regression',
        experimentKey: 'experiment-key-template-regression',
        familyId: 'family-proj-2501',
        taskProfile: 'fix-bug',
        rubricId: 'eval-default',
        rubricVersion: '1',
        case: {
          caseId: 'case-proj-2501',
          source: { kind: 'merged-pr', repo: 'example-org/example-mobile', prNumber: 27901 },
          taskProfile: 'fix-bug',
          objectiveHash: 'objective-template-regression',
          referencePackageId: 'pkg-reference',
          referencePackageHash: 'hash-reference',
          referencePackagePath: '/tmp/reference.result-package.json',
          label: 'merged PR reference',
        },
        candidateStrategies: [
          {
            strategyId: 'strategy-current-template',
            label: 'current bugfix template',
            candidateStrategyFingerprint: 'axis-current-template',
            axes: {
              template: { path: 'templates/worker/fix-bug.md', hash: 'current' },
              runner: { name: 'claude' },
              model: { name: 'sonnet' },
            },
          },
          {
            strategyId: 'strategy-proposed-template',
            label: 'proposed bugfix template',
            candidateStrategyFingerprint: 'axis-proposed-template',
            axes: {
              template: { path: 'templates/worker/fix-bug.md', hash: 'proposed' },
              runner: { name: 'claude' },
              model: { name: 'sonnet' },
            },
          },
        ],
        trials: [
          {
            trialId: 'trial-current-template',
            strategyId: 'strategy-current-template',
            caseId: 'case-proj-2501',
            status: 'final',
            runId: 'run-root',
            packageId: 'pkg-current-template',
            packageHash: 'hash-current-template',
            packagePath: '/tmp/current.result-package.json',
            missingData: [],
          },
          {
            trialId: 'trial-proposed-template',
            strategyId: 'strategy-proposed-template',
            caseId: 'case-proj-2501',
            status: 'final',
            runId: 'run-pr-complete',
            packageId: 'pkg-proposed-template',
            packageHash: 'hash-proposed-template',
            packagePath: '/tmp/proposed.result-package.json',
            missingData: ['recipe-json'],
          },
        ],
        packages: [
          {
            caseId: 'case-proj-2501',
            role: 'reference',
            label: 'merged PR reference',
            packageId: 'pkg-reference',
            packageHash: 'hash-reference',
            packagePath: '/tmp/reference.result-package.json',
            axes: {
              template: { path: 'templates/worker/fix-bug.md', hash: 'current' },
              runner: { name: 'claude' },
              model: { name: 'sonnet' },
            },
            status: 'final',
            diff: {
              source: 'artifact',
              available: true,
              files: 2,
              additions: 18,
              deletions: 3,
              kind: 'contribution',
            },
            metrics: { durationMs: 1800000, costEstimate: 2.42, sessionTurns: 8 },
            visualEvidenceCount: 2,
            validationEvidenceCount: 4,
            reviewEvidenceCount: 1,
            missingData: [],
          },
          {
            caseId: 'case-proj-2501',
            strategyId: 'strategy-current-template',
            trialId: 'trial-current-template',
            role: 'candidate',
            label: 'current bugfix template',
            packageId: 'pkg-current-template',
            packageHash: 'hash-current-template',
            packagePath: '/tmp/current.result-package.json',
            runId: 'run-root',
            candidateStrategyFingerprint: 'axis-current-template',
            axes: {
              template: { path: 'templates/worker/fix-bug.md', hash: 'current' },
              runner: { name: 'claude' },
              model: { name: 'sonnet' },
            },
            status: 'final',
            diff: {
              source: 'artifact',
              available: true,
              files: 3,
              additions: 24,
              deletions: 4,
              kind: 'contribution',
            },
            metrics: { durationMs: 2400000, costEstimate: 3.82, sessionTurns: 12 },
            visualEvidenceCount: 2,
            validationEvidenceCount: 5,
            reviewEvidenceCount: 1,
            missingData: [],
          },
          {
            caseId: 'case-proj-2501',
            strategyId: 'strategy-proposed-template',
            trialId: 'trial-proposed-template',
            role: 'candidate',
            label: 'proposed bugfix template',
            packageId: 'pkg-proposed-template',
            packageHash: 'hash-proposed-template',
            packagePath: '/tmp/proposed.result-package.json',
            runId: 'run-pr-complete',
            candidateStrategyFingerprint: 'axis-proposed-template',
            axes: {
              template: { path: 'templates/worker/fix-bug.md', hash: 'proposed' },
              runner: { name: 'claude' },
              model: { name: 'sonnet' },
            },
            status: 'final',
            diff: {
              source: 'artifact',
              available: true,
              files: 2,
              additions: 10,
              deletions: 1,
              kind: 'contribution',
            },
            metrics: { durationMs: 420000, costEstimate: 3.08, sessionTurns: 11 },
            visualEvidenceCount: 2,
            validationEvidenceCount: 3,
            reviewEvidenceCount: 1,
            missingData: ['recipe-json'],
          },
        ],
        missingData: ['recipe-json'],
        manifestPath: 'artifacts/experiment-manifest.json',
      },
    ],
    relatedByTicket: [],
    missingData: [],
  };
}

export function mockFamilyReport(): FamilyReport {
  return {
    generatedAt: new Date().toISOString(),
    status: 'generated',
    provider: 'openai-codex',
    model: 'gpt-5.5',
    content: {
      summary:
        'The family fixed the unlock race, validated it visually, and closed the remaining test gap in PR-complete.',
      evidenceHighlights: [
        'before.png vs after.png shows the unlock screen no longer stalls',
        'after.mp4 records the final happy-path validation',
      ],
      recipeAssessment: 'Recipe quality remained strong across the root fix and follow-up runs.',
      learnings: [
        'Biometric completion races should be retried before surfacing failure states.',
        'Self-review caught a missing edge-case test that the worker missed initially.',
      ],
      unresolvedGaps: ['Review flow did not emit a richer observability artifact set in v1.'],
    },
  };
}

export function mockSlotRunHistory(): SlotRunHistoryEntry[] {
  const now = Date.now();
  return [
    {
      runId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      familyId: 'family-proj-2501',
      status: 'monitoring',
      flowType: 'fix-bug',
      ticketOrPr: 'PROJ-2501',
      summary: 'Fix biometric unlock race',
      project: 'example-mobile-farm',
      branch: 'fix/proj-2501-biometric-race',
      createdAt: new Date(now - 45 * 60_000).toISOString(),
      updatedAt: new Date(now - 2 * 60_000).toISOString(),
      durationMs: 43 * 60_000,
      runner: 'claude',
      model: 'sonnet',
      runnerSessionId: 'claude-session-current',
      runnerSessionPath: '/Users/example/.claude/projects/example-app/current.jsonl',
      taskFile: '/Users/example/dev/farmslot/tasks/fix/PROJ-2501/TASK.md',
      taskDir: '/Users/example/dev/farmslot/tasks/fix/PROJ-2501',
      artifactDir: '/Users/example/dev/farmslot/tasks/fix/PROJ-2501/artifacts',
      prNumber: null,
      diffStat: { files: 2, additions: 18, deletions: 4, available: true },
      visualPairCount: 1,
      runRecordPath: '/Users/example/dev/farmslot/.runs/a1b2c3d4-e5f6-7890-abcd-ef1234567890.json',
      currentForSlot: true,
    },
    {
      runId: 'run-success-history',
      familyId: 'family-proj-2400',
      status: 'done',
      flowType: 'review-pr',
      ticketOrPr: 'example-org/example-mobile#2400',
      summary: 'Review perps order form validation',
      project: 'example-mobile-farm',
      branch: 'review/perps-order-form',
      createdAt: new Date(now - 26 * 60 * 60_000).toISOString(),
      updatedAt: new Date(now - 24 * 60 * 60_000).toISOString(),
      completedAt: new Date(now - 24 * 60 * 60_000).toISOString(),
      durationMs: 2 * 60 * 60_000,
      runner: 'codex',
      model: 'gpt-5.5',
      actualModel: 'gpt-5.5',
      runnerSessionId: 'codex-session-success',
      runnerSessionPath: '/Users/example/.codex/sessions/run-success-history.jsonl',
      taskFile: '/Users/example/dev/farmslot/tasks/review/2400/TASK.md',
      taskDir: '/Users/example/dev/farmslot/tasks/review/2400',
      artifactDir: '/Users/example/dev/farmslot/tasks/review/2400/artifacts',
      prNumber: 2400,
      diffStat: { files: 1, additions: 0, deletions: 0, available: true },
      visualPairCount: 0,
      runRecordPath: '/Users/example/dev/farmslot/.runs/run-success-history.json',
      currentForSlot: false,
    },
    {
      runId: 'run-failed-no-session',
      familyId: 'family-proj-2300',
      status: 'failed',
      flowType: 'fix-bug',
      ticketOrPr: 'PROJ-2300',
      summary: 'Failed setup before runner session was captured',
      project: 'example-mobile-farm',
      branch: 'fix/proj-2300',
      createdAt: new Date(now - 3 * 24 * 60 * 60_000).toISOString(),
      updatedAt: new Date(now - 3 * 24 * 60 * 60_000 + 12 * 60_000).toISOString(),
      completedAt: new Date(now - 3 * 24 * 60 * 60_000 + 12 * 60_000).toISOString(),
      durationMs: 12 * 60_000,
      runner: 'claude',
      model: 'sonnet',
      taskFile: '/Users/example/dev/farmslot/tasks/fix/PROJ-2300/TASK.md',
      taskDir: '/Users/example/dev/farmslot/tasks/fix/PROJ-2300',
      artifactDir: '/Users/example/dev/farmslot/tasks/fix/PROJ-2300/artifacts',
      prNumber: null,
      diffStat: { files: 0, additions: 0, deletions: 0, available: false },
      visualPairCount: 0,
      runRecordPath: '/Users/example/dev/farmslot/.runs/run-failed-no-session.json',
      currentForSlot: false,
    },
    {
      runId: 'run-model-drift',
      familyId: 'family-proj-2200',
      status: 'done',
      flowType: 'fix-bug',
      ticketOrPr: 'PROJ-2200',
      summary: 'Completed with actual model drift from sticky runner config',
      project: 'example-mobile-farm',
      branch: 'fix/proj-2200',
      createdAt: new Date(now - 5 * 24 * 60 * 60_000).toISOString(),
      updatedAt: new Date(now - 5 * 24 * 60 * 60_000 + 90 * 60_000).toISOString(),
      completedAt: new Date(now - 5 * 24 * 60 * 60_000 + 90 * 60_000).toISOString(),
      durationMs: 90 * 60_000,
      runner: 'claude',
      model: 'sonnet',
      actualModel: 'claude-opus-4-1',
      runnerSessionId: 'claude-session-drift',
      runnerSessionPath: '/Users/example/.claude/projects/example-app/drift.jsonl',
      taskFile: '/Users/example/dev/farmslot/tasks/fix/PROJ-2200/TASK.md',
      taskDir: '/Users/example/dev/farmslot/tasks/fix/PROJ-2200',
      artifactDir: '/Users/example/dev/farmslot/tasks/fix/PROJ-2200/artifacts',
      prNumber: null,
      diffStat: { files: 3, additions: 42, deletions: 9, available: true },
      visualPairCount: 2,
      runRecordPath: '/Users/example/dev/farmslot/.runs/run-model-drift.json',
      currentForSlot: false,
    },
  ];
}
