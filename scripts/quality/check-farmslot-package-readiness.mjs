#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const args = new Set(argv);
const runPack = args.has('--pack');
const strictPublish = args.has('--publish');
const requireChangelog = strictPublish || args.has('--require-changelog');
const packageFilter = parsePackageFilter(argv);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

process.chdir(repoRoot);

const rootLicense = readFileSync('LICENSE', 'utf8');

const packages = [
  {
    name: '@farmslot/protocol',
    dir: 'packages/protocol',
    publicDoc: 'https://farmslot.io/docs/reference/recipe-protocol-v1',
    requiredFiles: ['README.md', 'LICENSE', 'src/index.ts', 'src/recipe/index.ts'],
    packRequiredFiles: ['README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts'],
    importCheck:
      "const m = await import('./packages/protocol/dist/index.js'); if (!m.PROTOCOL_VERSION) throw new Error('missing PROTOCOL_VERSION export');",
  },
  {
    name: '@farmslot/recipe-harness',
    dir: 'packages/recipe-harness',
    publicDoc: 'https://farmslot.io/docs/architecture/recipe-harness',
    requiredFiles: [
      'README.md',
      'LICENSE',
      'bin/farmslot-recipe.mjs',
      'src/index.ts',
      'src/core/runner.ts',
    ],
    packRequiredFiles: [
      'README.md',
      'LICENSE',
      'bin/farmslot-recipe.mjs',
      'dist/index.js',
      'dist/index.d.ts',
      'dist/cli/index.js',
    ],
    importCheck:
      "const m = await import('./packages/recipe-harness/dist/cli/index.js'); if (typeof m.runRecipeHarnessCli !== 'function') throw new Error('missing runRecipeHarnessCli export');",
  },
  {
    name: '@farmslot/agent-runtime',
    dir: 'packages/agent-runtime',
    publicDoc: 'https://farmslot.io/docs/reference/agent-runtime',
    requiredFiles: [
      'README.md',
      'LICENSE',
      'bin/farmslot-agent.mjs',
      'src/index.ts',
      'scripts/mark-checklist-step.cjs',
      'scripts/worker-terminal-contract.cjs',
      'scripts/check-task-artifact-contract.mjs',
    ],
    packRequiredFiles: [
      'README.md',
      'LICENSE',
      'bin/farmslot-agent.mjs',
      'dist/index.js',
      'dist/index.d.ts',
      'scripts/mark-checklist-step.cjs',
      'scripts/worker-terminal-contract.cjs',
      'scripts/check-task-artifact-contract.mjs',
    ],
    importCheck:
      "const m = await import('./packages/agent-runtime/dist/index.js'); if (m.AGENT_RUNTIME_PACKAGE !== '@farmslot/agent-runtime') throw new Error('missing agent-runtime root export');",
  },
  {
    name: '@farmslot/expo-recipe',
    dir: 'packages/expo-recipe',
    publicDoc: 'https://farmslot.io/docs/guides/expo-recipe',
    requiredFiles: [
      'README.md',
      'LICENSE',
      'bin/farmslot-expo-recipe.mjs',
      'src/index.ts',
      'templates/scripts/agentic/recipe/recipes/expo.config.recipe.json',
    ],
    packRequiredFiles: [
      'README.md',
      'LICENSE',
      'bin/farmslot-expo-recipe.mjs',
      'dist/index.js',
      'dist/index.d.ts',
      'dist/cli.js',
      'templates/scripts/agentic/recipe/recipes/expo.config.recipe.json',
    ],
    importCheck:
      "const m = await import('./packages/expo-recipe/dist/cli.js'); if (typeof m.runExpoRecipeCli !== 'function') throw new Error('missing runExpoRecipeCli export');",
  },
  {
    name: '@farmslot/skills',
    dir: 'packages/skills',
    publicDoc: 'https://farmslot.io/docs/guides/recipe-skills-adoption',
    requiredFiles: [
      'README.md',
      'LICENSE',
      'bin/farmslot-skills.mjs',
      'src/index.ts',
      'skills/recipe-cook/SKILL.md',
      'skills/recipe-quality/SKILL.md',
      'skills/recipe-doctor/SKILL.md',
      'skills/recipe-harness/SKILL.md',
      'skills/project-adopt/SKILL.md',
      'schemas/recipe-cook-learning.schema.json',
      'scripts/lib.cjs',
      'scripts/prepare-cooking-run.cjs',
      'scripts/run-cooking-lane.cjs',
      'scripts/record-validator-run.cjs',
    ],
    packRequiredFiles: [
      'README.md',
      'LICENSE',
      'bin/farmslot-skills.mjs',
      'dist/index.js',
      'dist/index.d.ts',
      'skills/recipe-cook/SKILL.md',
      'skills/recipe-quality/SKILL.md',
      'skills/recipe-doctor/SKILL.md',
      'skills/recipe-harness/SKILL.md',
      'skills/project-adopt/SKILL.md',
      'schemas/recipe-cook-learning.schema.json',
      'scripts/lib.cjs',
      'scripts/prepare-cooking-run.cjs',
      'scripts/run-cooking-lane.cjs',
      'scripts/record-validator-run.cjs',
    ],
    importCheck:
      "const m = await import('./packages/skills/dist/index.js'); if (!m.FARMSLOT_SKILL_NAMES?.includes('recipe-cook')) throw new Error('missing recipe-cook export');",
  },
  {
    name: '@farmslot/handoff',
    dir: 'packages/handoff',
    publicDoc: 'https://farmslot.io/docs/guides/learning-package',
    requiredFiles: [
      'README.md',
      'LICENSE',
      'src/index.ts',
      'src/bin/handoff.ts',
      'schemas/manifest.schema.json',
      'schemas/index-row.schema.json',
      'templates/task-default.md',
    ],
    packRequiredFiles: [
      'README.md',
      'LICENSE',
      'dist/index.js',
      'dist/index.d.ts',
      'dist/bin/handoff.js',
      'schemas/manifest.schema.json',
      'schemas/index-row.schema.json',
      'templates/task-default.md',
    ],
    importCheck:
      "const m = await import('./packages/handoff/dist/index.js'); if (typeof m.assembleLearningPackage !== 'function' || m.SCHEMA_VERSION !== 1) throw new Error('missing handoff root exports');",
  },
];

