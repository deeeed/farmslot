import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { promisify } from 'node:util';

const responses: Array<{ stdout: string; failed?: boolean }> = [];
let calls = 0;
const fakeExecFile = Object.assign(
  () => {
    throw new Error('Use the promisified process adapter');
  },
  {
    [promisify.custom]: async () => {
      calls++;
      const response = responses.shift();
      assert(response, 'Unexpected GitHub process invocation');
      if (response.failed)
        throw Object.assign(new Error('GitHub request failed'), {
          stdout: response.stdout,
          stderr: 'provider failure',
          code: 1,
        });
      return { stdout: response.stdout, stderr: '' };
    },
  },
);
mock.module('node:child_process', { namedExports: { execFile: fakeExecFile } });
const { ghRequest } = await import('./github-client.js');
const { githubGraphQL } = await import('./github-graphql.js');

test('GraphQL HTTP 200 errors remain failed while their reset headers fence later queries', async () => {
  calls = 0;
  const reset = Math.floor(Date.now() / 1000) + 600;
  responses.push({
    failed: true,
    stdout: `HTTP/2.0 200 OK\r\nx-ratelimit-resource: graphql\r\nx-ratelimit-remaining: 0\r\nx-ratelimit-reset: ${reset}\r\n\r\n{"errors":[{"message":"API rate limit exceeded"}]}`,
  });
  const account = { host: 'github.com', token: 'test-quota-credential', scope: 'owner' };
  await assert.rejects(
    githubGraphQL('query { viewer { login } }', {}, account),
    /HTTP 200.*rate limit/,
  );
  await assert.rejects(
    githubGraphQL('query { viewer { id } }', {}, account),
    /query budget is reserved/,
  );
  assert.equal(calls, 1, 'A different query must not retry the exhausted credential');
});

test('nonzero 304 exits still serve the previously cached response', async () => {
  responses.push(
    { stdout: 'HTTP/2.0 200 OK\r\netag: "fixture"\r\n\r\n{"value":42}' },
    { failed: true, stdout: 'HTTP/2.0 304 Not Modified\r\n\r\n' },
  );
  const args = ['api', 'repos/owner/repo'];
  const account = { host: 'github.com', token: 'test-etag-credential', scope: 'owner' };
  assert.equal((await ghRequest(args, { account })).stdout, '{"value":42}');
  assert.equal((await ghRequest(args, { account })).stdout, '{"value":42}');
});

test('paginated and non-API failures cannot become successful command outputs', async () => {
  responses.push(
    { failed: true, stdout: 'HTTP/2.0 403 Forbidden\r\n\r\n{}' },
    { failed: true, stdout: 'some partial output' },
  );
  await assert.rejects(
    ghRequest(['api', '--include', '--paginate', 'repos/owner/repo/issues']),
    /provider failure/,
  );
  await assert.rejects(ghRequest(['pr', 'view', '1']), /provider failure/);
});

test('provider cursor rejection retains a structured error through failed HTTP output', async () => {
  const { GitHubCursorError } = await import('./github-errors.js');
  responses.push({
    failed: true,
    stdout:
      'HTTP/2.0 200 OK\r\n\r\n{"errors":[{"type":"INVALID_CURSOR_ARGUMENTS","message":"The cursor is invalid"}]}',
  });
  await assert.rejects(
    githubGraphQL(
      'query($cursor:String) { viewer { id } }',
      { cursor: 'invalid' },
      { host: 'github.com', token: 'cursor-test-credential', scope: 'owner' },
    ),
    GitHubCursorError,
  );
});

test('only structured missing repository or PR errors mean the target is unavailable', async () => {
  const { GitHubPRUnavailableError } = await import('./github-errors.js');
  for (const [index, path] of [
    ['repository'],
    ['repository', 'pullRequest'],
    ['node'],
    ['repository', 'pullRequest', 'labels'],
  ].entries()) {
    responses.push({
      failed: true,
      stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ errors: [{ type: 'NOT_FOUND', path, message: 'not found' }] })}`,
    });
    try {
      await githubGraphQL(
        'query { repository { id } }',
        {},
        { host: 'github.com', token: `test-not-found-${index}`, scope: 'owner' },
      );
      assert.fail('Provider errors must fail');
    } catch (error) {
      assert.equal(error instanceof GitHubPRUnavailableError, index < 2);
    }
  }
});
