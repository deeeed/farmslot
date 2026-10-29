import type { ReactiveController, ReactiveControllerHost } from 'lit';

import {
  type ConfigGitHubAccountsResult,
  type ConfigPoolsResult,
  type ConfigProjectsResult,
  Methods,
  type PRPushListResult,
  type PRRulesListResult,
  type PRWatchListResult,
} from '@farmslot/protocol';
import {
  type CommandMethod,
  resourceQuery,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import { gateway } from '../../gateway-client.js';
import { getResourceWorkspaceKey } from '../../resource-cache.js';
import { getState, subscribe } from '../../state.js';
import { ResourceQueryController } from '../shared/resource-query-controller.js';

export class PRAutomationController implements ReactiveController {
  monitors: PRWatchListResult = { monitors: [] };
  reviews: PRRulesListResult = { teams: [], rules: [], intents: [] };
  projectConfigs: ConfigProjectsResult['projects'] = [];
  pools: ConfigPoolsResult['pools'] = [];
  githubAccounts: ConfigGitHubAccountsResult['accounts'] = [];
  accountsError = '';
  push: PRPushListResult = { attention: [], devices: [], deliveries: [] };
  error = '';
  actionError = '';
  loading = false;
  busy = false;
  private active = false;
  private unsubscribers: Array<() => void> = [];

  private readonly watchResources: ResourceQueryController<PRWatchListResult>;
  private readonly ruleResources: ResourceQueryController<PRRulesListResult>;
  private readonly pushResources: ResourceQueryController<PRPushListResult>;
  private domainStates: ResourceQueryState<unknown>[] = [];
  private readonly configurationProjects: ResourceQueryController<ConfigProjectsResult>;
  private readonly configurationPools: ResourceQueryController<ConfigPoolsResult>;
  private readonly accountResources: ResourceQueryController<ConfigGitHubAccountsResult>;
  private verifyingAccounts = false;
  constructor(private readonly host: ReactiveControllerHost) {
    this.accountResources = new ResourceQueryController<ConfigGitHubAccountsResult>(
      host,
      (state) => {
        this.githubAccounts = state.data?.accounts ?? [];
        this.accountsError = state.error?.message ?? state.data?.error ?? '';
      },
    );
    this.configurationProjects = new ResourceQueryController<ConfigProjectsResult>(
      host,
      (state) => {
        this.projectConfigs = state.data?.projects ?? [];
      },
    );
    this.configurationPools = new ResourceQueryController<ConfigPoolsResult>(host, (state) => {
      this.pools = state.data?.pools ?? [];
    });
    const changed = <T>(
      index: number,
      state: ResourceQueryState<T>,
      apply: (data: T | undefined) => void,
    ) => {
      this.domainStates[index] = state;
      apply(state.data);
      this.loading = this.domainStates.some((value) => value.status === 'loading');
      this.error = this.domainStates
        .flatMap((value) => (value.error ? [value.error.message] : []))
        .join('; ');
    };
    this.watchResources = new ResourceQueryController<PRWatchListResult>(host, (state) =>
      changed(0, state, (data) => {
        this.monitors = data ?? { monitors: [] };
      }),
    );
    this.ruleResources = new ResourceQueryController<PRRulesListResult>(host, (state) =>
      changed(1, state, (data) => {
        this.reviews = data ?? { teams: [], rules: [], intents: [] };
      }),
    );
    this.pushResources = new ResourceQueryController<PRPushListResult>(host, (state) =>
      changed(2, state, (data) => {
        this.push = data ?? { attention: [], devices: [], deliveries: [] };
      }),
    );
    host.addController(this);
  }
  get connected(): boolean {
    return (
      gateway.connectionState === 'connected' &&
      this.watchResources.ready &&
      this.ruleResources.ready &&
      this.pushResources.ready
    );
  }
  get slots() {
    return getState().fleet?.slots ?? [];
  }
  get projects(): string[] {
    return [
      ...new Set([
        ...this.projectConfigs.map((project) => project.name),
        ...this.slots.map((slot) => slot.project),
      ]),
    ].sort();
  }

  hostConnected(): void {
    this.active = true;
    this.configurationProjects.setQuery(
      resourceQuery<ConfigProjectsResult>(Methods.CONFIG_PROJECTS),
    );
    this.configurationPools.setQuery(resourceQuery<ConfigPoolsResult>(Methods.CONFIG_POOLS));
    this.watchResources.setQuery(resourceQuery<PRWatchListResult>(Methods.PR_WATCH_LIST));
    this.ruleResources.setQuery(resourceQuery<PRRulesListResult>(Methods.PR_RULES_LIST));
    this.pushResources.setQuery(resourceQuery<PRPushListResult>(Methods.PR_PUSH_LIST));
    this.accountResources.setQuery(
      resourceQuery<ConfigGitHubAccountsResult>(Methods.CONFIG_GITHUB_ACCOUNTS),
    );
    this.unsubscribers = [subscribe(() => this.host.requestUpdate())];
  }
  hostDisconnected(): void {
    this.active = false;
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribers = [];
  }
  get canRetryRead(): boolean {
    return gateway.connectionState === 'connected' && !this.loading && !this.busy;
  }
  async retryReadErrors(): Promise<void> {
    if (!this.canRetryRead) return;
    await Promise.all(
      [this.watchResources, this.ruleResources, this.pushResources]
        .filter((resource) => resource.state.error)
        .map((resource) => resource.retry()),
    );
  }
  /** Explicit gh verification. Its source notification owns the canonical account list. */
  async refreshAccounts(): Promise<void> {
    if (this.verifyingAccounts || gateway.connectionState !== 'connected') return;
    const owner = getResourceWorkspaceKey();
    const epoch = gateway.connectionEpoch;
    this.verifyingAccounts = true;
    try {
      await gateway.request<ConfigGitHubAccountsResult>(
        Methods.CONFIG_GITHUB_ACCOUNTS,
        { refresh: true },
        30_000,
      );
    } catch (error) {
      if (owner === getResourceWorkspaceKey() && epoch === gateway.connectionEpoch)
        this.accountsError = error instanceof Error ? error.message : String(error);
    } finally {
      this.verifyingAccounts = false;
      this.host.requestUpdate();
    }
  }
  async mutate<T>(method: CommandMethod, params: unknown): Promise<T | undefined> {
    if (this.busy || !this.connected) return undefined;
    const owner = getResourceWorkspaceKey();
    const epoch = gateway.connectionEpoch;
    this.busy = true;
    this.actionError = '';
    this.host.requestUpdate();
    try {
      this.watchResources.requireReady();
      this.ruleResources.requireReady();
      this.pushResources.requireReady();
      const result = await gateway.request<T>(method, params, 120_000);
      if (!this.active || owner !== getResourceWorkspaceKey() || epoch !== gateway.connectionEpoch)
        return undefined;
      // Owning stores publish after commit. Commands never populate the query cache.
      return result;
    } catch (error) {
      // Keep form values available for retry and show the gateway's actionable failure.
      if (this.active && owner === getResourceWorkspaceKey() && epoch === gateway.connectionEpoch)
        this.actionError = error instanceof Error ? error.message : String(error);
      return undefined;
    } finally {
      this.busy = false;
      this.host.requestUpdate();
    }
  }
}
