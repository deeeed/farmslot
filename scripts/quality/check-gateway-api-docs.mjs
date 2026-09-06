#!/usr/bin/env node
/**
 * Freshness guard for apps/docs/docs/reference/gateway-api.generated.md.
 *
 * The reference is generated from @farmslot/protocol capability metadata, so it
 * goes stale every time a gateway method or event is added without re-running
 * the generator. Regenerate here and fail when the committed file differs.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATED_DOC = 'apps/docs/docs/reference/gateway-api.generated.md';

function run(command, args) {
  return spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
}

function requireSuccess(result) {
  if (result.status === 0) return;
  console.error(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

// The generator imports the built @farmslot/protocol entrypoint, so a stale
// dist/ would regenerate the reference from an out-of-date capability list and
// report a fresh file that does not match source.
requireSuccess(run('yarn', ['workspace', '@farmslot/protocol', 'build']));
requireSuccess(run('yarn', ['--cwd', 'apps/docs', 'generate:api']));

if (run('git', ['diff', '--quiet', '--', GENERATED_DOC]).status !== 0) {
  console.error('GATEWAY_API_DOCS_STALE');
  console.error(`Run yarn docs:gateway-api and commit ${GENERATED_DOC}.`);
  process.exit(1);
}

console.log('GATEWAY_API_DOCS_FRESH');
