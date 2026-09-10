import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import Ajv from 'ajv';

import type { PRRuleSourceProgress, PRTeamProfile, PRTriggerRule } from '@farmslot/protocol';

import { writeAtomicJSON } from '../core/atomic-json.js';
import { githubRequestCacheKey } from '../integrations/github-client.js';
import { GitHubCursorError } from '../integrations/github-errors.js';
import type { GitHubPage, GitHubQueryAccount } from '../integrations/github-graphql.js';

import type { PRSourceScan } from './preview.js';

export interface PRSourceCheckpointScope {
  key: string;
  ownerId: string;
  teamId: string;
  teamRevision: number;
  ruleId: string;
  ruleRevision: number;
}
export type PRSourceProgress = PRRuleSourceProgress;

interface ConnectionCheckpoint {
  key: string;
  generation: string;
  dependencies: string[];
  cursor: string | null;
  seen: string[];
  nodes: unknown[];
  pages: number;
  complete: boolean;
  firstPageAt?: string;
}
interface TraversalCheckpoint {
  scope: PRSourceCheckpointScope;
  generation: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: PRSourceScan;
  connections: ConnectionCheckpoint[];
}
interface CheckpointData {
  version: 1;
  traversals: TraversalCheckpoint[];
}
const text = { type: 'string', minLength: 1 };
const timestamp = { ...text, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' };
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const validate = new Ajv().compile<CheckpointData>({
  type: 'object',
  additionalProperties: false,
  required: ['version', 'traversals'],
  properties: {
    version: { const: 1 },
    traversals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scope', 'generation', 'startedAt', 'updatedAt', 'connections'],
        properties: {
          scope: {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'ownerId', 'teamId', 'teamRevision', 'ruleId', 'ruleRevision'],
            properties: {
              key: text,
              ownerId: text,
              teamId: text,
              teamRevision: count,
              ruleId: text,
              ruleRevision: count,
            },
          },
          generation: text,
          startedAt: timestamp,
          updatedAt: timestamp,
          completedAt: timestamp,
          result: {
            type: 'object',
            required: ['subjects', 'complete', 'errors', 'ignoredItems'],
            properties: {
              subjects: { type: 'array' },
              complete: { const: true },
              errors: { type: 'array', items: text },
              ignoredItems: count,
            },
          },
          connections: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'key',
                'generation',
                'dependencies',
                'cursor',
                'seen',
                'nodes',
                'pages',
                'complete',
              ],
              properties: {
                key: text,
                generation: text,
                dependencies: { type: 'array', uniqueItems: true, items: text },
                cursor: { type: ['string', 'null'] },
                seen: { type: 'array', uniqueItems: true, items: text },
                nodes: { type: 'array' },
                pages: count,
                complete: { type: 'boolean' },
                firstPageAt: timestamp,
              },
            },
          },
        },
      },
    },
  },
});

export function prSourceCheckpointScope(
  team: Pick<PRTeamProfile, 'ownerId' | 'id' | 'revision'>,
  rule: Pick<PRTriggerRule, 'ownerId' | 'id' | 'revision'>,
  account: GitHubQueryAccount,
): PRSourceCheckpointScope {
  if (team.ownerId !== rule.ownerId) throw new Error('Source checkpoint owner mismatch');
  const identity = {
    ownerId: team.ownerId,
    teamId: team.id,
    teamRevision: team.revision,
    ruleId: rule.id,
    ruleRevision: rule.revision,
  };
  // The credential itself never reaches persistence, diagnostics, or the public progress record.
  const key = createHash('sha256')
    .update(JSON.stringify(['pr-source-v1', identity, githubRequestCacheKey([], account)]))
    .digest('hex');
  return { ...identity, key };
}

