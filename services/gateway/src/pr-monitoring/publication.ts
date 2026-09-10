import { monitoredPRKey, type PRProjectMonitorPolicy, type Run } from '@farmslot/protocol';

import { loadProjectConfig } from '../fleet/state.js';
import { getAllRuns } from '../runs/store.js';

import type { PRMonitoringService } from './service.js';
import type { PRMonitorStore } from './store.js';

export class PRPublicationEnrollment {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private readonly failures = new Map<
    string,
    { ownerId: string; project: string; message: string }
  >();

  constructor(
    private readonly store: PRMonitorStore,
    private readonly monitors: Pick<PRMonitoringService, 'enrolled'>,
    private readonly authorized: (ownerId: string) => boolean,
    private readonly runs: () => Run[] = getAllRuns,
    private readonly repository: (project: string) => Promise<string | undefined> = async (
      project,
    ) => (await loadProjectConfig(project))?.ci.repo,
  ) {}

  errors(ownerId: string): Record<string, string> {
    return Object.fromEntries(
      [...this.failures.values()]
        .filter((entry) => entry.ownerId === ownerId)
        .map((entry) => [entry.project, entry.message]),
    );
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reconcile();
    }, 30_000);
    this.timer.unref();
    void this.reconcile();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  reconcile(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.reconcileOnce().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async reconcileOnce(): Promise<void> {
    for (const policy of this.store.snapshot().projectPolicies ?? []) {
      const key = JSON.stringify([policy.ownerId, policy.project]);
      if (!policy.enabled) {
        this.failures.delete(key);
        continue;
      }
      try {
        if (!this.authorized(policy.ownerId))
          throw new Error('Publication policy owner no longer has monitoring authority');
        await this.enroll(policy);
        this.failures.delete(key);
      } catch (error) {
        // Enrollment is retried from durable publication records, with a visible owner-scoped error.
        this.failures.set(key, {
          ownerId: policy.ownerId,
          project: policy.project,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  private async enroll(policy: PRProjectMonitorPolicy): Promise<void> {
    const repo = await this.repository(policy.project);
    if (!repo) throw new Error('Project has no configured PR repository');
    let count = 0;
    for (const run of this.runs()) {
      if (run.project !== policy.project) continue;
      for (const publication of run.prPublications ?? []) {
        if (
          publication.pr.repo.toLowerCase() !== repo.toLowerCase() ||
          publication.publishedAt < policy.activatedAt
        )
          continue;
        if (publication.pr.host.toLowerCase() !== policy.config.account.host.toLowerCase())
          throw new Error('Publication policy account does not match the project GitHub host');
        const prKey = monitoredPRKey(publication.pr);
        const current = this.store
          .projectPolicies(policy.ownerId)
          .find((entry) => entry.project === policy.project);
        if (
          !current?.enabled ||
          current.revision !== policy.revision ||
          !this.authorized(policy.ownerId)
        )
          return;
        if (
          this.store
            .snapshot()
            .publicationEnrollments?.some(
              (entry) =>
                entry.ownerId === policy.ownerId &&
                entry.project === policy.project &&
                entry.runId === run.id &&
                entry.prKey === prKey,
            )
        )
          continue;
        const monitor = await this.store.enrollPublication(
          policy.ownerId,
          policy.project,
          policy.revision,
          run,
          publication,
          () => this.authorized(policy.ownerId),
        );
        if (!monitor) return;
        await this.monitors.enrolled(monitor.id, policy.ownerId);
        if (++count >= 20) return;
      }
    }
  }
}
