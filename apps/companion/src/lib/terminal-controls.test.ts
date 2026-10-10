import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { RUNNER_MOBILE_KEY_PROFILES } from '@farmslot/protocol';

import { parseTerminalPrefs, serializeTerminalPrefs } from '../store/terminal-prefs';

import {
  addTerminalCustomKey,
  MAX_TERMINAL_CUSTOM_KEYS,
  normalizeTerminalCustomKeys,
  removeTerminalCustomKey,
  resolveRunnerKeyProfile,
  runnerKeyProfileSummary,
  slotTerminalRunnerContext,
  TERMINAL_CONTROL_KEYS,
  TERMINAL_KEY_PALETTE,
  type TerminalCustomKey,
  terminalExtraKeyRows,
  type TerminalRunnerContext,
  workerTerminalRunnerContext,
} from './terminal-controls';

const PANE = 'macpro::%7';

test('terminal control keys include mobile TUI navigation sequences', () => {
  const dataByLabel = new Map(TERMINAL_CONTROL_KEYS.map((key) => [key.label, key.data]));

  assert.equal(dataByLabel.get('↑'), '\x1b[A');
  assert.equal(dataByLabel.get('↓'), '\x1b[B');
  assert.equal(dataByLabel.get('←'), '\x1b[D');
  assert.equal(dataByLabel.get('→'), '\x1b[C');
  assert.equal(dataByLabel.get('Enter'), '\r');
  assert.equal(dataByLabel.get('Tab'), '\x09');
  assert.equal(dataByLabel.get('⇧Tab'), '\x1b[Z');
  assert.equal(dataByLabel.get('^D'), '\x04');
});

test('terminal control keys keep interrupt marked dangerous', () => {
  assert.equal(TERMINAL_CONTROL_KEYS.find((key) => key.label === '^C')?.danger, true);
  assert.equal(TERMINAL_CONTROL_KEYS.find((key) => key.label === '^D')?.danger, true);
});

test('runner profile resolves saved override, then linked run, then one process match', () => {
  const context: TerminalRunnerContext = {
    paneKey: PANE,
    linkedRunner: 'codex',
    processRunnerIds: ['claude'],
  };

  const saved = resolveRunnerKeyProfile(context, { [PANE]: 'pi' });
  assert.deepEqual([saved.runnerId, saved.source], ['pi', 'saved']);
  assert.equal(saved.profile, RUNNER_MOBILE_KEY_PROFILES.pi);

  const fromRun = resolveRunnerKeyProfile(context, { 'other::%1': 'pi' });
  assert.deepEqual([fromRun.runnerId, fromRun.source], ['codex', 'run']);

  const fromProcess = resolveRunnerKeyProfile({ ...context, linkedRunner: null }, {});
  assert.deepEqual([fromProcess.runnerId, fromProcess.source], ['claude', 'process']);
  assert.equal(fromProcess.profile, RUNNER_MOBILE_KEY_PROFILES.claude);

  const generic = resolveRunnerKeyProfile({ paneKey: PANE }, {});
  assert.deepEqual(generic, { runnerId: null, source: 'generic', profile: null });
  assert.equal(runnerKeyProfileSummary(generic), 'Runner: none · auto');
});

test('runner profile stays generic for an ambiguous or generic agent command', () => {
  // The gateway never lists cursor for `agent`; the client must not infer it from the command.
  const agentPane = workerTerminalRunnerContext(
    { nodeId: 'macpro', session: 'adhoc', target: '%7' },
    { processRunnerIds: undefined },
    null,
  );
  assert.equal(resolveRunnerKeyProfile(agentPane, {}).source, 'generic');

  const ambiguous = resolveRunnerKeyProfile(
    { paneKey: PANE, processRunnerIds: ['claude', 'codex'] },
    {},
  );
  assert.deepEqual([ambiguous.runnerId, ambiguous.profile], [null, null]);
});

