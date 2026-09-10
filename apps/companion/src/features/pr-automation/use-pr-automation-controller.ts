import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';

import {
  type DispatchQueueListResult,
  Events,
  Methods,
  monitoredPRUrl,
  type PRMonitor,
  type PRProjectMonitorPolicy,
  type PRPushListResult,
  type PRReviewIntent,
  type PRReviewSubmission,
  type PRRulePreview,
  type PRRulePreviewResult,
  type PRRulesListResult,
  type PRTriggerRule,
  type PRWatchListResult,
  type SlotStatus,
} from '@farmslot/protocol';

import type { GatewayClient, GatewayHttpAuthHeaders } from '../../lib/gateway-client';
import {
  buildPRMonitorConfig,
  buildPRRequest,
  effectivePRRequest,
  newPRExecution,
  newPRMonitorDraft,
  newPRRequestDraft,
  type PRMonitorDraft,
  type PRRequestDraft,
  validatePRRepair,
} from '../../lib/pr-automation';
import {
  prPushInstallation,
  registerPRPushDevice,
  usePRPushDeviceState,
} from '../../lib/pr-push-device';
import { useAttentionPrefsStore } from '../../store/attention-prefs';
import { useConnectionStore } from '../../store/connection';
import { useFleetStore } from '../../store/fleet';
import { useRunStore } from '../../store/runs';

type Tab = 'monitors' | 'reviews' | 'rules' | 'policies' | 'attention';
const EMPTY_SLOTS: SlotStatus[] = [];
let requestSequence = 0;
type Editor =
  | { kind: 'monitor'; original?: PRMonitor }
  | { kind: 'policy'; original?: PRProjectMonitorPolicy }
  | { kind: 'repair'; original: PRMonitor }
  | { kind: 'request' };
interface Snapshot {
  client: GatewayClient;
  profileId: string;
  authHeaders: GatewayHttpAuthHeaders;
  generation: number;
  watches: PRWatchListResult;
  reviews: PRRulesListResult;
  queue: DispatchQueueListResult;
  push: PRPushListResult;
}

