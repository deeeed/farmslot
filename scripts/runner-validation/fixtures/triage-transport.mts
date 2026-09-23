import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';

assert.equal(process.env.FARMSLOT_ASSESSMENT_VALIDATION, '1');
const out = process.env.TRIAGE_PILOT_PROOF_OUT;
assert.ok(out);
// Owned proof process only. Never forward a request to a real provider.
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  assert.ok(body.questions && body.state, 'Unexpected external fetch blocked');
  const bytes = JSON.stringify(body);
  assert.ok(!bytes.includes('triage-canary-private'));
  assert.ok(!bytes.includes('"approvals"') && !bytes.includes('"reference"'));
  await appendFile(
    path.join(out, 'requests.jsonl'),
    JSON.stringify({ mode: 'simulated', state: body.state, questions: body.questions }) + '\n',
  );
  const mode = (await readFile(path.join(out, 'mode'), 'utf8')).trim();
  if (mode === 'hang')
    await new Promise((_, reject) =>
      init?.signal?.addEventListener('abort', () => reject(new Error('simulated abort')), {
        once: true,
      }),
    );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const selected = { cause: 'environment', nextCheck: 'inspect_external_response', evidence: 'e1' };
  const answers = Object.fromEntries(
    Object.entries(body.questions).map(([id, question]) => {
      const q = question as { criteria: Record<string, string> };
      const choice = selected[id as keyof typeof selected];
      return [
        id,
        {
          type: 'choice',
          choice,
          confidence: 0.7,
          probabilities: Object.fromEntries(
            Object.keys(q.criteria).map((k) => [k, k === choice ? 1 : 0]),
          ),
        },
      ];
    }),
  );
  return new Response(
    JSON.stringify({
      model:
        mode === 'wrong-model' || mode === 'over-bound-wrong-model'
          ? 'unexpected-model'
          : mode === 'missing-model'
            ? undefined
            : body.model,
      answers: ['malformed', 'over-bound-invalid'].includes(mode) ? {} : answers,
      usage: { input_tokens: mode.startsWith('over-bound') ? 70000 : 321, output_tokens: 30 },
    }),
    {
      headers: { 'content-type': 'application/json', 'x-request-id': 'fixture-request' },
    },
  );
};