test('runner without a key profile resolves to no extra row', () => {
  const resolved = resolveRunnerKeyProfile({ paneKey: PANE, linkedRunner: 'opencode' }, {});
  assert.deepEqual([resolved.runnerId, resolved.profile], ['opencode', null]);
  assert.deepEqual(terminalExtraKeyRows(resolved.profile, []), []);
});

test('saved runner choice survives a prefs reload until it is cleared', () => {
  const context: TerminalRunnerContext = { paneKey: PANE, linkedRunner: 'codex' };
  const stored = serializeTerminalPrefs({
    ...parseTerminalPrefs(null),
    runnerKeyOverrides: { [PANE]: 'grok', 'macpro::%9': 'not-a-runner' },
  });

  const reloaded = parseTerminalPrefs(stored);
  assert.deepEqual(reloaded.runnerKeyOverrides, { [PANE]: 'grok' });
  assert.equal(resolveRunnerKeyProfile(context, reloaded.runnerKeyOverrides).runnerId, 'grok');

  const cleared = parseTerminalPrefs(
    serializeTerminalPrefs({ ...reloaded, runnerKeyOverrides: {} }),
  );
  const auto = resolveRunnerKeyProfile(context, cleared.runnerKeyOverrides);
  assert.deepEqual([auto.runnerId, auto.source], ['codex', 'run']);
});

test('slot terminal context keys the slot session and reads the active pane', () => {
  const context = slotTerminalRunnerContext(
    { slot: 'macpro-ff-1', machine: 'macpro', session: 'ff-1' },
    { metrics: { runner: 'claude' } as never },
    [
      { index: 0, name: 'shell', active: false, synchronizePanes: false, panes: [] },
      {
        index: 1,
        name: 'worker',
        active: true,
        synchronizePanes: false,
        panes: [
          { index: 0, active: false, width: 80, height: 24, title: '', processRunnerIds: ['pi'] },
          { index: 1, active: true, width: 80, height: 24, title: '', processRunnerIds: ['codex'] },
        ],
      },
    ],
  );
  assert.deepEqual(context, {
    paneKey: 'macpro:ff-1',
    linkedRunner: 'claude',
    processRunnerIds: ['codex'],
  });
  assert.equal(slotTerminalRunnerContext(undefined, null, []).paneKey, null);
});

