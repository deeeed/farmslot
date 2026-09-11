import { resolve } from 'node:path';

import {
  assertMonitoredPRIdentity,
  assertPRReviewRequest,
  assertPRSourceAccount,
  assertPRTeamConfig,
  assertPRTriggerRuleConfig,
  Events,
  Methods,
} from '@farmslot/protocol';

import { initPRQueueAdmission } from '../backlog/pr-admission.js';
import { farmslotRoot } from '../fleet/state.js';
import { verifyPRSourceAccountChange } from '../pr-monitoring/github-account.js';
import type { PRMonitoringService } from '../pr-monitoring/service.js';
import { PRReviewDispatcher } from '../pr-rules/dispatch.js';
import { collectPRRuleSources } from '../pr-rules/github-sources.js';
import { importPRProject } from '../pr-rules/project-import.js';
import { PRRuleService } from '../pr-rules/service.js';
import { PRSourceCheckpoints } from '../pr-rules/source-checkpoints.js';
import { PRRuleStore } from '../pr-rules/store.js';
import type { GatewayAuthRuntime } from '../security/auth.js';
import { isAdminPrincipal } from '../security/authorization.js';
import { currentSessionOriginator } from '../security/work-originator.js';

let service: PRRuleService | undefined;
let dispatcher: PRReviewDispatcher | undefined;

export function initPRRuleDispatch(
  auth: GatewayAuthRuntime,
  publish: (ownerId: string, event: string, payload: unknown) => void,
  poll: boolean,
): void {
  if (!service) throw new Error('PR rules must be initialized before dispatch');
  dispatcher?.stop();
  const rules = service;
  dispatcher = new PRReviewDispatcher(
    rules.store,
    rules,
    (id) => {
      const principal = auth.resolver.resolvePrincipalId(id);
      return principal.ok && isAdminPrincipal(principal.principal);
    },
    () => {
      rules.notifyChanges();
    },
  );
  initPRQueueAdmission('review', dispatcher);
  if (poll) dispatcher.start();
}

export async function initPRRules(
  auth: GatewayAuthRuntime,
  publish: (ownerId: string, event: string, payload: unknown) => void,
  poll: boolean,
  monitors: PRMonitoringService,
): Promise<PRRuleService> {
  service?.stop();
  const store = await PRRuleStore.load(resolve(farmslotRoot, '.pr-rules.json'));
  const checkpoints = await PRSourceCheckpoints.load(
    resolve(farmslotRoot, '.pr-source-checkpoints.json'),
  );
  service = new PRRuleService(
    store,
    (id) => {
      const principal = auth.resolver.resolvePrincipalId(id);
      return principal.ok && isAdminPrincipal(principal.principal);
    },
    (id) => {
      publish(id, Events.PR_RULES_UPDATED, service!.list(id));
      if (poll) dispatcher?.wake();
    },
    (team, rule) => collectPRRuleSources(team, rule, checkpoints),
    undefined,
    monitors,
    undefined,
    checkpoints,
  );
  if (poll) service.start();
  return service;
}