export class PRSourceCheckpoints {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly running = new Map<
    string,
    Promise<PRSourceScan & { progress: PRSourceProgress }>
  >();
  private constructor(
    private readonly file: string,
    private data: CheckpointData,
  ) {}
  static async load(file: string): Promise<PRSourceCheckpoints> {
    let contents: string;
    try {
      contents = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return new PRSourceCheckpoints(file, { version: 1, traversals: [] });
    }
    const data: unknown = JSON.parse(contents);
    if (!validate(data)) throw new Error('Invalid PR source checkpoint store');
    if (new Set(data.traversals.map((item) => item.scope.key)).size !== data.traversals.length)
      throw new Error('Duplicate PR source checkpoint scope');
    for (const item of data.traversals) {
      if (
        !!item.result !== !!item.completedAt ||
        (item.result && item.connections.some((connection) => !connection.complete)) ||
        new Set(item.connections.map((connection) => connection.key)).size !==
          item.connections.length
      )
        throw new Error('Invalid PR source traversal state');
    }
    return new PRSourceCheckpoints(file, data);
  }
  private change<T>(mutate: (data: CheckpointData) => T): Promise<T> {
    const operation = async () => {
      const copy = structuredClone(this.data);
      const result = mutate(copy);
      await writeAtomicJSON(this.file, copy);
      this.data = copy;
      return structuredClone(result);
    };
    const work = this.writes.then(operation, operation);
    this.writes = work; // A failed write reaches its caller; the next transaction can retry.
    return work;
  }
  private traversal(data: CheckpointData, id: string): TraversalCheckpoint {
    const found = data.traversals.find((item) => item.generation === id);
    if (!found) throw new Error('Source traversal was superseded; retry its current generation');
    return found;
  }
  current(id: string): boolean {
    return this.data.traversals.some((item) => item.generation === id);
  }
  progress(id: string, requestsThisAttempt = 0, resumed = false): PRSourceProgress {
    const record = this.traversal(this.data, id);
    const observed = record.connections
      .flatMap((connection) => (connection.firstPageAt ? [connection.firstPageAt] : []))
      .sort();
    return {
      id,
      startedAt: record.startedAt,
      oldestObservationAt: observed[0],
      completedAt: record.completedAt,
      pages: record.connections.reduce((sum, connection) => sum + connection.pages, 0),
      items: record.connections.reduce((sum, connection) => sum + connection.nodes.length, 0),
      pendingConnections: record.connections.filter((connection) => !connection.complete).length,
      requestsThisAttempt,
      resumed,
    };
  }
  read(
    scope: PRSourceCheckpointScope,
    requestLimit: number,
    collect: (traversal: PRSourceTraversal) => Promise<PRSourceScan>,
    maxCompletedAgeMs = 60_000,
  ): Promise<PRSourceScan & { progress: PRSourceProgress }> {
    if (!Number.isSafeInteger(requestLimit) || requestLimit < 1)
      throw new Error('Source request limit must be positive');
    const existing = this.running.get(scope.key);
    if (existing) return existing;
    const work = this.readOnce(scope, requestLimit, collect, maxCompletedAgeMs).finally(() =>
      this.running.delete(scope.key),
    );
    this.running.set(scope.key, work);
    return work;
  }
  private async readOnce(
    scope: PRSourceCheckpointScope,
    requestLimit: number,
    collect: (traversal: PRSourceTraversal) => Promise<PRSourceScan>,
    maxCompletedAgeMs: number,
  ): Promise<PRSourceScan & { progress: PRSourceProgress }> {
    const record = await this.change((data) => {
      let record = data.traversals.find((item) => item.scope.key === scope.key);
      // Incomplete traversals never expire by age: an active low-cadence rule must retain progress.
      if (record?.completedAt && Date.now() - Date.parse(record.completedAt) > maxCompletedAgeMs) {
        data.traversals = data.traversals.filter((item) => item !== record);
        record = undefined;
      }
      if (!record) {
        const now = new Date().toISOString();
        record = {
          scope,
          generation: randomUUID(),
          startedAt: now,
          updatedAt: now,
          connections: [],
        };
        data.traversals.push(record);
      }
      return record;
    });
    if (record.result)
      return { ...record.result, progress: this.progress(record.generation, 0, true) };
    const traversal = new PRSourceTraversal(this, record.generation, requestLimit);
    const result = await collect(traversal);
    if (result.complete)
      await this.change((data) => {
        const current = this.traversal(data, record.generation);
        if (current.connections.some((connection) => !connection.complete))
          throw new Error('Cannot complete a traversal with unfinished connections');
        current.result = structuredClone(result);
        current.completedAt = current.updatedAt = new Date().toISOString();
      });
    if (
      !result.complete &&
      !traversal.interrupted &&
      this.progress(record.generation).pendingConnections === 0
    ) {
      await this.invalidate(
        record.generation,
        this.traversal(this.data, record.generation).connections.map(
          (connection) => connection.key,
        ),
      );
    }
    const progress = this.progress(
      record.generation,
      traversal.requests,
      record.connections.length > 0,
    );
    if (!result.complete && traversal.interrupted)
      progress.nextAttemptAt = new Date(Date.now() + 30_000).toISOString();
    return { ...result, progress };
  }
  connection(id: string, key: string): ConnectionCheckpoint | undefined {
    return structuredClone(
      this.traversal(this.data, id).connections.find((item) => item.key === key),
    );
  }
  async intend(id: string, key: string, dependencies: string[]): Promise<ConnectionCheckpoint> {
    const existing = this.connection(id, key);
    if (existing) return existing;
    return this.change((data) => {
      const record = this.traversal(data, id);
      const existing = record.connections.find((item) => item.key === key);
      if (existing) return existing;
      const connection: ConnectionCheckpoint = {
        key,
        generation: randomUUID(),
        dependencies: [...new Set(dependencies)],
        cursor: null,
        seen: [],
        nodes: [],
        pages: 0,
        complete: false,
      };
      record.connections.push(connection);
      return connection;
    });
  }
  append(
    id: string,
    expected: ConnectionCheckpoint,
    page: GitHubPage<unknown>,
    observedAt: string,
  ): Promise<void> {
    return this.change((data) => {
      const record = this.traversal(data, id);
      const current = record.connections.find((item) => item.key === expected.key);
      if (
        !current ||
        current.generation !== expected.generation ||
        current.pages !== expected.pages ||
        current.complete
      )
        throw new Error('Connection checkpoint changed during the provider read');
      const indexes = new Map(
        current.nodes.flatMap((node, index) =>
          node && typeof node === 'object' && 'id' in node && typeof node.id === 'string'
            ? [[node.id, index] as const]
            : [],
        ),
      );
      for (const node of structuredClone(page.nodes)) {
        const key =
          node && typeof node === 'object' && 'id' in node && typeof node.id === 'string'
            ? node.id
            : undefined;
        const index = key === undefined ? undefined : indexes.get(key);
        if (index === undefined) {
          if (key !== undefined) indexes.set(key, current.nodes.length);
          current.nodes.push(node);
        } else current.nodes[index] = node;
      }
      current.pages++;
      current.firstPageAt ??= observedAt;
      current.complete = !page.pageInfo.hasNextPage;
      current.cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      if (current.cursor) current.seen.push(current.cursor);
      record.updatedAt = new Date().toISOString();
    });
  }
  invalidate(id: string, keys: string[]): Promise<void> {
    return this.change((data) => {
      const record = this.traversal(data, id);
      const removed = new Set(keys);
      for (;;) {
        const before = removed.size;
        for (const connection of record.connections)
          if (connection.dependencies.some((key) => removed.has(key))) removed.add(connection.key);
        if (removed.size === before) break;
      }
      record.connections = record.connections.filter((connection) => !removed.has(connection.key));
      delete record.result;
      delete record.completedAt;
      record.updatedAt = new Date().toISOString();
    });
  }
  refreshPR(
    id: string,
    pr: { id: string; headRefOid: string },
    dependentKeys: string[],
  ): Promise<void> {
    return this.change((data) => {
      const record = this.traversal(data, id);
      for (const connection of record.connections) {
        for (const node of connection.nodes) {
          if (!node || typeof node !== 'object') continue;
          if ('id' in node && node.id === pr.id && 'headRefOid' in node)
            Object.assign(node, structuredClone(pr));
          if (
            'content' in node &&
            node.content &&
            typeof node.content === 'object' &&
            'id' in node.content &&
            node.content.id === pr.id
          )
            Object.assign(node.content, structuredClone(pr));
        }
      }
      record.connections = record.connections.filter(
        (connection) => !dependentKeys.includes(connection.key),
      );
      delete record.result;
      delete record.completedAt;
      record.updatedAt = new Date().toISOString();
    });
  }
  consume(id: string): Promise<boolean> {
    return this.change((data) => {
      const record = data.traversals.find((item) => item.generation === id);
      if (!record?.result) return false;
      data.traversals = data.traversals.filter((item) => item !== record);
      return true;
    });
  }
  prune(valid: Array<Omit<PRSourceCheckpointScope, 'key'>>): Promise<void> {
    return this.change((data) => {
      data.traversals = data.traversals.filter((record) =>
        valid.some(
          (scope) =>
            scope.ownerId === record.scope.ownerId &&
            scope.teamId === record.scope.teamId &&
            scope.teamRevision === record.scope.teamRevision &&
            scope.ruleId === record.scope.ruleId &&
            scope.ruleRevision === record.scope.ruleRevision,
        ),
      );
    });
  }
}

