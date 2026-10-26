import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  type GitBranchDiffFile,
  Methods,
  type ReadyGatePayload,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';
import { ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import { FakeControllerHost } from '../../testing/fake-controller-host.js';
import { DiffTestFilterController } from '../shared/diff-test-filter-controller.js';

// Gateway stub: branch diffs per slot, and a file diff that names its slot so a
// stale diff from another run is visible in the assertion.
const branchFiles: Record<string, GitBranchDiffFile[]> = {};
const fileDiffRequests: string[] = [];
// Decision submission: the reply to run.resolveDecision, its requested window, and the run a
// later run.get reads.
let refreshReply: () => Promise<unknown> = async () => ({});
let resolveReply: () => Promise<unknown> = async () => ({});
const resolveWindows: unknown[] = [];
let gatewayDecision: { id: string; resolvedAt?: string; resolvedAction?: string } = { id: 'gate' };
let runReadable = true;
let queryReady = true;
let connection = 1;
mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: {
      connectionState: 'connected',
      connectionEpoch: 1,
      onConnectionChange: () => () => undefined,
      request: async (
        method: string,
        params: { slotId: string; path?: string },
        window?: unknown,
      ) => {
        if (method === Methods.RUN_REFRESH_PUBLISH_PACKAGE) return refreshReply();
        if (method === Methods.RUN_RESOLVE_DECISION) {
          resolveWindows.push(window);
          return resolveReply();
        }
        if (method === Methods.RUN_GET) assert.fail('The shared observation owns run reads');
        assert.fail(`The shared workspace observation owns ${method} reads (${params.slotId})`);
      },
    },
  },
});

// The import graph reads `location` at module load (global filters).
Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: new URL('http://localhost/'),
});

const { ReadyWorkspaceActionPresenter } = await import('./ready-workspace-action-presenter.js');
const { DECISION_RESOLVE_TIMEOUT_MS, GatewayRequestTimeoutError } =
  await import('../../gateway-request-timeout.js');

type Presenter = InstanceType<typeof ReadyWorkspaceActionPresenter>;

// The presenter is a LitElement; build it from the prototype so no DOM or
// render cycle is needed, and keep reactive setters and the hash write inert.
function makePresenter(fields: Partial<Presenter> = {}): Presenter {
  const view = Object.create(ReadyWorkspaceActionPresenter.prototype) as Presenter;
  Object.assign(view, {
    requestUpdate: () => undefined,
    _syncViewStateToHash: () => undefined,
    slotId: 'slot-a',
    _recoveryEpoch: 1,
    _diffFiles: [],
    _selectedFile: '',
    _fileDiff: '',
    _fileDiffLoading: false,
    ...fields,
  });
  Object.defineProperty(view, '_usesMockData', { value: false });
  Object.assign(view, {
    _reads: {
      async read<T>(
        method: string,
        params: { slotId: string; path?: string },
        apply: (value: T) => void,
      ) {
        const value = (
          method === Methods.GIT_BRANCH_DIFF
            ? { files: branchFiles[params.slotId] ?? [] }
            : (fileDiffRequests.push(`${params.slotId}:${params.path}`),
              { diff: `diff from ${params.slotId}` })
        ) as T;
        apply(value);
        return value;
      },
      releaseMethods: () => undefined,
      clear: () => undefined,
    },
    _queries: {
      get decision() {
        return view.decision;
      },
      get ready() {
        return queryReady;
      },
      requireDecision() {
        if (!queryReady) throw new Error('Wait for a current read before acting.');
        return view.decision;
      },
      run: {
        belongsToWorkspace: true,
        get ready() {
          return runReadable;
        },
        get state() {
          return { data: { run: view.run } };
        },
        retry: async () =>
          runReadable
            ? { status: 'ready', data: { run: { decisions: [gatewayDecision] } } }
            : { status: 'error' },
      },
      capture() {
        const owner = JSON.stringify([view.runId, view.slotId, view.decision?.id]);
        const currentConnection = connection;
        const ownsView = () =>
          owner === JSON.stringify([view.runId, view.slotId, view.decision?.id]);
        return { ownsView, current: () => ownsView() && currentConnection === connection };
      },
    },
  });
  // Field initializers do not run on a prototype-built view; wire the filter
  // the way the presenter does.
  Object.assign(view, {
    _testFilter: new DiffTestFilterController(new FakeControllerHost(), {
      patterns: () => view._diffTestPatterns,
      onChange: () => view._onHideTestsChanged(),
    }),
  });
  return view;
}

