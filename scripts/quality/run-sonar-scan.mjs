#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadEnvFiles } from '../lib/local-env.mjs';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
loadEnvFiles([join(repoRoot, '.env.sonar.local'), join(repoRoot, '.env')]);

if (process.argv.includes('--help')) {
  console.log(`Usage: yarn sonar:scan [scanner -D options]

Runs SonarScanner CLI from the repository root using local/CI environment variables.

Required:
  SONAR_HOST_URL       SonarQube/SonarCloud URL
  SONAR_PROJECT_KEY    Project key to analyze
  SONAR_TOKEN          Analysis token; kept in the environment, not passed on the command line

Optional:
  SONAR_ORGANIZATION   SonarCloud organization key
  .env.sonar.local     Local ignored file loaded before .env

Extra arguments are passed through to sonar-scanner, for example:
  yarn sonar:scan -- -Dsonar.branch.name=my-branch
`);
  process.exit(0);
}

const required = ['SONAR_HOST_URL', 'SONAR_PROJECT_KEY', 'SONAR_TOKEN'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing Sonar configuration: ${missing.join(', ')}.`);
  console.error('Copy .env.sonar.example to .env.sonar.local, fill it in, then retry.');
  process.exit(2);
}

const passthrough = process.argv.slice(2).filter((arg) => arg !== '--');
const args = [`-Dsonar.projectKey=${process.env.SONAR_PROJECT_KEY}`, ...passthrough];
if (process.env.SONAR_ORGANIZATION) {
  args.unshift(`-Dsonar.organization=${process.env.SONAR_ORGANIZATION}`);
}

const result = spawnSync('sonar-scanner', args, {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
  shell: false,
});

if (result.error) {
  if (result.error.code === 'ENOENT') {
    console.error('sonar-scanner was not found on PATH. Install SonarScanner CLI, then retry.');
    process.exit(127);
  }
  throw result.error;
}

if (result.signal) {
  console.error(`sonar-scanner terminated by signal ${result.signal}.`);
  process.exit(1);
}
process.exit(result.status ?? 1);