export class PRSourceTraversal {
  requests = 0;
  interrupted = false;
  get exhausted(): boolean {
    return this.requests >= this.limit;
  }
  get progress(): PRSourceProgress {
    return this.store.progress(this.id, this.requests);
  }
  invalidate(keys: string[]): Promise<void> {
    return this.store.invalidate(this.id, keys);
  }
  refreshPR(pr: { id: string; headRefOid: string }, dependentKeys: string[]): Promise<void> {
    return this.store.refreshPR(this.id, pr, dependentKeys);
  }
  constructor(
    private readonly store: PRSourceCheckpoints,
    readonly id: string,
    private readonly limit: number,
  ) {}
  async pages<T>(
    key: string,
    fetch: (cursor: string | null) => Promise<GitHubPage<T>>,
    dependencies: string[] = [],
  ): Promise<T[]> {
    try {
      return await this.readPages(key, fetch, dependencies);
    } catch (error) {
      this.interrupted = true;
      throw error;
    }
  }
  private async readPages<T>(
    key: string,
    fetch: (cursor: string | null) => Promise<GitHubPage<T>>,
    dependencies: string[],
  ): Promise<T[]> {
    // Persist intent before enforcing the request budget, including a connection not fetched yet.
    let connection = await this.store.intend(this.id, key, dependencies);
    while (!connection.complete) {
      if (this.requests >= this.limit)
        throw new Error(
          `Source scan paused after ${this.requests} requests; pagination checkpoint saved for continuation`,
        );
      this.requests++;
      const observedAt = new Date().toISOString();
      let page: GitHubPage<T>;
      try {
        page = await fetch(connection.cursor);
      } catch (error) {
        if (error instanceof GitHubCursorError) await this.store.invalidate(this.id, [key]);
        throw error;
      }
      if (
        !page ||
        !Array.isArray(page.nodes) ||
        page.nodes.some((node) => node === null || node === undefined) ||
        typeof page.pageInfo?.hasNextPage !== 'boolean'
      )
        throw new Error('GitHub returned an incomplete connection');
      if (
        page.pageInfo.hasNextPage &&
        (!page.pageInfo.endCursor || connection.seen.includes(page.pageInfo.endCursor))
      ) {
        await this.store.invalidate(this.id, [key]);
        throw new Error('GitHub cursor did not advance; connection and dependent facts were reset');
      }
      await this.store.append(this.id, connection, page, observedAt);
      connection = this.store.connection(this.id, key)!;
    }
    return connection.nodes as T[];
  }
}
