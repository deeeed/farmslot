import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import type { ProjectVars, SlotVars } from './config.js';
import {
  assertNoUnknownPlaceholders,
  collectTemplatePlaceholders,
  expandDispatchCmd,
  expandTemplate,
  expandTemplateWithReservedLast,
  knownTemplatePlaceholders,
  resolveEffectiveDomain,
} from './hooks.js';

test('resolveEffectiveDomain uses explicit then slot/pool default then none', () => {
  assert.equal(resolveEffectiveDomain('trading', 'payments'), 'trading');
  assert.equal(resolveEffectiveDomain(undefined, 'payments'), 'payments');
  assert.equal(resolveEffectiveDomain(' ', ' trading '), 'trading');
  assert.equal(resolveEffectiveDomain(undefined, undefined), undefined);
});

test('expandTemplate exposes the full slot id for configured actions', () => {
  const slotVars: SlotVars = {
    slotId: 'runner-browser-1',
    machine: 'runner-local',
    platform: 'chrome-extension',
    host: 'localhost',
    sshUser: 'example',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '/usr/local/bin/agent',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/repo',
    session: 'browser-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'example-browser-farm',
    resourceVars: { cdp_port: '9222' },
  };

  assert.equal(
    expandTemplate('{{slot_id}} {{SLOT_ID}} {{session}} {{cdp_port}}', slotVars),
    'runner-browser-1 runner-browser-1 browser-1 9222',
  );
});

test('expandTemplate uses configured session when machine ids contain hyphens', () => {
  const slotVars: SlotVars = {
    slotId: 'macwork-lan-mm-1',
    machine: 'macwork-lan',
    platform: 'ios',
    host: 'localhost',
    sshUser: 'example',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/repo',
    session: 'mm-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'example-mobile-farm',
    resourceVars: {},
  };

  assert.equal(
    expandTemplate('{{slot_id}} {{session}} {{SESSION}}', slotVars),
    'macwork-lan-mm-1 mm-1 mm-1',
  );
});

test('expandTemplate renders missing optional resource placeholders as empty strings', () => {
  const slotVars: SlotVars = {
    slotId: 'macwork-mm-1',
    machine: 'macwork',
    platform: 'ios',
    host: 'localhost',
    sshUser: 'example',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/repo',
    session: 'mm-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'example-mobile-farm',
    resourceVars: { port: '8061', simulator: 'mm-1' },
  };

  assert.equal(
    expandTemplate('{{port}} {{simulator}} {{avd}} {{adb_serial}} {{ADB_SERIAL}}', slotVars),
    '8061 mm-1   ',
  );

  // vite_port is optional too: renders when the slot declares it, empty when not.
  assert.equal(
    expandTemplate('{{vite_port}}', {
      ...slotVars,
      resourceVars: { ...slotVars.resourceVars, vite_port: '5875' },
    }),
    '5875',
  );
  assert.equal(expandTemplate('{{vite_port}}', slotVars), '');
});

test('shared template expansion names missing lowercase and uppercase Metro resources', () => {
  const slotVars: SlotVars = {
    slotId: 'legacy-farmslot-1',
    machine: 'legacy',
    platform: 'cli',
    host: 'localhost',
    sshUser: 'example',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/repo',
    session: 'farmslot-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'farmslot-farm',
    resourceVars: { port: '8808' },
  };

  for (const placeholder of ['{{metro_port}}', '{{METRO_PORT}}']) {
    assert.throws(
      () => expandTemplate(`prepare --metro-port ${placeholder}`, slotVars),
      /legacy-farmslot-1.*resources\.dev-server\.metro_port.*farmslot update/,
    );
  }
});