test('palette encodes xterm modified arrows and Ctrl+A through Ctrl+Z only', () => {
  const data = new Map(TERMINAL_KEY_PALETTE.map((entry) => [entry.id, entry.data]));
  assert.equal(data.get('shift+up'), '\x1b[1;2A');
  assert.equal(data.get('alt+down'), '\x1b[1;3B');
  assert.equal(data.get('ctrl+right'), '\x1b[1;5C');
  assert.equal(data.get('shift+left'), '\x1b[1;2D');
  assert.equal(data.get('ctrl+a'), '\x01');
  assert.equal(data.get('ctrl+r'), '\x12');
  assert.equal(data.get('ctrl+z'), '\x1a');
  assert.equal(TERMINAL_KEY_PALETTE.length, 3 * 4 + 26);
  for (const entry of TERMINAL_KEY_PALETTE) {
    assert.match(entry.data, /^(\x1b\[1;[235][ABCD]|[\x01-\x1a])$/);
  }
});

test('custom keys trim labels, stay unique, cap at 8 and store a palette id, not bytes', () => {
  const first = addTerminalCustomKey([], {
    label: '  Word ←  ',
    sequence: 'alt+left',
    danger: false,
  });
  assert.deepEqual(first, {
    ok: true,
    keys: [{ label: 'Word ←', sequence: 'alt+left', danger: false }],
  });
  if (!first.ok) return;
  assert.deepEqual(Object.keys(first.keys[0]).sort(), ['danger', 'label', 'sequence']);

  const failures = [
    { label: '   ', sequence: 'ctrl+r', danger: false },
    { label: 'x'.repeat(17), sequence: 'ctrl+r', danger: false },
    { label: 'Word ←', sequence: 'ctrl+r', danger: false },
    { label: 'Raw', sequence: '\x1b[1;9X', danger: false },
  ];
  for (const draft of failures) assert.equal(addTerminalCustomKey(first.keys, draft).ok, false);
  assert.equal(
    addTerminalCustomKey(first.keys, { label: 'x'.repeat(16), sequence: 'ctrl+r', danger: true })
      .ok,
    true,
  );

  const full: TerminalCustomKey[] = Array.from(
    { length: MAX_TERMINAL_CUSTOM_KEYS },
    (_, index) => ({
      label: `K${index}`,
      sequence: 'ctrl+r',
      danger: false,
    }),
  );
  assert.equal(
    addTerminalCustomKey(full, { label: 'K9', sequence: 'ctrl+r', danger: false }).ok,
    false,
  );
  assert.deepEqual(
    removeTerminalCustomKey(full, 'K0').map((key) => key.label),
    ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7'],
  );

  // Storage reload drops raw-byte entries, duplicates and anything past the cap.
  const reloaded = normalizeTerminalCustomKeys([
    ...full,
    { label: 'K8', sequence: 'ctrl+b', danger: false },
    { label: 'Raw', data: '\x1b', danger: true },
  ]);
  assert.equal(reloaded.length, MAX_TERMINAL_CUSTOM_KEYS);
  assert.deepEqual(
    normalizeTerminalCustomKeys([
      { label: 'K0', sequence: 'ctrl+r' },
      { label: 'K0', sequence: 'ctrl+b' },
    ]),
    [{ label: 'K0', sequence: 'ctrl+r', danger: false }],
  );
});

test('custom keys persist through a prefs reload', () => {
  const stored = serializeTerminalPrefs({
    ...parseTerminalPrefs(null),
    customKeys: [{ label: 'Kill', sequence: 'ctrl+x', danger: true }],
  });
  assert.deepEqual(parseTerminalPrefs(stored).customKeys, [
    { label: 'Kill', sequence: 'ctrl+x', danger: true },
  ]);
});

test('extra rows show the runner row only with keys and the Yours row whenever keys exist', () => {
  const custom: TerminalCustomKey[] = [{ label: 'Kill', sequence: 'ctrl+x', danger: true }];

  const yoursOnly = terminalExtraKeyRows(null, custom);
  assert.deepEqual(yoursOnly, [
    { id: 'custom', title: 'Yours', keys: [{ label: 'Kill', data: '\x18', danger: true }] },
  ]);

  const profile = RUNNER_MOBILE_KEY_PROFILES.claude;
  const rows = terminalExtraKeyRows(profile, custom);
  assert.deepEqual(
    rows.map((row) => [row.id, row.title]),
    [
      ['runner', 'Claude Code'],
      ['custom', 'Yours'],
    ],
  );
  assert.deepEqual(
    rows[0].keys,
    profile.keys.map(({ label, data, danger }) => ({ label, data, danger })),
  );
  // An interactive runner with an empty inventory (codex) adds no runner row.
  assert.deepEqual(terminalExtraKeyRows(RUNNER_MOBILE_KEY_PROFILES.codex, []), []);
});

test('key bar styles every danger key with the existing danger style and has no confirm', () => {
  const source = readFileSync(
    new URL('../components/TerminalControlKeyBar.tsx', import.meta.url),
    'utf8',
  );
  // One renderer serves the generic, runner and Yours rows.
  assert.equal(source.match(/control\.danger && styles\.dangerButton/g)?.length, 1);
  assert.equal(source.match(/renderKey\(control/g)?.length, 2);
  assert.doesNotMatch(source, /\bAlert\b/);
  assert.match(source, /onPress=\{\(\) => onPress\(control\)\}/);
});