const failures = [];
const localPackageNames = new Set(packages.map((pkgSpec) => pkgSpec.name));

function parsePackageFilter(argv) {
  const packageArg = argv.find((arg) => arg.startsWith('--packages='));
  const inlineValue = packageArg?.slice('--packages='.length);
  const flagIndex = argv.indexOf('--packages');
  const nextValue = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  const value = inlineValue ?? nextValue;
  if (!value) return undefined;
  return new Set(
    value
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

function packageSpecsToCheck() {
  if (!packageFilter) return packages;
  const unknownPackages = [...packageFilter].filter(
    (packageName) => !packages.some((pkgSpec) => pkgSpec.name === packageName),
  );
  for (const packageName of unknownPackages) fail(`Unknown package selected: ${packageName}.`);
  return packages.filter((pkgSpec) => packageFilter.has(pkgSpec.name));
}

function fail(message) {
  failures.push(message);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '')
    fail(`${label} must be a non-empty string.`);
}

function checkPackage(pkgSpec) {
  const pkgPath = path.join(pkgSpec.dir, 'package.json');
  const readmePath = path.join(pkgSpec.dir, 'README.md');
  const changelogPath = path.join(pkgSpec.dir, 'CHANGELOG.md');
  const pkg = readJson(pkgPath);
  const readme = readFileSync(readmePath, 'utf8');

  if (pkg.name !== pkgSpec.name) fail(`${pkgPath} name must be ${pkgSpec.name}.`);
  requireString(pkg.version, `${pkg.name} version`);
  requireString(pkg.homepage, `${pkg.name} homepage`);
  if (pkg.homepage !== pkgSpec.publicDoc)
    fail(`${pkg.name} homepage must be ${pkgSpec.publicDoc}.`);
  if (!readme.includes(pkgSpec.publicDoc)) fail(`${readmePath} must link to ${pkgSpec.publicDoc}.`);
  const forbiddenReadmeMarkers = [
    process.env.FARMSLOT_PRIVATE_GITHUB_MARKER,
    ...(process.env.FARMSLOT_PRIVATE_GITHUB_MARKERS ?? '')
      .split(',')
      .map((marker) => marker.trim())
      .filter(Boolean),
  ].filter(Boolean);
  for (const marker of forbiddenReadmeMarkers) {
    if (readme.includes(marker)) fail(`${readmePath} must not link to private GitHub paths.`);
  }
  if (!pkg.repository || pkg.repository.type !== 'git')
    fail(`${pkg.name} must declare git repository metadata.`);
  if (pkg.repository?.url !== 'git+https://github.com/deeeed/farmslot.git') {
    fail(`${pkg.name} repository.url must point to the public Farmslot repo location.`);
  }
  if (pkg.repository?.directory !== pkgSpec.dir)
    fail(`${pkg.name} repository.directory must be ${pkgSpec.dir}.`);
  if (!pkg.bugs?.url) fail(`${pkg.name} must declare bugs.url.`);
  if (!Array.isArray(pkg.files) || pkg.files.length === 0)
    fail(`${pkg.name} must declare package files.`);
  if (!pkg.exports) fail(`${pkg.name} must declare exports.`);
  if (pkg.license !== 'MIT') fail(`${pkg.name} license metadata must be MIT.`);
  checkWorkspaceDependencyLinks(pkg);
  const packageLicensePath = path.join(pkgSpec.dir, 'LICENSE');
  if (!existsSync(packageLicensePath)) {
    fail(`${pkg.name} must include a package LICENSE file.`);
  } else if (readFileSync(packageLicensePath, 'utf8') !== rootLicense) {
    fail(`${pkg.name} package LICENSE must match the repository LICENSE.`);
  }
  for (const file of pkgSpec.requiredFiles) {
    if (!existsSync(path.join(pkgSpec.dir, file)))
      fail(`${pkg.name} required file missing from checkout: ${file}.`);
  }
  if (runPack) {
    for (const file of pkgSpec.packRequiredFiles ?? []) {
      if (!existsSync(path.join(pkgSpec.dir, file)))
        fail(`${pkg.name} built package file missing from checkout: ${file}.`);
    }
  }

  if (strictPublish) {
    if (pkg.private === true)
      fail(`${pkg.name} is still private; keep this until final publish approval.`);
    if (!pkg.publishConfig || pkg.publishConfig.access !== 'public') {
      fail(`${pkg.name} strict publish requires publishConfig.access=public.`);
    }
  }
  if (requireChangelog) checkPublishChangelog(pkg, changelogPath);
}

function checkWorkspaceDependencyLinks(pkg) {
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  for (const section of sections) {
    const dependencies = pkg[section];
    if (!dependencies || typeof dependencies !== 'object') continue;
    for (const [dependencyName, dependencyRange] of Object.entries(dependencies)) {
      if (!localPackageNames.has(dependencyName)) continue;
      if (typeof dependencyRange === 'string' && dependencyRange.startsWith('workspace:')) continue;
      fail(
        `${pkg.name} ${section}.${dependencyName} must use workspace:* so local builds cannot resolve a stale published sibling package.`,
      );
    }
  }
}

function checkPublishChangelog(pkg, changelogPath) {
  if (!existsSync(changelogPath)) {
    fail(`${pkg.name} release requires ${changelogPath}.`);
    return;
  }
  const changelog = readFileSync(changelogPath, 'utf8');
  const releasedHeading = new RegExp(`^##\\s+\\[?${escapeRegExp(pkg.version)}\\]?\\b`);
  const section =
    extractChangelogSection(changelog, (line) => releasedHeading.test(line)) ??
    extractChangelogSection(changelog, (line) => /^##\s+Unreleased\b/i.test(line)) ??
    '';
  const meaningfulLines = section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'))
    .filter(
      (line) =>
        !/active-development baseline/i.test(line) &&
        !/add user-facing changes here/i.test(line) &&
        !/before release or package publication/i.test(line),
    );
  if (meaningfulLines.length === 0) {
    fail(
      `${pkg.name} release requires a non-placeholder CHANGELOG entry under ## Unreleased or ## ${pkg.version}.`,
    );
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractChangelogSection(changelog, headingMatches) {
  const lines = changelog.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => headingMatches(line.trim()));
  if (headingIndex < 0) return undefined;
  const sectionLines = [];
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) break;
    sectionLines.push(lines[i]);
  }
  return sectionLines.join('\n');
}

function checkNpmScopeConfig() {
  const yarnrc = readFileSync('.yarnrc.yml', 'utf8');
  const requiredSnippets = [
    'npmScopes:',
    'farmslot:',
    'npmRegistryServer:',
    'https://registry.npmjs.org',
    'npmPublishRegistry:',
    'npmAuthToken:',
    'NPM_FARMSLOT_TOKEN',
  ];
  for (const snippet of requiredSnippets) {
    if (!yarnrc.includes(snippet)) fail(`.yarnrc.yml missing ${snippet}`);
  }
  if (strictPublish && !process.env.NPM_FARMSLOT_TOKEN) {
    fail('NPM_FARMSLOT_TOKEN must be set for strict publish checks.');
  }
  if (strictPublish && /^npm\//i.test(process.env.npm_config_user_agent ?? '')) {
    fail(
      'Direct npm publish preserves workspace:* dependencies in the public manifest. Use yarn npm publish.',
    );
  }
}

function buildPackage(pkgSpec) {
  const result = spawnSync('yarn', ['workspace', pkgSpec.name, 'build'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(`${pkgSpec.name} build failed:\n${result.stderr || result.stdout}`);
    return false;
  }
  return true;
}

function checkWorkspaceInstallShadows(pkgSpec) {
  const scopeDir = path.join(pkgSpec.dir, 'node_modules', '@farmslot');
  if (!existsSync(scopeDir)) return;
  for (const localPkgSpec of packages) {
    const installedPath = path.join(scopeDir, localPkgSpec.name.slice('@farmslot/'.length));
    if (!existsSync(installedPath)) continue;
    const expectedPath = path.join(repoRoot, localPkgSpec.dir);
    const installedRealPath = realpathSync(installedPath);
    const expectedRealPath = realpathSync(expectedPath);
    if (installedRealPath === expectedRealPath) continue;
    const kind = lstatSync(installedPath).isSymbolicLink() ? 'symlink' : 'copy';
    fail(
      `${pkgSpec.name} has a stale local ${kind} at ${installedPath}; remove it so builds resolve ${localPkgSpec.name} from the workspace.`,
    );
  }
}

function checkPack(pkgSpec) {
  const result = spawnSync('yarn', ['workspace', pkgSpec.name, 'pack', '--dry-run', '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(`${pkgSpec.name} yarn pack --dry-run failed:\n${result.stderr || result.stdout}`);
    return;
  }
  const files = result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => typeof entry.location === 'string')
    .map((entry) => entry.location);
  for (const required of pkgSpec.packRequiredFiles ?? pkgSpec.requiredFiles) {
    if (!files.includes(required)) fail(`${pkgSpec.name} pack output missing ${required}.`);
  }
  const forbidden = files.filter(
    (file) =>
      file.includes('/build/') ||
      file.includes('/node_modules/') ||
      file.endsWith('.test.ts') ||
      file.endsWith('.log') ||
      file.startsWith('temp/') ||
      file.startsWith('.env'),
  );
  if (forbidden.length > 0)
    fail(`${pkgSpec.name} pack includes forbidden files: ${forbidden.join(', ')}`);
  console.log(`${pkgSpec.name}: pack dry-run includes ${files.length} files`);
}

function checkBuiltPackageImports(pkgSpec) {
  if (!pkgSpec.importCheck) return;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', pkgSpec.importCheck],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    fail(`${pkgSpec.name} built import check failed:\n${result.stderr || result.stdout}`);
  }
}

function checkTempConsumerSmoke() {
  const result = spawnSync(process.execPath, ['scripts/quality/check-package-temp-consumer.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(`package temp-consumer smoke failed:\n${result.stderr || result.stdout}`);
    return;
  }
  process.stdout.write(result.stdout);
}

checkNpmScopeConfig();
const selectedPackages = packageSpecsToCheck();
for (const pkgSpec of selectedPackages) checkWorkspaceInstallShadows(pkgSpec);
if (runPack) for (const pkgSpec of selectedPackages) buildPackage(pkgSpec);
for (const pkgSpec of selectedPackages) checkPackage(pkgSpec);
if (runPack) for (const pkgSpec of selectedPackages) checkBuiltPackageImports(pkgSpec);
if (runPack) for (const pkgSpec of selectedPackages) checkPack(pkgSpec);
if (runPack) checkTempConsumerSmoke();

if (failures.length > 0) {
  console.error('Farmslot package readiness failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const mode = strictPublish ? 'strict publish' : 'guarded private';
console.log(`Farmslot package readiness passed (${mode} mode).`);
