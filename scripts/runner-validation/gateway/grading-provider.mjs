// Transport-only fixture, loaded exclusively by the disposable grading gateway.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const proofFile = process.env.GRADING_PROOF_FILE;
assert.ok(proofFile, 'grading fixture requires its isolated proof path');
const record = (event) => appendFileSync(proofFile, `${JSON.stringify(event)}\n`);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('http://127.0.0.1:2455/v1/')) return originalFetch(input, options);
  const body = JSON.parse(String(options?.body));
  if (JSON.stringify(body).includes('Grade this bug:')) {
    record({ event: 'grading-request' });
    options.signal.addEventListener('abort', () => record({ event: 'grading-aborted' }), {
      once: true,
    });
    // Deliberately ignore cancellation: dispatch still must leave grading.
    return new Promise(() => {});
  }
  record({ event: 'summary-request' });
  return new Response(
    JSON.stringify({
      id: 'resp_grading_fixture',
      status: 'completed',
      model: body.model,
      usage: { input_tokens: 10, output_tokens: 10 },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({ summary: 'Correct warning copy', branchSlug: 'warning-copy' }),
            },
          ],
        },
      ],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
};

// Negative control changes only this child process's loaded module, never the
// operator checkout or its running gateway.
if (
  process.env.GRADING_NEGATIVE_CONTROL === '1' ||
  process.env.GRADING_CLI_NEGATIVE_CONTROL === '1'
) {
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!url.endsWith('/services/gateway/src/intelligence/engine.ts')) return loaded;
      const source = String(loaded.source);
      const deadlineControl = process.env.GRADING_NEGATIVE_CONTROL === '1';
      const changed = deadlineControl
        ? source.replace(
            /const GRADE_TIMEOUT_MS\s*=\s*(?:30_000|30000|3e4)/,
            'const GRADE_TIMEOUT_MS = 3600000',
          )
        : source.replace(/allowCliFallback:\s*false/, 'allowCliFallback: true');
      assert.notEqual(changed, source, 'negative control must mutate its grading protection');
      record({ event: deadlineControl ? 'deadline-disabled' : 'cli-fallback-enabled' });
      return { ...loaded, source: changed };
    },
  });
}