export function usePRAutomationController(
  params: { monitorId?: string; notificationId?: string; attentionId?: string } = {},
) {
  const router = useRouter();
  const client = useConnectionStore((state) => state.client);
  const connection = useConnectionStore((state) => state.status);
  const profileId = useConnectionStore((state) => state.activeProfileId);
  const authHeaders = useConnectionStore((state) => state.activeProfileHttpAuthHeaders);
  const pushError = usePRPushDeviceState((state) => state.error);
  const [installationId, setInstallationId] = useState('');
  useEffect(() => {
    void prPushInstallation().then(setInstallationId, (error) =>
      usePRPushDeviceState.getState().setError(String(error)),
    );
  }, []);
  const slots = useFleetStore((state) => state.fleet?.slots ?? EMPTY_SLOTS);
  const runs = useRunStore((state) => state.runs);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>(
    params.attentionId ? 'attention' : params.notificationId ? 'rules' : 'monitors',
  );
  const [teamId, setTeamId] = useState('');
  const [history, setHistory] = useState(false);
  const [editor, setEditor] = useState<Editor>();
  const [monitorDraft, setMonitorDraft] = useState(newPRMonitorDraft);
  const [requestDraft, setRequestDraft] = useState(newPRRequestDraft);
  const [preview, setPreview] = useState<PRRulePreview>();
  const [linkVisit, setLinkVisit] = useState(0);
  const requestKey = useRef<string | undefined>(undefined);
  const mutation = useRef<symbol | undefined>(undefined);
  const draftScope = useRef({ client, profileId, authHeaders });
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const scope = useRef({
    client,
    profileId,
    generation: client?.connectionGeneration,
    connected: connection === 'connected',
  });
  scope.current = {
    client,
    profileId,
    generation: client?.connectionGeneration,
    connected: connection === 'connected',
  };

  useEffect(() => {
    if (params.attentionId || params.notificationId || params.monitorId) setTeamId('');
    if (params.attentionId) setTab('attention');
    else if (params.notificationId) setTab('rules');
    else if (params.monitorId) setTab('monitors');
  }, [params.monitorId, params.notificationId, params.attentionId]);

  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (!url.split('?')[0].endsWith('/pr-automation')) return;
      // A repeated tap on the same link must reveal its item even though route params are unchanged.
      setLinkVisit((visit) => visit + 1);
      if (url.includes('attentionId=')) {
        setTab('attention');
        setTeamId('');
      } else if (url.includes('notificationId=')) {
        setTab('rules');
        setTeamId('');
      } else if (url.includes('monitorId=')) {
        setTab('monitors');
        setTeamId('');
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    draftScope.current = { client, profileId, authHeaders };
    setSnapshot(undefined);
    setActionError('');
    setEditor(undefined);
    setTeamId('');
    setMonitorDraft(newPRMonitorDraft());
    setRequestDraft(newPRRequestDraft());
    requestKey.current = undefined;
  }, [client, profileId, authHeaders]);

  useEffect(() => {
    setError('');
    setPreview(undefined);
    mutation.current = undefined;
    setBusy(false);
    if (!client || connection !== 'connected') {
      setLoading(false);
      return;
    }
    let active = true,
      dirty = false;
    let pending: Promise<void> | undefined;
    const generation = client.connectionGeneration;
    const refresh = (): Promise<void> => {
      dirty = true;
      if (pending) return pending;
      pending = (async () => {
        while (active && dirty) {
          dirty = false;
          setLoading(true);
          const results = await Promise.allSettled([
            client.request<PRWatchListResult>(Methods.PR_WATCH_LIST, {}),
            client.request<PRRulesListResult>(Methods.PR_RULES_LIST, {}),
            client.request<DispatchQueueListResult>(Methods.DISPATCH_QUEUE_LIST, {}),
            client.request<PRPushListResult>(Methods.PR_PUSH_LIST, {}),
          ]);
          if (!active || client.connectionGeneration !== generation) return;
          const [watches, reviews, queue, push] = results;
          const failures = results
            .filter((result) => result.status === 'rejected')
            .map((result) => String(result.reason));
          if (
            watches.status === 'fulfilled' &&
            reviews.status === 'fulfilled' &&
            queue.status === 'fulfilled' &&
            push.status === 'fulfilled'
          ) {
            setSnapshot({
              client,
              profileId,
              authHeaders,
              generation,
              watches: watches.value,
              reviews: reviews.value,
              queue: queue.value,
              push: push.value,
            });
            setError('');
          } else setError(failures.join('; '));
          setLoading(false);
        }
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    };
    refreshRef.current = refresh;
    const unsubscribe = [
      Events.PR_WATCH_UPDATED,
      Events.PR_WATCH_POLICY_UPDATED,
      Events.PR_RULES_UPDATED,
      Events.PR_PUSH_UPDATED,
    ].map((event) =>
      client.subscribe(event, () => {
        void refresh();
      }),
    );
    void refresh();
    return () => {
      active = false;
      unsubscribe.forEach((stop) => stop());
      refreshRef.current = async () => {};
    };
  }, [client, connection, profileId, authHeaders]);
  const data =
    snapshot?.client === client &&
    snapshot.profileId === profileId &&
    snapshot.authHeaders === authHeaders
      ? snapshot
      : undefined;
  const current =
    data?.generation === client?.connectionGeneration && connection === 'connected'
      ? data
      : undefined;
  const disabled = busy || !current || !!error;
  const mutate = useCallback(
    async <T>(method: string, params: unknown): Promise<T | undefined> => {
      if (!client || mutation.current || client.connectionState !== 'connected') return;
      const captured = scope.current;
      const token = Symbol();
      mutation.current = token;
      setBusy(true);
      setActionError('');
      const stillCurrent = () =>
        scope.current.client === captured.client &&
        scope.current.profileId === captured.profileId &&
        scope.current.generation === captured.generation &&
        scope.current.connected;
      try {
        const result = await client.request<T>(method, params, 120_000);
        if (!stillCurrent()) return;
        await refreshRef.current();
        return stillCurrent() ? result : undefined;
      } catch (error) {
        if (stillCurrent()) setActionError(error instanceof Error ? error.message : String(error));
        return undefined;
      } finally {
        if (mutation.current === token) {
          mutation.current = undefined;
          setBusy(false);
        }
      }
    },
    [client],
  );
  const fail = (error: unknown) =>
    setActionError(error instanceof Error ? error.message : String(error));
  const openMonitor = (original?: PRMonitor) => {
    setMonitorDraft(newPRMonitorDraft(original));
    setEditor({ kind: 'monitor', original });
    setActionError('');
  };
  const openPolicy = (original?: PRProjectMonitorPolicy) => {
    setMonitorDraft(newPRMonitorDraft(undefined, original));
    setEditor({ kind: 'policy', original });
    setActionError('');
  };
  const openRepair = (original: PRMonitor) => {
    setMonitorDraft(newPRMonitorDraft(original));
    setEditor({ kind: 'repair', original });
    setActionError('');
  };
  const openRequest = () => {
    setRequestDraft(newPRRequestDraft());
    requestKey.current = undefined;
    setEditor({ kind: 'request' });
    setActionError('');
  };
  const editRequest = (patch: Partial<PRRequestDraft>) => {
    setRequestDraft((draft) => {
      const effective = effectivePRRequest(draft, current?.reviews.teams ?? []);
      return {
        ...draft,
        ...(patch.overrideReview ? { review: { ...effective.review } } : {}),
        ...(patch.overrideExecution
          ? { execution: structuredClone(effective.execution ?? newPRExecution()) }
          : {}),
        ...patch,
      };
    });
    requestKey.current = undefined;
  };
  const saveEditor = async () => {
    if (!editor || disabled) return;
    try {
      let result: unknown;
      if (editor.kind === 'request') {
        requestKey.current ??= `companion-${Date.now()}-${++requestSequence}-${Math.random().toString(36).slice(2)}`;
        result = await mutate(Methods.PR_REVIEW_REQUEST, {
          request: buildPRRequest(requestDraft, requestKey.current),
        });
      } else if (editor.kind === 'repair') {
        result = await mutate(Methods.PR_WATCH_REPAIR, {
          id: editor.original.id,
          revision: editor.original.revision,
          ...validatePRRepair(monitorDraft.project, monitorDraft.execution),
        });
      } else {
        const config = buildPRMonitorConfig(
          monitorDraft,
          editor.kind === 'monitor' ? editor.original : undefined,
          editor.kind === 'policy',
        );
        if (editor.kind === 'policy') {
          if (
            !editor.original &&
            current?.watches.projectPolicies?.some((policy) => policy.project === config.project)
          )
            throw new Error('This project already has a policy. Reopen it before editing.');
          const { pr: _pr, project, teamId: _team, ...settings } = config;
          result = await mutate(Methods.PR_WATCH_PROJECT_POLICY_SET, {
            project,
            enabled: monitorDraft.enabled,
            revision: editor.original?.revision,
            config: settings,
          });
        } else
          result = await mutate(
            editor.original ? Methods.PR_WATCH_CONFIGURE : Methods.PR_WATCH_SUBSCRIBE,
            {
              config,
              ...(editor.original
                ? { id: editor.original.id, revision: editor.original.revision }
                : {}),
            },
          );
      }
      if (result) setEditor(undefined);
    } catch (error) {
      fail(error);
    }
  };
  const previewRule = async (rule: PRTriggerRule) => {
    const result = await mutate<PRRulePreviewResult>(Methods.PR_RULE_PREVIEW, { id: rule.id });
    if (result) setPreview(result.preview);
  };
  const toggleRule = async (rule: PRTriggerRule) => {
    if (
      !rule.enabled &&
      (!preview?.complete ||
        preview.ruleId !== rule.id ||
        preview.ruleRevision !== rule.revision ||
        preview.teamRevision !==
          current?.reviews.teams.find((team) => team.id === rule.config.teamId)?.revision)
    )
      return;
    if (
      await mutate(Methods.PR_RULE_SET_ENABLED, {
        id: rule.id,
        revision: rule.revision,
        enabled: !rule.enabled,
        backfill: false,
      })
    )
      setPreview(undefined);
  };
  const openRun = (id: string) => router.push({ pathname: '/run/[id]', params: { id } });
  const openURL = async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch (error) {
      fail(error);
    }
  };
  return {
    status: error ? ('error' as const) : !current ? ('loading' as const) : ('ready' as const),
    viewModel: {
      tab,
      teamId,
      history,
      editor:
        draftScope.current.client === client &&
        draftScope.current.profileId === profileId &&
        draftScope.current.authHeaders === authHeaders
          ? editor
          : undefined,
      monitorDraft,
      requestDraft,
      effectiveRequest: effectivePRRequest(requestDraft, data?.reviews.teams ?? []),
      watches: data?.watches ?? { monitors: [] },
      reviews: data?.reviews ?? { teams: [], rules: [], intents: [] },
      queue: data?.queue.items ?? [],
      runs,
      slots,
      projects: [...new Set(slots.map((slot) => slot.project))].sort(),
      disabled,
      loading,
      busy,
      error,
      actionError,
      connected: connection === 'connected',
      preview,
      push: data?.push ?? { attention: [], devices: [], deliveries: [] },
      pushDevice: data?.push.devices.find((device) => device.installationId === installationId),
      pushError,
      focusedAttentionId: params.attentionId,
      focusedMonitorId: params.monitorId,
      focusedNotificationId: params.notificationId,
      linkVisit,
    },
    actions: {
      registerPush: () => {
        if (!client || disabled || mutation.current) return;
        const captured = scope.current;
        const token = Symbol();
        mutation.current = token;
        const isCurrent = () =>
          scope.current.client === captured.client &&
          scope.current.profileId === captured.profileId &&
          scope.current.generation === captured.generation &&
          scope.current.connected &&
          draftScope.current.authHeaders === authHeaders;
        setBusy(true);
        void registerPRPushDevice(
          client,
          profileId,
          useAttentionPrefsStore.getState(),
          true,
          isCurrent,
        )
          .then(
            async () => {
              if (isCurrent()) {
                usePRPushDeviceState.getState().setError('');
                await refreshRef.current();
              }
            },
            (error) => {
              if (isCurrent())
                usePRPushDeviceState
                  .getState()
                  .setError(error instanceof Error ? error.message : String(error));
            },
          )
          .finally(() => {
            if (mutation.current === token) {
              mutation.current = undefined;
              setBusy(false);
            }
          });
      },
      disablePush: () => {
        void mutate(Methods.PR_PUSH_UNREGISTER, { installationId });
      },
      acknowledgeAttention: (sourceId: string) => {
        void mutate(Methods.PR_PUSH_ACKNOWLEDGE, { sourceId });
      },
      refresh: () => {
        void refreshRef.current();
      },
      setTab: (tab: Tab) => {
        setTab(tab);
        setEditor(undefined);
      },
      setTeamId,
      setHistory,
      openMonitor,
      openPolicy,
      openRepair,
      openRequest,
      editMonitor: (patch: Partial<PRMonitorDraft>) =>
        setMonitorDraft((draft) => ({ ...draft, ...patch })),
      editRequest,
      closeEditor: () => setEditor(undefined),
      saveEditor: () => {
        void saveEditor();
      },
      previewRule: (rule: PRTriggerRule) => {
        void previewRule(rule);
      },
      toggleRule: (rule: PRTriggerRule) => {
        void toggleRule(rule);
      },
      monitorLifecycle: (monitor: PRMonitor, lifecycle: 'active' | 'paused' | 'stopped') => {
        void mutate(Methods.PR_WATCH_LIFECYCLE, {
          id: monitor.id,
          revision: monitor.revision,
          lifecycle,
        });
      },
      refreshMonitor: (monitor: PRMonitor) => {
        void mutate(Methods.PR_WATCH_REFRESH, { id: monitor.id });
      },
      acknowledgeIncident: (monitor: PRMonitor, incidentId: string, snooze: boolean) => {
        void mutate(Methods.PR_WATCH_ACKNOWLEDGE, {
          id: monitor.id,
          revision: monitor.revision,
          incidentId,
          ...(snooze ? { snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() } : {}),
        });
      },
      decideReview: (intent: PRReviewIntent, accept: boolean) => {
        void mutate(accept ? Methods.PR_REVIEW_ACCEPT : Methods.PR_REVIEW_DEFER, { id: intent.id });
      },
      cancelRequest: (submission: PRReviewSubmission) => {
        void mutate(Methods.PR_REVIEW_REQUEST_CANCEL, {
          id: submission.id,
          revision: submission.revision,
        });
      },
      acknowledgeNotification: (id: string) => {
        void mutate(Methods.PR_RULE_ACTION_ACKNOWLEDGE, { id });
      },
      openRun,
      openPR: (monitor: PRMonitor) => {
        void openURL(monitoredPRUrl(monitor.config.pr));
      },
    },
  };
}
export type PRAutomationController = ReturnType<typeof usePRAutomationController>;
