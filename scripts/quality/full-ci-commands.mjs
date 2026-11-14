import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { shSingleQuote } from '../lib/shell-quote.mjs';
import { loadWorkspacePackages } from '../release/lib/workspace-utils.mjs';

import { needsSupplementarySuite } from './ci-full-supplement.mjs';
import { ciParitySteps } from './ci-local.mjs';
import { ciModeCommands } from './pr-ci-run.mjs';
import { STEPS } from './run-quality.mjs';
import { discoverTests, parseArgs, selectShard } from './run-tsx-tests.mjs';
import { discoverWorkspaces, workspaceSteps } from './run-workspace-quality.mjs';
import { workspaceTestCatalog } from './workspace-test-targets.mjs';

export const quoteCommand = (args) => args.map(shSingleQuote).join(' ');

// The package scripts use shell words and &&. Keep quoted JavaScript/globs intact;
// an operator inside a quoted argument must never become another CI task.
export function shellCommands(source) {
  const commands = [];
  let words = [],
    value = '',
    raw = '',
    quote = '',
    escaped = false,
    active = false;
  const word = () => {
    if (active) words.push(value);
    value = '';
    active = false;
  };
  const command = () => {
    word();
    if (words.length) commands.push({ words, command: raw.trim() });
    words = [];
    raw = '';
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (escaped) {
      value += c;
      raw += c;
      escaped = false;
      continue;
    }
    if (c === '\\' && quote !== "'") {
      raw += c;
      if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(source[i + 1])) value += c;
      else escaped = true;
      active = true;
      continue;
    }
    if (quote) {
      raw += c;
      if (c === quote) quote = '';
      else value += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      raw += c;
      active = true;
      continue;
    }
    if (c === '&' && source[i + 1] === '&') {
      command();
      i++;
      continue;
    }
    raw += c;
    if (/\s/.test(c)) word();
    else {
      value += c;
      active = true;
    }
  }
  if (quote || escaped) throw new Error(`Unterminated shell word: ${source}`);
  command();
  return commands;
}

export function commandCatalog(root, { qualitySteps = STEPS } = {}) {
  const packages = [...loadWorkspacePackages(root)].map(([dir, pkg]) => ({ dir, ...pkg }));
  const packageAt = (cwd) => JSON.parse(readFileSync(path.join(root, cwd, 'package.json'), 'utf8'));
  function expand(source, cwd = '.', context = {}, stack = []) {
    return shellCommands(source).flatMap(({ words, command }) => {
      const [program, ...args] = words;
      if (program === 'cd') {
        if (args.length !== 1) throw new Error(`Unsupported CI directory change: ${command}`);
        const directory = args[0].replace(
          /\$(?:\{PROJECT_CWD\}|PROJECT_CWD|\{GITHUB_WORKSPACE\}|GITHUB_WORKSPACE)/g,
          root,
        );
        if (directory.includes('$')) throw new Error(`Unresolved CI directory: ${command}`);
        cwd =
          path
            .relative(root, path.resolve(root, cwd, directory))
            .split(path.sep)
            .join('/') || '.';
        return [];
      }
      let script,
        target = cwd;
      if (program === 'yarn') {
        if (args[0] === 'workspace') {
          const workspace = packages.find((pkg) => pkg.name === args[1]);
          if (!workspace) throw new Error(`Unknown workspace in ${command}`);
          target = workspace.dir;
          script = args[2];
          if (args.length !== 3) return [{ cwd, command, words, ...context }];
        } else if (args[0] === '--cwd') {
          target = path.posix.normalize(path.posix.join(cwd, args[1]));
          script = args[2];
          if (args.length !== 3) return [{ cwd, command, words, ...context }];
        } else if (args.length === 1) script = args[0];
        if (script) {
          const pkg = packageAt(target);
          if (!pkg.scripts?.[script]) throw new Error(`Missing ${target} script ${script}`);
          const key = `${target}:${script}`;
          if (stack.includes(key)) throw new Error(`Recursive script ${key}`);
          if (target === '.' && script === 'ci:local')
            return ciParitySteps(null, root).flatMap(([label, argv]) =>
              expand(quoteCommand(argv), '.', { ...context, label }, [...stack, key]),
            );
          if (target === '.' && script === 'quality')
            return qualitySteps.flatMap(([label, argv]) =>
              expand(quoteCommand(argv), '.', { ...context, label }, [...stack, key]),
            );
          if (target === '.' && script === 'quality:workspaces')
            return workspaceSteps(discoverWorkspaces(root)).flatMap(([label, argv]) =>
              expand(quoteCommand(argv), '.', { ...context, label }, [...stack, key]),
            );
          return expand(
            pkg.scripts[script],
            target,
            {
              ...context,
              ...(target.startsWith('packages/') || target.startsWith('services/')
                ? { workspace: pkg.name }
                : {}),
              test: context.test || script.startsWith('test'),
              buildOwner:
                script === 'build' && target.startsWith('packages/') ? pkg.name : undefined,
            },
            [...stack, key],
          );
        }
      }
      if (words.some((value) => value.endsWith('ci-full-supplement.mjs')))
        return workspaceTestCatalog(root)
          .filter(needsSupplementarySuite)
          .flatMap((workspace) =>
            expand(`yarn workspace ${workspace.name} test`, '.', context, stack),
          );
      const modeIndex = words.findIndex((word) => word.endsWith('pr-ci-run.mjs'));
      if (modeIndex !== -1 && ['acceptance', 'transport'].includes(words[modeIndex + 1]))
        return ciModeCommands(words[modeIndex + 1]).flatMap((args) =>
          expand(quoteCommand(args), cwd, context, stack),
        );
      return [{ cwd, command, words, ...context }];
    });
  }
  return { packages, expand };
}