test('shared template expansion requires manual pool configuration when dev-server is absent', () => {
  const slotVars: SlotVars = {
    slotId: 'legacy-farmslot-1',
    machine: 'legacy',
    platform: 'cli',
    host: 'localhost',
    sshUser: 'example',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/repo',
    session: 'farmslot-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'farmslot-farm',
    resourceVars: {},
  };

  assert.throws(
    () => expandTemplate('prepare --metro-port {{METRO_PORT}}', slotVars),
    /missing resources\.dev-server.*add the resource manually.*distinct port and metro_port/i,
  );
});

test('expandDispatchCmd supports Cursor Agent runner path placeholders', () => {
  const slotVars: SlotVars = {
    slotId: 'runner-browser-1',
    machine: 'runner-local',
    platform: 'chrome-extension',
    host: 'localhost',
    sshUser: 'example',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '/usr/local/bin/agent',
    grokPath: '',
    dispatchCmd:
      'cd {repo} && {runner} {runner_path} {cursor_path} {safety_flags} --model {model} {task_prompt}',
    recycleCmd: '',
    repo: '/repo',
    session: 'browser-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'example-browser-farm',
    resourceVars: { cdp_port: '9222' },
  };

  assert.equal(
    expandDispatchCmd(slotVars, {
      runner: 'cursor',
      model: 'composer-2.5',
      taskPrompt: 'Read TASK.md',
      safetyFlags: '--sandbox enabled',
    }),
    'cd /repo && cursor /usr/local/bin/agent /usr/local/bin/agent --sandbox enabled --model composer-2.5 Read TASK.md',
  );
});

test('expandDispatchCmd leaves Cursor Agent path placeholders empty when cursor_path is not configured', () => {
  const slotVars: SlotVars = {
    slotId: 'runner-browser-1',
    machine: 'runner-local',
    platform: 'chrome-extension',
    host: 'localhost',
    sshUser: 'example',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '{runner_path} {cursor_path}',
    recycleCmd: '',
    repo: '/repo',
    session: 'browser-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'example-browser-farm',
    resourceVars: {},
  };

  assert.equal(expandDispatchCmd(slotVars, { runner: 'cursor' }), '');
});

test('expandDispatchCmd attaches runner arguments before trailing shell commands', () => {
  const slotVars: SlotVars = {
    slotId: 'runner-local-1',
    machine: 'runner-local',
    platform: 'none',
    host: 'localhost',
    sshUser: 'example',
    osType: 'darwin',
    claudePath: "printf 'ARG:%s\\n'",
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: "{claude_path}; printf 'TAIL\\n'",
    recycleCmd: '',
    repo: '/repo',
    session: 'runner-local-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'example-farm',
    resourceVars: {},
  };
  const command = expandDispatchCmd(slotVars, {
    runner: 'claude',
    runnerArgs: '--settings /runtime/settings.json',
  });

  assert.equal(
    execFileSync('/bin/bash', ['-c', command], { encoding: 'utf8' }),
    'ARG:--settings\nARG:/runtime/settings.json\nTAIL\n',
  );
});

test('expandDispatchCmd supports Grok runner path placeholders', () => {
  const slotVars: SlotVars = {
    slotId: 'runner-browser-1',
    machine: 'runner-local',
    platform: 'chrome-extension',
    host: 'localhost',
    sshUser: 'example',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '/Users/deeeed/.grok/bin/grok',
    dispatchCmd:
      'cd {repo} && {runner} {runner_path} {grok_path} {safety_flags} --model {model} {task_prompt}',
    recycleCmd: '',
    repo: '/repo',
    session: 'browser-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    remoteRepo: '/repo',
    projectName: 'example-browser-farm',
    resourceVars: { cdp_port: '9222' },
  };

  assert.equal(
    expandDispatchCmd(slotVars, {
      runner: 'grok',
      model: 'grok-build',
      taskPrompt: 'Read TASK.md',
      safetyFlags: '--permission-mode auto',
    }),
    'cd /repo && grok /Users/deeeed/.grok/bin/grok /Users/deeeed/.grok/bin/grok --permission-mode auto --model grok-build Read TASK.md',
  );
});

