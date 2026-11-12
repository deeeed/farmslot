// Local HTTP stand-in for the GitHub API. Point the gateway at it with
// FARMSLOT_GITHUB_API_URL=<origin>; every host's REST and GraphQL calls arrive here.
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { GitHubService, GraphQLServiceOpts, RestServiceOpts } from './github-client.js';

export interface GitHubFixtureRequest {
  method: string;
  /** Path without the query string, e.g. `/repos/o/r/pulls/1` or `/graphql`. */
  path: string;
  /** Path and raw query string as received, e.g. `/repos/o/r/pulls?state=closed`. */
  url: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
  /** Parsed JSON body, or undefined when the body is empty or not JSON. */
  json?: unknown;
}

export interface GitHubFixtureResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Objects are sent as JSON with an application/json content type. */
  body?: unknown;
}

export type GitHubFixtureHandler = (
  request: GitHubFixtureRequest,
) => GitHubFixtureResponse | Promise<GitHubFixtureResponse>;

export interface GitHubFixture {
  origin: string;
  requests: GitHubFixtureRequest[];
  close(): Promise<void>;
}

export async function startGitHubFixture(handler: GitHubFixtureHandler): Promise<GitHubFixture> {
  const requests: GitHubFixtureRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fixture');
      const body = Buffer.concat(chunks).toString('utf8');
      let json: unknown;
      if (body) {
        try {
          json = JSON.parse(body);
        } catch (error) {
          // Non-JSON request bodies (raw --input files) stay available as text.
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      const request: GitHubFixtureRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        url: `${url.pathname}${url.search}`,
        query: url.searchParams,
        headers: req.headers,
        body,
        json,
      };
      requests.push(request);
      Promise.resolve(handler(request)).then(
        (response) => {
          const isText = typeof response.body === 'string';
          const payload =
            response.body === undefined
              ? ''
              : isText
                ? response.body
                : JSON.stringify(response.body);
          res.writeHead(response.status ?? 200, {
            ...(response.body !== undefined && !isText
              ? { 'content-type': 'application/json; charset=utf-8' }
              : {}),
            ...response.headers,
          });
          res.end(payload);
        },
        (error: unknown) => {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ message: `fixture handler failed: ${String(error)}` }));
        },
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

/**
 * Overrides for a faked GitHubService. The generic reads answer untyped values: callers parse
 * what they receive, so a fake states the payload, not the type each caller asks for.
 */
export interface GitHubServiceOverrides extends Partial<Omit<GitHubService, 'rest' | 'graphql'>> {
  rest?: (method: string, path: string, opts?: RestServiceOpts) => Promise<unknown>;
  graphql?: (
    query: string,
    variables: Record<string, string | number | null>,
    opts?: GraphQLServiceOpts,
  ) => Promise<unknown>;
}

/**
 * The real service with test overrides, for `mock.module` named exports. The base is passed in
 * so this module never loads the client before a test has mocked its process adapters.
 */
export function fakeGitHubService(base: GitHubService, overrides: GitHubServiceOverrides) {
  return { ...base, ...overrides };
}
