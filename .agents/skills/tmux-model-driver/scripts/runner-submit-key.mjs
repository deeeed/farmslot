import { runnerPromptSubmitKey } from '../../../../services/gateway/src/runners/registry.ts';

const runner = process.argv[2];
if (!runner) {
  process.stderr.write('usage: runner-submit-key.mjs <runner>\n');
  process.exit(1);
}

process.stdout.write(`${runnerPromptSubmitKey(runner)}\n`);
