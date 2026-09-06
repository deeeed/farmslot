/**
 * Companion's gate-park components, actually rendered.
 *
 * The contract tests beside this one prove the shared reading; they cannot
 * prove the panel or the notice puts any of it on screen. This renders the real
 * component functions through React and asserts the output, so a panel that
 * silently drops the freed slot, or a notice that never mounts, fails here.
 *
 * How, and what that is worth: `react-native` is module-mocked with primitive
 * shims — `View` to a `div`, `Text` to a `span`, `Pressable` to a `button`,
 * `StyleSheet.create` to identity — and the tree is rendered with
 * `react-dom/server`. Companion has no React Native test renderer installed and
 * React 19 dropped `react-test-renderer`, so this is the harness available
 * without adding a dependency.
 *
 * WHAT THIS PROVES: the component functions run, their conditionals pick the
 * right branches per park state, and the testIDs and operator text an operator
 * would read are present, against payloads captured from the live Gateway.
 *
 * WHAT THIS DOES NOT PROVE: native layout, styling, touch handling, or that the
 * panel is mounted on a device. The screens that mount these components
 * (`RunDetailScreen`, `DecisionWorkspaceScreen`) need a gateway client, a
 * router, and hooks, so they are not rendered here — the Slot badge lives
 * inline in `RunDetailScreen` and is therefore covered only by the
 * `isSlotFreedByPark` contract test and by Command Center's live CDP proof of
 * the same shared predicate.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import React from 'react';

import {
  type GateParkRestoreVerdict,
  gateParkView,
  liveGateParkView,
  type MachineParkRecord,
} from '@farmslot/protocol';

import {
  AVAILABLE_VERDICT,
  CAPTURED_FREED,
  CAPTURED_FREED_REFUSED,
  CAPTURED_RESTORED,
  PARTIAL_ANSWERABLE,
  PARTIAL_NEEDS_RESTORE,
  TAKEN_VERDICT,
} from './run-gate-park.fixtures';

/**
 * A React Native primitive as a DOM tag. `testID` becomes `data-testid` so the
 * assertions name the same handles the device build does; `style` is dropped
 * because this harness makes no claim about layout.
 */
function primitive(tag: string) {
  return function Primitive(props: Record<string, unknown>) {
    const { children, style, testID, ...rest } = props;
    void style;
    return React.createElement(
      tag,
      { ...rest, ...(testID ? { 'data-testid': String(testID) } : {}) },
      children as React.ReactNode,
    );
  };
}

mock.module('react-native', {
  namedExports: {
    View: primitive('div'),
    Text: primitive('span'),
    Pressable: primitive('button'),
    StyleSheet: { create: (sheet: unknown) => sheet },
  },
});

/**
 * Loaded lazily and only once. The components must be imported AFTER the module
 * mock is registered, and this package compiles to CJS, so a top-level await is
 * not available to order it.
 */
let harness: {
  renderToStaticMarkup: (element: React.ReactElement) => string;
  RunPosturePanel: React.ComponentType<{
    state: { status: 'idle' };
    gatePark: ReturnType<typeof liveGateParkView>;
  }>;
  RunGateParkNotice: React.ComponentType<{ view: ReturnType<typeof liveGateParkView> }>;
} | null = null;

async function loadHarness() {
  if (harness) return harness;
  const server = await import('react-dom/server');
  const panel = await import('../features/run-detail/components/RunPosturePanel');
  const notice = await import('../features/decision-workspace/components/ResourcePostureGatePanel');
  harness = {
    renderToStaticMarkup: server.renderToStaticMarkup,
    RunPosturePanel: panel.RunPosturePanel,
    RunGateParkNotice: notice.RunGateParkNotice,
  };
  return harness;
}

async function renderPanel(
  record: MachineParkRecord | null,
  verdict?: GateParkRestoreVerdict,
): Promise<string> {
  const { renderToStaticMarkup, RunPosturePanel } = await loadHarness();
  const view = record ? liveGateParkView({ id: record.runId, park: record }, verdict) : null;
  return renderToStaticMarkup(
    React.createElement(RunPosturePanel, { state: { status: 'idle' }, gatePark: view }),
  );
}

async function renderNotice(
  record: MachineParkRecord,
  verdict?: GateParkRestoreVerdict,
): Promise<string> {
  const { renderToStaticMarkup, RunGateParkNotice } = await loadHarness();
  const view = liveGateParkView({ id: record.runId, park: record }, verdict);
  return renderToStaticMarkup(React.createElement(RunGateParkNotice, { view }));
}

