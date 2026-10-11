const runner = process.argv[2];
if (!['claude', 'codex', 'cursor', 'gemini', 'grok', 'shell'].includes(runner)) {
  process.stderr.write('usage: runner-submit-key.mjs <runner>\n');
  process.exit(1);
}
process.stdout.write('Enter\n');