export async function prRulesMethod(method: string, value: unknown): Promise<unknown> {
  if (!service) throw new Error('PR rules are not initialized');
  const originator = currentSessionOriginator();
  if (originator.kind !== 'principal') throw new Error('An authenticated principal is required');
  const ownerId = originator.principalId;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Parameters must be an object');
  const p = value as Record<string, unknown>;
  if (method === Methods.PR_RULE_PROJECT_IMPORT) {
    assertPRSourceAccount(p.account);
    if (typeof p.url !== 'string') throw new Error('A Project/view URL is required');
    return importPRProject(ownerId, { account: p.account, url: p.url });
  }
  if (method === Methods.PR_REVIEW_REQUEST) {
    assertPRReviewRequest(p.request);
    const submission = await service.submit(ownerId, p.request);
    dispatcher?.wake();
    return {
      submission,
      intent: service.store.list(ownerId).intents.find((item) => item.id === submission.intentId),
      schedulerError: service.schedulerError,
    };
  }
  if (method === Methods.PR_RULES_LIST)
    return {
      ...service.list(ownerId),
      schedulerError: service.schedulerError ?? dispatcher?.error,
    };
  if (p.id !== undefined && (typeof p.id !== 'string' || !p.id))
    throw new Error('id must be a non-empty string');
  if (
    p.revision !== undefined &&
    (typeof p.revision !== 'number' || !Number.isSafeInteger(p.revision) || p.revision < 1)
  )
    throw new Error('revision must be a positive integer');
  const id = p.id as string | undefined;
  const revision = p.revision as number | undefined;
  if (method === Methods.PR_TEAM_SAVE) {
    assertPRTeamConfig(p.config);
    const config = p.config;
    const previous = id ? service.store.team(id, ownerId).config.account : undefined;
    await verifyPRSourceAccountChange(config.account, ownerId, previous);
    return { team: await service.saveTeam(ownerId, p.config, id, revision) };
  }
  if (method === Methods.PR_RULE_SAVE) {
    assertPRTriggerRuleConfig(p.config);
    return { rule: await service.saveRule(ownerId, p.config, id, revision) };
  }
  if (!id) throw new Error('id is required');
  if (method === Methods.PR_RULE_ACTION_ACKNOWLEDGE) {
    await service.acknowledgeAction(ownerId, id);
    return { ok: true };
  }
  if (method === Methods.PR_REVIEW_REQUEST_CANCEL) {
    if (revision === undefined) throw new Error('revision is required');
    const submission = await service.cancelSubmission(ownerId, id, revision);
    dispatcher?.wake();
    return {
      submission,
      intent: service.store.list(ownerId).intents.find((item) => item.id === submission.intentId),
    };
  }
  if (method === Methods.PR_REVIEW_REQUEST_GET) {
    const submission = service.store.submission(id, ownerId);
    return {
      submission,
      intent: service.store.list(ownerId).intents.find((item) => item.id === submission.intentId),
      schedulerError: service.schedulerError,
    };
  }
  if (method === Methods.PR_REVIEW_ACCEPT || method === Methods.PR_REVIEW_DEFER) {
    const intent = service.store.list(ownerId).intents.find((item) => item.id === id);
    if (!intent) throw new Error('Review intent not found');
    if (method === Methods.PR_REVIEW_ACCEPT) {
      for (const source of intent.contributions.filter((entry) => entry.eligible)) {
        if (source.submissionId !== undefined)
          await service.refreshSubmission(ownerId, source.submissionId);
        else {
          const observed = await service.refreshTarget(ownerId, source.ruleId, intent.pr);
          if (!observed.complete)
            throw new Error(
              `Review source observations are incomplete: ${observed.sourceErrors.join('; ')}`,
            );
        }
      }
    }
    await service.decideReview(
      ownerId,
      id,
      method === Methods.PR_REVIEW_ACCEPT ? 'accept' : 'defer',
    );
    dispatcher?.wake();
    return { intent: service.store.list(ownerId).intents.find((item) => item.id === id) };
  }
  if (method === Methods.PR_RULE_PREVIEW) {
    if (p.pr !== undefined) assertMonitoredPRIdentity(p.pr);
    return { preview: await service.preview(ownerId, id, p.pr) };
  }
  if (method === Methods.PR_RULE_SCAN) return { preview: await service.scan(ownerId, id) };
  if (method === Methods.PR_RULE_SET_ENABLED) {
    if (revision === undefined || typeof p.enabled !== 'boolean' || typeof p.backfill !== 'boolean')
      throw new Error('revision, enabled and backfill are required');
    return { rule: await service.enable(ownerId, id, revision, p.enabled, p.backfill) };
  }
  throw new Error('Unknown PR rule method');
}