test('the panel renders the freed slot, the preserved branch, and an unread availability', async () => {
  const html = await renderPanel(CAPTURED_FREED);
  assert.match(html, /data-testid="companion-run-posture-gate-park"/u);
  assert.match(html, /Parked, slot freed for dispatch/u);
  // Historical wording: the record proves this run released the slot, not that
  // the slot is free right now.
  assert.match(html, /This run released macwork-ff-2 to dispatch\./u);
  assert.doesNotMatch(html, /is free for dispatch/u);
  assert.match(html, /feat\/manual-000121-fix-runner-stop-process-scan/u);
  assert.match(html, /e32886e217f77bac5e0688d49ae87590cbf78f6c/u);
  assert.match(html, /Restore target macwork-ff-2/u);
  assert.match(html, /availability not read/u);
});

test('the panel states availability only from a Gateway verdict', async () => {
  const available = await renderPanel(CAPTURED_FREED, AVAILABLE_VERDICT);
  assert.match(available, /Restore target macwork-ff-2 — available/u);
  assert.doesNotMatch(available, /availability not read/u);

  const taken = await renderPanel(CAPTURED_FREED_REFUSED, TAKEN_VERDICT);
  assert.match(taken, /not available: macwork-ff-2 is now running run-9/u);
  // The release stays historical beside a taken slot; the two no longer
  // contradict each other on the same screen.
  assert.match(taken, /This run released macwork-ff-2 to dispatch\./u);
  assert.match(taken, /data-testid="companion-run-posture-gate-park-refusal"/u);
  assert.match(taken, /RESTORE_SLOT_TAKEN/u);
});

test('a restored run renders no gate-park block at all', async () => {
  const html = await renderPanel(CAPTURED_RESTORED);
  assert.doesNotMatch(html, /companion-run-posture-gate-park/u);
  assert.doesNotMatch(html, /released macwork-ff-2/u);
});

test('the gate notice says answering restores the run first', async () => {
  const html = await renderNotice(CAPTURED_FREED);
  assert.match(html, /data-testid="companion-run-gate-park-notice"/u);
  assert.match(html, /data-testid="companion-run-gate-park-restore-first"/u);
  assert.match(
    html,
    /Answering this gate restores the run into macwork-ff-2 first, then resolves the decision\./u,
  );
});

test('a partial park that left the worker running renders an answerable notice', async () => {
  // The blocking regression: this used to render "cannot be answered yet" on a
  // gate the Gateway accepts.
  const html = await renderNotice(PARTIAL_ANSWERABLE);
  assert.match(html, /data-testid="companion-run-gate-park-park-answerable"/u);
  assert.match(html, /can be answered where it stands/u);
  assert.doesNotMatch(html, /cannot be answered/u);
  assert.doesNotMatch(html, /still landing/u);
  assert.match(html, /Park failed before the slot; worker still running/u);
});

test('a partial park with a stopped worker renders a needs-restore notice', async () => {
  const html = await renderNotice(PARTIAL_NEEDS_RESTORE);
  assert.match(html, /data-testid="companion-run-gate-park-park-needs-restore"/u);
  assert.match(html, /Waiting will not clear it/u);
  assert.match(html, /Park failed partway; needs a restore/u);
});

test('a superseded refusal is rendered as an earlier failure, not a standing block', async () => {
  const html = await renderNotice(CAPTURED_FREED_REFUSED, AVAILABLE_VERDICT);
  assert.match(html, /data-testid="companion-run-gate-park-restore-first"/u);
  assert.match(html, /An earlier restore refused \(RESTORE_SLOT_TAKEN\)/u);
  assert.match(html, /the Gateway now reports that slot available/u);

  const standing = await renderNotice(CAPTURED_FREED_REFUSED);
  assert.match(standing, /The last restore refused \(RESTORE_SLOT_TAKEN\)/u);
  assert.match(standing, /Nothing has re-checked that slot since/u);
});

test('a restored run renders no gate notice', async () => {
  assert.equal(await renderNotice(CAPTURED_RESTORED), '');
  assert.equal(
    gateParkView({ id: CAPTURED_RESTORED.runId, park: CAPTURED_RESTORED })?.slotState,
    'settled',
  );
});
