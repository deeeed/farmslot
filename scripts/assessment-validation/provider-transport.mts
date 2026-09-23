import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
assert.equal(process.env.FARMSLOT_ASSESSMENT_VALIDATION, '1');
const out = process.env.ASSESSMENT_PROVIDER_PROOF_OUT;
assert.ok(out);
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body));
  const ordinary = url.endsWith('/v1/responses');
  assert.ok(ordinary || body.questions, 'Unexpected external request blocked');
  await appendFile(
    path.join(out, 'requests.jsonl'),
    JSON.stringify({ provider: ordinary ? 'codex-lb' : 'typesafe', model: body.model }) + '\n',
  );
  const mode = (await readFile(path.join(out, 'mode'), 'utf8')).trim();
  if (mode === 'timeout')
    await new Promise((_, reject) =>
      init?.signal?.addEventListener('abort', () => reject(new Error('fixture timeout')), {
        once: true,
      }),
    );
  if (ordinary) {
    assert.equal(body.text.format.strict, true);
    if (mode === 'invalid-tail') {
      const terminal = {
        type: 'response.completed',
        response: {
          id: 'resp_fixture',
          status: 'completed',
          model: body.model,
          usage: {
            input_tokens: 120,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 10 },
          },
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '{"answers":{"color":"blue"}}' }],
            },
          ],
        },
      };
      return new Response(
        `event: response.completed\ndata: ${JSON.stringify(terminal)}\n\nevent: response.failed\ndata: {invalid}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response(
      JSON.stringify({
        id: 'resp_fixture',
        status: 'completed',
        model: mode === 'wrong-model' ? 'unexpected-model' : body.model,
        usage: {
          input_tokens: 120,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 },
        },
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  answers: { color: mode === 'invalid' ? 'invalid-choice' : 'blue' },
                }),
              },
            ],
          },
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(
    JSON.stringify({
      model: body.model,
      answers: {
        color: {
          type: 'choice',
          choice: mode === 'native-invalid' ? 'invalid-choice' : 'blue',
          confidence: 0.9,
          probabilities: { blue: 0.9, red: 0.1 },
        },
      },
      usage: {
        input_tokens:
          mode === 'native-invalid' ? 321 : mode === 'native-invalid-usage' ? 70000.5 : 100,
        output_tokens: mode === 'native-invalid' || mode === 'native-invalid-usage' ? 30 : 20,
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
};