test('expandTemplate substitutes {{repo}} with the shell-usable remote repo path', () => {
  const slotVars: SlotVars = {
    slotId: 'gohan-1',
    machine: 'gohan',
    platform: 'ios',
    host: 'gohan.local',
    sshUser: 'dev',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '~/dev/checkout',
    session: 's1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'dev@gohan.local',
    remoteRepo: '/Users/dev/dev/checkout',
    projectName: 'demo',
    resourceVars: {},
  };
  assert.equal(expandTemplate("cd '{{repo}}'", slotVars), "cd '/Users/dev/dev/checkout'");
});

test('{{domain}} precedence: extras > project vars > pool default > empty', () => {
  const base: SlotVars = {
    slotId: 's1',
    machine: 'm',
    platform: 'cli',
    host: 'localhost',
    sshUser: 'x',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/tmp/r',
    session: 's',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'x@localhost',
    remoteRepo: '/tmp/r',
    projectName: 'demo',
    resourceVars: {},
  };
  const projectVars = {
    projectName: 'demo',
    projectConfig: '/x/project.json',
    projectFixturesDir: '/x/fixtures',
    projectTemplatesDir: '/x/templates',
    projectJson: { vars: { domain: 'static' } },
    runtimeDir: '.agent',
    artifactDir: '.task',
  } as ProjectVars;
  assert.equal(expandTemplate('{{domain}}', base), '');
  assert.equal(expandTemplate('{{domain}}', { ...base, domain: 'pool' }), 'pool');
  assert.equal(expandTemplate('{{domain}}', base, projectVars), 'static');
  // Project vars beat the pool-level default when both are present.
  assert.equal(expandTemplate('{{domain}}', { ...base, domain: 'pool' }, projectVars), 'static');
  assert.equal(expandTemplate('{{domain}}', base, projectVars, { domain: 'runtime' }), 'runtime');
});

test('collectTemplatePlaceholders finds each placeholder name once', () => {
  assert.deepEqual(
    [...collectTemplatePlaceholders('{{a}} {{b}} {{a}} {{not a placeholder}} {{9bad}}')].sort(),
    ['a', 'b'],
  );
});

test('assertNoUnknownPlaceholders passes known names and throws on unknown ones', () => {
  assertNoUnknownPlaceholders('run {{TASK_FILE}} in {{TASK_DIR}}', ['TASK_FILE', 'TASK_DIR'], 'x');
  assert.throws(
    () =>
      assertNoUnknownPlaceholders(
        'read {{recipe_quality_path}} and {{TASK_FILE}}',
        ['TASK_FILE'],
        'Prompt template worker-dispatch.md',
      ),
    /Prompt template worker-dispatch\.md.*\{\{recipe_quality_path\}\}/,
  );
  // Every unknown name must appear in one error, not just the first.
  assert.throws(
    () => assertNoUnknownPlaceholders('{{alpha}} {{beta}}', [], 'multi'),
    /\{\{alpha\}\}, \{\{beta\}\}/,
  );
  // Malformed names can never be substituted — they must fail, not slip
  // through an identifier-only scan.
  assert.throws(
    () => assertNoUnknownPlaceholders('run {{foo-bar}} now', ['foo_bar'], 'grammar'),
    /grammar.*\{\{foo-bar\}\}/,
  );
});