/** What the preference subscription does on a flip. */
function setHideTests(view: Presenter, hide: boolean): void {
  view._testFilter.hideTests = hide;
  view._onHideTestsChanged();
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const testFile = { path: 'src/gate.test.ts', status: 'M', additions: 3, deletions: 0 } as const;
const codeFile = { path: 'src/gate.ts', status: 'M', additions: 2, deletions: 1 } as const;

test('hiding tests hands a selected test file to the first visible file', () => {
  const selected: string[] = [];
  const view = makePresenter({
    _diffFiles: [testFile, codeFile],
    _selectedFile: testFile.path,
    _fileDiff: 'test diff',
  });
  view._selectFile = async (path: string) => {
    selected.push(path);
  };

  setHideTests(view, true);
  assert.deepEqual(selected, [codeFile.path]);
});

test('hiding tests when only tests changed drops the open test file and its diff', () => {
  const view = makePresenter({
    _diffFiles: [testFile],
    _selectedFile: testFile.path,
    _fileDiff: 'test diff',
  });
  view._selectFile = async () => {
    assert.fail('nothing is listed, so nothing is selected');
  };

  setHideTests(view, true);
  assert.equal(view._selectedFile, '');
  assert.equal(view._fileDiff, '');
});

test('a pref flip keeps a loaded visible selection and refetches one without a diff', () => {
  const selected: string[] = [];
  const view = makePresenter({
    _diffFiles: [testFile, codeFile],
    _selectedFile: codeFile.path,
    _fileDiff: 'code diff',
  });
  view._selectFile = async (path: string) => {
    selected.push(path);
  };

  setHideTests(view, true);
  assert.deepEqual(selected, []);

  view._fileDiff = '';
  setHideTests(view, false);
  assert.deepEqual(selected, [codeFile.path]);
});

test('showing tests after a hidden reload fetches the new run diff for the same path', async () => {
  branchFiles['slot-a'] = [testFile];
  branchFiles['slot-b'] = [testFile];
  fileDiffRequests.length = 0;
  const view = makePresenter();

  await view._loadBranchDiff(1);
  await flush();
  assert.equal(view._fileDiff, 'diff from slot-a');

  setHideTests(view, true);
  view.slotId = 'slot-b';
  await view._loadBranchDiff(1);
  await flush();
  assert.equal(view._selectedFile, '', 'nothing visible: the previous selection is dropped');
  assert.equal(view._fileDiff, '');

  setHideTests(view, false);
  await flush();
  assert.equal(view._selectedFile, testFile.path);
  assert.equal(view._fileDiff, 'diff from slot-b');
  assert.deepEqual(fileDiffRequests, [`slot-a:${testFile.path}`, `slot-b:${testFile.path}`]);
});

// TAT-4145 bda11b1a gate 5bc9ef11: the approval took longer than 15 s to validate, the gateway
// applied it at 05:47:32Z, and the person was told it failed.
function gateDecision(id = 'gate'): RunDecision {
  return {
    id,
    type: 'engine_human_gate',
    title: 'Gate',
    description: '',
    actions: [],
    createdAt: '2026-10-20T05:40:28.065Z',
  };
}
function submittingPresenter(): Presenter {
  runReadable = true;
  queryReady = true;
  return makePresenter({ runId: 'run-a', decision: gateDecision(), _recoveryPhase: 'live' });
}
const timedOut = async (): Promise<never> => {
  throw new GatewayRequestTimeoutError('Request run.resolveDecision timed out after 600000ms');
};

test('review setup stays open while submitting and after a retained-session refusal', async () => {
  let reply!: () => void;
  resolveReply = () => new Promise((resolve) => (reply = () => resolve({})));
  const view = submittingPresenter();
  Object.assign(view, {
    _reviewModalOpen: true,
    _reviewPicker: new ReviewDispatchViewModel({ context: { allowedActions: ['request-review'] } }),
  });
  const submitting = view._submitReviewRequest();
  assert.equal(view._reviewModalOpen, true);
  reply();
  await submitting;
  assert.equal(view._reviewModalOpen, false);

  resolveReply = async () => {
    throw new Error('Retained session cannot be resumed');
  };
  gatewayDecision = { id: 'gate' };
  Object.assign(view, { _acting: false, _reviewModalOpen: true });
  await view._submitReviewRequest();
  assert.equal(view._reviewModalOpen, true);
  assert.match(view._actionMessage, /Retained session cannot be resumed/);
});

test('a decision waits for the gateway answer over a long window', async () => {
  resolveReply = async () => ({});
  resolveWindows.length = 0;
  await submittingPresenter()._resolve('hold');
  assert.deepEqual(resolveWindows, [DECISION_RESOLVE_TIMEOUT_MS]);
  assert.ok(DECISION_RESOLVE_TIMEOUT_MS >= 120_000);
});

test('a decision the gateway applied though its reply timed out reads as submitted', async () => {
  resolveReply = timedOut;
  gatewayDecision = { id: 'gate', resolvedAt: '2026-10-20T05:47:32.163Z', resolvedAction: 'hold' };
  const view = submittingPresenter();
  await view._resolve('hold');
  assert.equal(view._actionTone, 'success');
  assert.doesNotMatch(view._actionMessage, /Failed/);
});

test('a timed-out decision reports what the gateway recorded, never a failure', async () => {
  resolveReply = timedOut;
  const outcomes: Array<[() => void, RegExp]> = [
    [() => (gatewayDecision = { id: 'gate' }), /has not applied this decision/],
    [
      () =>
        (gatewayDecision = {
          id: 'gate',
          resolvedAt: '2026-10-20T05:48:00.000Z',
          resolvedAction: 'abort',
        }),
      /resolved as abort instead/,
    ],
    [() => (gatewayDecision = { id: 'gate' }), /run could not be read/],
  ];
  for (const [index, [record, message]] of outcomes.entries()) {
    record();
    const view = submittingPresenter();
    runReadable = index !== 2;
    await view._resolve('hold');
    assert.match(view._actionMessage, message);
    assert.doesNotMatch(view._actionMessage, /Failed/);
    assert.notEqual(view._actionTone, 'error');
    assert.equal(view._acting, false);
  }
});

test('a refusal reads as failed unless this decision was applied by an earlier click', async () => {
  resolveReply = async () => {
    throw new Error('Decision already resolved');
  };
  gatewayDecision = { id: 'gate' };
  const refused = submittingPresenter();
  await refused._resolve('hold');
  assert.equal(refused._actionTone, 'error');
  assert.equal(refused._actionMessage, 'Failed to submit decision: Decision already resolved');

  gatewayDecision = { id: 'gate', resolvedAt: '2026-10-20T05:47:32.163Z', resolvedAction: 'hold' };
  const raced = submittingPresenter();
  await raced._resolve('hold');
  assert.equal(raced._actionTone, 'success');
});

test('a reply for a gate the view no longer shows leaves the shown gate alone', async () => {
  let reply!: () => void;
  resolveReply = () => new Promise((resolve) => (reply = () => resolve({})));
  const view = submittingPresenter();
  const submitting = view._resolve('hold');
  // The person opens another run at its own gate before the reply lands.
  Object.assign(view, {
    runId: 'run-b',
    decision: gateDecision('gate-b'),
    _actionMessage: '',
    _actionTone: '',
    _acting: false,
  });
  reply();
  await submitting;
  assert.equal(view._actionMessage, '');
  assert.equal(view._actionTone, '');
});

test('stale shared inputs refuse a direct handler call without sending a command', async () => {
  const view = submittingPresenter();
  queryReady = false;
  resolveWindows.length = 0;
  await view._resolve('hold');
  assert.deepEqual(resolveWindows, []);
  assert.match(view._actionMessage, /current run and evidence/);
  queryReady = true;
});

test('a lost connection drops its acknowledgement and clears only its request busy state', async () => {
  let reply!: () => void;
  resolveReply = () =>
    new Promise((resolve) => {
      reply = () => resolve({});
    });
  const view = submittingPresenter();
  const submitting = view._resolve('hold');
  assert.equal(view._acting, true);
  connection++;
  reply();
  await submitting;
  assert.equal(view._acting, false);
  assert.notEqual(view._actionTone, 'success');
});

test('an immediate repeated handler call cannot send the same decision twice', async () => {
  let reply!: () => void;
  resolveReply = () =>
    new Promise((resolve) => {
      reply = () => resolve({});
    });
  resolveWindows.length = 0;
  const view = submittingPresenter();
  const first = view._resolve('hold');
  await view._resolve('hold');
  assert.equal(resolveWindows.length, 1);
  reply();
  await first;
});

test('package refresh reports its result without adopting command-returned run records', async () => {
  const payload = { kind: 'ready', prPackage: { packageHash: 'old-package' } } as ReadyGatePayload;
  const decision = { ...gateDecision(), payload };
  const run = { id: 'run-a', decisions: [decision] } as Run;
  const view = makePresenter({
    runId: 'run-a',
    run,
    decision,
    _recoveryPhase: 'live',
    _selectedEvidenceKeys: ['old.png'],
  });
  refreshReply = async () => ({
    run: { id: 'wrong-run' },
    packageHash: 'new-package',
    preservedEvidenceKeys: ['new.png'],
    addedEvidenceKeys: [],
    droppedEvidenceKeys: [],
  });
  await view._refreshPublishPackage(payload);
  assert.equal(view.run, run);
  assert.equal(view.decision, decision);
  assert.deepEqual(view._selectedEvidenceKeys, ['old.png']);
  assert.equal(view._refreshingPackage, false);
  const refreshed = {
    ...decision,
    payload: { ...payload, prPackage: { ...payload.prPackage!, packageHash: 'new-package' } },
  };
  view.decision = refreshed;
  Reflect.get(view, '_applyPendingPackageSelection').call(view);
  assert.deepEqual(view._selectedEvidenceKeys, ['new.png']);
});

test('retiring a workspace clears the prior owner curation and file contents', () => {
  const view = makePresenter({
    _selectedEvidenceKeys: ['private.png'],
    _evidenceAttestationReason: 'private reason',
    _legacyTaskPromptText: 'private prompt',
    _fileDiff: 'private diff',
    _selectedFile: 'private.ts',
  });
  Object.assign(view, {
    _confirmTimer: {
      clear() {
        return undefined;
      },
    },
  });
  view._retireWorkspaceCommands();
  assert.equal(view._selectedEvidenceKeys, null);
  assert.equal(view._evidenceAttestationReason, '');
  assert.equal(view._legacyTaskPromptText, '');
  assert.equal(view._fileDiff, '');
  assert.equal(view._selectedFile, '');
});