export const FULL_EXTRA_STEPS = [
  [
    'selection contracts',
    [
      'node',
      '--test',
      'scripts/quality/affected-tests.test.mjs',
      'scripts/quality/pr-ci-plan.test.mjs',
      'scripts/quality/workspace-test-targets.test.mjs',
    ],
  ],
  ['workspace supplements', ['node', 'scripts/quality/ci-full-supplement.mjs']],
  ['companion structure', ['yarn', '--cwd', 'apps/companion', 'quality:structure:ci']],
  [
    'generated docs clean',
    ['git', 'diff', '--exit-code', '--', 'apps/docs/docs', 'docs/reference/template-variables.md'],
  ],
  ['pages build', ['yarn', 'cc:build:pages']],
  ...['acceptance', 'transport', 'farm-proof'].map((mode) => [
    mode,
    ['node', 'scripts/quality/pr-ci-run.mjs', mode],
  ]),
];

export function monolithicCommands(root, options) {
  const { expand } = commandCatalog(root, options);
  const linux = [
    ...expand('yarn ci:local'),
    ...expand('yarn quality'),
    ...FULL_EXTRA_STEPS.flatMap(([label, args]) => expand(quoteCommand(args), '.', { label })),
  ].map((task) => ({ node: 22, platform: 'linux', ...task }));
  const node24 = expand(
    'node ../../scripts/quality/run-tsx-tests.mjs --cwd . --tsconfig tsconfig.json src/gateway-client.test.ts',
    'packages/cli',
  ).map((task) => ({ node: 24, platform: 'linux', label: 'Node 24 gateway transport', ...task }));
  const desktop = [
    ...expand('yarn workspace @farmslot/command-center-desktop test'),
    ...expand('yarn workspace @farmslot/command-center-desktop package:mac'),
    {
      cwd: '.',
      command:
        'yarn workspace @farmslot/command-center-desktop exec electron-builder --config build/development.cjs --mac --arm64 --config.mac.identity=null',
      words: [],
      env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
      label: 'development macOS installer',
    },
  ].map((task) => ({ node: 22, platform: 'darwin', ...task }));
  return [...linux, ...node24, ...desktop];
}

export function commandKey(task) {
  return JSON.stringify([task.platform, task.node, task.cwd, task.env ?? {}, task.command]);
}

export function taskId(task) {
  return createHash('sha256').update(commandKey(task)).digest('hex').slice(0, 16);
}

export function testFiles(task, root) {
  const words = task.words;
  const modeIndex = words.findIndex((word) => word.endsWith('pr-ci-run.mjs'));
  if (modeIndex !== -1) {
    const { expand } = commandCatalog(root);
    return [
      ...new Set(
        ciModeCommands(words[modeIndex + 1]).flatMap((args) =>
          expand(quoteCommand(args)).flatMap((child) => testFiles(child, root)),
        ),
      ),
    ].sort();
  }
  const runner = words.findIndex((word) => word.endsWith('run-tsx-tests.mjs'));
  if (runner !== -1) {
    const parsed = parseArgs(words.slice(runner + 1));
    const cwd = path.resolve(root, task.cwd, parsed.cwd ?? '.');
    return selectShard(discoverTests(parsed.roots, cwd), parsed.shard).map((file) =>
      path.relative(root, file).split(path.sep).join('/'),
    );
  }
  const files = new Set();
  for (const word of words) {
    if (
      /\.(?:test|spec)\.(?:[cm]?[jt]sx?|sh|py)$/.test(word) ||
      (task.test && /\.(?:[cm]?[jt]sx?|sh|py)$/.test(word) && !word.startsWith('-'))
    )
      for (const file of globSync(word, { cwd: path.join(root, task.cwd) }))
        files.add(path.posix.join(task.cwd, file));
  }
  if (words.some((word) => word.endsWith('run-shell-tests.sh')))
    for (const file of globSync('scripts/tests/*.test.sh', { cwd: root })) files.add(file);
  if (words[0] === 'python3' && words.includes('unittest')) {
    const directory = words[words.indexOf('-s') + 1];
    for (const file of globSync(`${directory}/**/test*.py`, { cwd: path.join(root, task.cwd) }))
      files.add(path.posix.join(task.cwd, file));
  }
  if (words.some((word) => word.endsWith('resolve-launch-blockers.test.sh')))
    files.add(
      path.posix.join(
        task.cwd,
        words.find((word) => word.endsWith('resolve-launch-blockers.test.sh')),
      ),
    );
  return [...files].sort();
}