test('knownTemplatePlaceholders stays in sync with expandTemplate', () => {
  const slotVars: SlotVars = {
    slotId: 's1',
    machine: 'm',
    platform: 'cli',
    host: 'localhost',
    sshUser: 'x',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/tmp/r',
    session: 's',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'x@localhost',
    remoteRepo: '/tmp/r',
    projectName: 'demo',
    resourceVars: { port: '1234', cdp_port: '9222' },
  };
  const projectVars = {
    projectName: 'demo',
    projectConfig: '/x/project.json',
    projectFixturesDir: '/x/fixtures',
    projectTemplatesDir: '/x/templates',
    projectJson: {
      vars: { recipe_quality_path: '{{runtime_dir}}/recipe-quality.md' },
      reference_repos: { mobile: { repo_url: 'https://example.com/mm.git', local_name: 'mm-ref' } },
    },
    runtimeDir: '.agent',
    artifactDir: '.task',
  } as ProjectVars;
  const extraVars = { extra_var: 'v' };
  // Every name the guard reports as known must actually be substituted by
  // expandTemplate — a placeholder surviving expansion means the two drifted.
  const known = knownTemplatePlaceholders(slotVars, projectVars, extraVars);
  const template = [...known].map((name) => `{{${name}}}`).join(' ');
  const expanded = expandTemplate(template, slotVars, projectVars, extraVars);
  assert.deepEqual([...collectTemplatePlaceholders(expanded)], []);
  // Floor pin for the reverse direction: names expandTemplate substitutes must
  // stay in the known set, or the guard would falsely reject valid templates.
  for (const name of [
    'watcher_port',
    'WATCHER_PORT',
    'recipe_dir',
    'DOMAIN',
    'mobile_repo',
    'MOBILE_REPO',
    'recipe_quality_path',
    'RECIPE_QUALITY_PATH',
    'extra_var',
    'cdp_port',
  ]) {
    assert.ok(known.has(name), `known set is missing ${name}`);
  }

  // A project var whose value cannot fully resolve in the nested pass must
  // not count as known — expanding it would smuggle raw {{...}} to a worker.
  const leakyVars = {
    ...projectVars,
    projectJson: {
      ...projectVars.projectJson,
      vars: { leaky: '{{no_such_thing}}/x', clean: '{{runtime_dir}}/ok' },
    },
  } as ProjectVars;
  const leakyKnown = knownTemplatePlaceholders(slotVars, leakyVars);
  assert.ok(!leakyKnown.has('leaky'));
  assert.ok(leakyKnown.has('clean'));

  // Resource and extra values are substituted verbatim — one carrying a
  // {{...}} token must disqualify its key from the known set.
  const dirtyResourceKnown = knownTemplatePlaceholders(
    { ...slotVars, resourceVars: { port: '{{smuggled}}', cdp_port: '9222' } },
    projectVars,
    { good_extra: 'v', bad_extra: '{{also_smuggled}}' },
  );
  assert.ok(!dirtyResourceKnown.has('port'));
  assert.ok(!dirtyResourceKnown.has('PORT'));
  assert.ok(dirtyResourceKnown.has('cdp_port'));
  assert.ok(dirtyResourceKnown.has('good_extra'));
  assert.ok(!dirtyResourceKnown.has('bad_extra'));
});

test('expandTemplateWithReservedLast protects reserved values from collisions and re-expansion', () => {
  const slotVars: SlotVars = {
    slotId: 's1',
    machine: 'm',
    platform: 'cli',
    host: 'localhost',
    sshUser: 'x',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/tmp/r',
    session: 's',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'x@localhost',
    remoteRepo: '/tmp/r',
    projectName: 'demo',
    resourceVars: {},
  };
  const projectVars = {
    projectName: 'demo',
    projectConfig: '/x/project.json',
    projectFixturesDir: '/x/fixtures',
    projectTemplatesDir: '/x/templates',
    projectJson: { vars: { ISSUES: 'colliding-project-var' } },
    runtimeDir: '.agent',
    artifactDir: '.task',
  } as ProjectVars;
  const rendered = expandTemplateWithReservedLast(
    'in {{repo}}: {{ISSUES}}',
    slotVars,
    projectVars,
    { ISSUES: 'reviewer text quoting {{repo}} verbatim' },
  );
  // Reserved value wins over the colliding project var, and its quoted
  // {{repo}} token survives un-expanded.
  assert.equal(rendered, 'in /tmp/r: reviewer text quoting {{repo}} verbatim');
});
