/** @jsxRuntime automatic @jsxImportSource react */
// The pragma must stay single-line: tsx resolves tsconfig from the invocation
// cwd (often apps/command-center), so it pins the automatic JSX runtime.
// app.tsx — farmslot TUI shell. One authenticated gateway connection, seven
// surfaces (fleet / backlog / runs / roadmap / decisions / recovery / prepare),
// live event-driven refresh. Business rules stay in the gateway + view-models (ADR-050).

import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type BacklogItem,
  buildRunResolveDecisionParams,
  type EventFrame,
  type FleetStatus,
  type PendingDecision,
  type RoadmapItem,
  type Run,
} from '@farmslot/protocol';

import type { GatewayConnection } from '../gateway-client.js';

import {
  backlogViewModel,
  decisionsViewModel,
  diagnoseFleet,
  fleetViewModel,
  roadmapViewModel,
  runsViewModel,
} from './view-models.js';

type Surface = 'fleet' | 'backlog' | 'runs' | 'roadmap' | 'decisions' | 'recovery' | 'prepare';

/** Short tab labels so the header stays one row on 80-col terminals. */
const SURFACE_TABS: Array<{ id: Surface; label: string }> = [
  { id: 'fleet', label: 'fleet' },
  { id: 'backlog', label: 'backlog' },
  { id: 'runs', label: 'runs' },
  { id: 'roadmap', label: 'map' },
  { id: 'decisions', label: 'decide' },
  { id: 'recovery', label: 'fix' },
  { id: 'prepare', label: 'prep' },
];

interface AppProps {
  connection: GatewayConnection;
  gatewayUrl: string;
}

export function App({ connection, gatewayUrl }: AppProps): JSX.Element {
  const { exit } = useApp();
  const [surface, setSurface] = useState<Surface>('fleet');
  const [fleet, setFleet] = useState<FleetStatus | null>(null);
  const [items, setItems] = useState<BacklogItem[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [roadmapItems, setRoadmapItems] = useState<RoadmapItem[]>([]);
  const [decisions, setDecisions] = useState<PendingDecision[]>([]);
  const [cursor, setCursor] = useState(0);
  const [notice, setNotice] = useState<string>('');
  // False until the first fleet/backlog/runs snapshot lands, so the shell can
  // show a `connecting to <url>…` line instead of an empty body on startup.
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const [prepare, setPrepare] = useState<{
    slotId: string;
    running: boolean;
    steps: Array<{ name: string; detail: string }>;
  } | null>(null);
  const [runDetail, setRunDetail] = useState<Run | null>(null);
  // Invalidates in-flight run.get fetches when the pane closes or the
  // surface changes, so a late response cannot reopen a stale detail.
  const runDetailRequest = useRef(0);
  const { stdout } = useStdout();
  // Rows available for list bodies: total minus header/banner/hints/notice.
  const listHeight = Math.max(5, (stdout?.rows ?? 40) - 8);

  // Guards against an older, slower refresh committing over newer data.
  // Fleet has its own generation because fleet.updated events replace only
  // the fleet slice — they must not discard in-flight backlog/runs results.
  const refreshGeneration = useRef(0);
  const fleetGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const fleetGen = ++fleetGeneration.current;
    try {
      const [fleetResult, backlogResult, runsResult, roadmapResult, decisionResult] =
        await Promise.all([
          connection.call<{ fleet: FleetStatus }>('fleet.status'),
          connection.call<{ items: BacklogItem[] }>('backlog.list'),
          connection.call<{ runs: Run[] }>('run.list', { limit: 15 }),
          connection.call<{ items: RoadmapItem[] }>('roadmap.list', {}),
          connection.call<{ decisions: PendingDecision[] }>('decision.list', {}),
        ]);
      if (fleetGen === fleetGeneration.current) setFleet(fleetResult.fleet);
      if (generation !== refreshGeneration.current) return;
      setItems(backlogResult.items);
      setRuns(runsResult.runs);
      setRoadmapItems(roadmapResult.items);
      setDecisions(decisionResult.decisions);
      setSnapshotLoaded(true);
    } catch (err) {
      setNotice(`refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [connection]);

  useEffect(() => {
    void refresh();
    const unsubscribe = connection.onEvent((event: EventFrame) => {
      if (event.event === 'slot.prepare.step') {
        // Gateway payload: { requestId, slotId, name, detail } — steps announce
        // start only; completion is the slot.prepare RPC resolving.
        const payload = event.payload as { slotId?: string; name?: string; detail?: string };
        setPrepare((current) =>
          current && current.running && payload?.slotId === current.slotId
            ? {
                ...current,
                steps: [
                  ...current.steps,
                  { name: payload.name ?? 'step', detail: payload.detail ?? '' },
                ],
              }
            : current,
        );
        return;
      }
      if (event.event === 'fleet.updated') {
        const payload = event.payload as { fleet?: FleetStatus };
        if (payload?.fleet) {
          // Invalidate only the fleet slice of any in-flight refresh; its
          // backlog/runs results remain valid and may still commit.
          fleetGeneration.current++;
          setFleet(payload.fleet);
        }
      } else if (
        event.event === 'backlog.updated' ||
        event.event === 'run.updated' ||
        event.event === 'decision.new' ||
        event.event === 'decision.updated' ||
        event.event === 'decision.resolved' ||
        event.event === 'run.decision.new' ||
        event.event === 'run.decision.updated' ||
        event.event === 'run.decision.resolved'
      ) {
        void refresh();
      }
    });
    return unsubscribe;
  }, [connection, refresh]);

  const fleetVm = useMemo(() => (fleet ? fleetViewModel(fleet) : null), [fleet]);
  const backlogVm = useMemo(() => backlogViewModel(items), [items]);
  const roadmapVm = useMemo(() => roadmapViewModel(roadmapItems), [roadmapItems]);
  const decisionsVm = useMemo(() => decisionsViewModel(decisions), [decisions]);
  const runsVm = useMemo(() => runsViewModel(runs), [runs]);
  const diagnosis = useMemo(() => (fleet ? diagnoseFleet(fleet) : null), [fleet]);

  // Scroll window: keep the cursor visible inside listHeight rows.
  const windowFor = useCallback(
    (length: number) => {
      const start = Math.max(0, Math.min(cursor - listHeight + 1, length - listHeight));
      return { start, end: Math.min(length, start + listHeight) };
    },
    [cursor, listHeight],
  );

  const rowsForSurface = useMemo(() => {
    if (surface === 'fleet') return fleetVm?.rows.length ?? 0;
    if (surface === 'backlog') return backlogVm.length;
    if (surface === 'roadmap') return roadmapVm.length;
    if (surface === 'decisions') return decisionsVm.length;
    if (surface === 'runs') return runsVm.length;
    return 0; // recovery and prepare have no selectable rows
  }, [surface, fleetVm, backlogVm, roadmapVm, decisionsVm, runsVm]);

  // Keep the cursor on a real row when the surface changes or data shrinks.
  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, rowsForSurface - 1)));
  }, [rowsForSurface]);

  const switchTo = useCallback((next: Surface) => {
    setSurface(next);
    setCursor(0);
    runDetailRequest.current++;
    setRunDetail(null);
  }, []);

  useInput((input, key) => {
    if (input === 'q') {
      // The tui command owns the connection and closes it after unmount.
      exit();
      return;
    }
    if (runDetail) {
      // Modal detail pane: swallow everything except close/refresh so gate
      // keys can never act on the hidden list cursor behind the pane.
      if (key.escape) {
        runDetailRequest.current++;
        setRunDetail(null);
      } else if (input === 'r') {
        void refresh();
      }
      return;
    }
    if (input === '1') switchTo('fleet');
    if (input === '2') switchTo('backlog');
    if (input === '3') switchTo('runs');
    if (input === '4') switchTo('roadmap');
    if (input === '5') switchTo('decisions');
    if (input === '6') switchTo('recovery');
    if (input === '7') switchTo('prepare');
    if (input === 'r') void refresh();

    if (surface === 'fleet' && input === 'p' && fleetVm) {
      const row = fleetVm.rows[cursor];
      if (fleetVm.stale || !row || row.ghost || !row.dispatchable || row.lifecycle !== 'ready') {
        setNotice('prepare needs a fresh fleet snapshot and a live, dispatchable ready slot');
        return;
      }
      if (prepare?.running) {
        setNotice(`prepare already running for ${prepare.slotId}`);
        return;
      }
      switchTo('prepare');
      setPrepare({ slotId: row.slot, running: true, steps: [] });
      void (async () => {
        try {
          await connection.call('slot.prepare', { slotId: row.slot }, { timeoutMs: 1_800_000 });
          setPrepare((current) => (current ? { ...current, running: false } : current));
          setNotice(`prepare complete for ${row.slot}`);
        } catch (err) {
          setPrepare((current) => (current ? { ...current, running: false } : current));
          setNotice(`prepare failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }
    if (key.downArrow) setCursor((c) => Math.min(c + 1, Math.max(0, rowsForSurface - 1)));
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));

    if (surface === 'backlog') {
      const row = backlogVm[cursor];
      if (!row) return;
      if (input === 'd' && row.canDispatch) {
        void (async () => {
          try {
            setNotice(`dispatching ${row.ref}…`);
            if (row.status === 'candidate') {
              await connection.call('backlog.markReady', { itemId: row.itemId });
            }
            await connection.call('backlog.enqueue', { itemId: row.itemId });
            await connection.call('backlog.autoDispatchTick', {});
            setNotice(`dispatch requested for ${row.ref}`);
            void refresh();
          } catch (err) {
            setNotice(`dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
      }
      if (input === 'c' && row.canCloseShipped) {
        void (async () => {
          try {
            setNotice(`closing ${row.ref}…`);
            await connection.call('backlog.closeShipped', {
              itemId: row.itemId,
              note: 'closed from farmslot tui',
            });
            setNotice(`closed ${row.ref} as shipped`);
            void refresh();
          } catch (err) {
            setNotice(`close failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
      }
    }

    if (surface === 'roadmap') {
      const row = roadmapVm[cursor];
      if (!row) return;
      // Cycle common stages: s = set next stage for operator close-loop.
      // Always derive next from a fresh get so concurrent promote cannot be demoted.
      if (input === 's' && row.canSetStage) {
        void (async () => {
          try {
            const order = ['rough', 'refining', 'refined', 'parked', 'archived'] as const;
            const current = await connection.call<{ item: RoadmapItem }>('roadmap.get', {
              itemId: row.id,
            });
            if (current.item.stage === 'promoted') {
              setNotice(`${row.shortId} is promoted — stage locked; use CLI promote path only`);
              void refresh();
              return;
            }
            const idx = order.indexOf(current.item.stage as (typeof order)[number]);
            const next = order[idx >= 0 ? (idx + 1) % order.length : 0] ?? 'refined';
            setNotice(`setting ${row.shortId} → ${next}…`);
            await connection.call('roadmap.save', {
              item: {
                id: current.item.id,
                title: current.item.title,
                project: current.item.project,
                stage: next,
                tags: current.item.tags,
                targetProjects: current.item.targetProjects,
                body: current.item.body,
                source: current.item.source,
                promotion: current.item.promotion,
                fileHash: current.item.fileHash,
              },
              expectedHash: current.item.fileHash,
            });
            setNotice(`stage ${row.shortId} → ${next}`);
            void refresh();
          } catch (err) {
            setNotice(`stage failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
      }
      // Promote stays CLI-only: drafts need review before decomposition (cross-review P1).
      if (input === 'p' && row.canPromote) {
        setNotice(
          `promote via CLI: farmslot roadmap promote ${row.id}  (drafts reviewed outside TUI)`,
        );
      }
    }

    if (surface === 'decisions') {
      const row = decisionsVm[cursor];
      if (!row) return;
      // Resolve stays CLI-only — first action is often not the operator intent (cross-review P1).
      if (input === 'a' || key.return) {
        const hint = row.actions[0]
          ? `farmslot decision resolve ${row.id} ${row.actions[0]}`
          : `farmslot decision list`;
        setNotice(`resolve via CLI (pick action explicitly): ${hint}`);
      }
    }

    if (surface === 'runs' && key.return) {
      const row = runsVm[cursor];
      if (row) {
        const request = ++runDetailRequest.current;
        setNotice(`loading run ${row.shortId}…`);
        void (async () => {
          try {
            const result = await connection.call<{ run: Run }>('run.get', { runId: row.id });
            if (request === runDetailRequest.current) {
              setRunDetail(result.run);
              setNotice('');
            }
          } catch (err) {
            if (request !== runDetailRequest.current) return; // stale request
            setNotice(`run.get failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
      }
      return;
    }

    if (surface === 'runs') {
      const row = runsVm[cursor];
      const decision = row?.pendingDecisions[0];
      if (!row || !decision) return;
      const actionByKey: Record<string, string | undefined> = {
        a: decision.actions.find((id) => id === 'approve-publish'),
        h: decision.actions.find((id) => id === 'hold'),
        s: decision.actions.find((id) => id === 'close-as-shipped'),
      };
      const actionId = actionByKey[input];
      if (actionId) {
        void (async () => {
          try {
            setNotice(`resolving ${row.shortId} with ${actionId}…`);
            const result = await connection.call<{ run: Run }>('run.get', { runId: row.id });
            const fullDecision = result.run.decisions?.find(
              (candidate) => candidate.id === decision.id,
            );
            if (!fullDecision) throw new Error(`decision ${decision.id} was not found`);
            await connection.call(
              'run.resolveDecision',
              buildRunResolveDecisionParams({
                runId: row.id,
                decision: fullDecision,
                actionId,
              }),
            );
            setNotice(`resolved ${row.shortId} with ${actionId}`);
            void refresh();
          } catch (err) {
            setNotice(`resolve failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
      }
    }
  });

  // Set during the runs-list IIFE render below; read by the scroll hint.
  let runsWindowClipped = false;

  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text bold color="cyan">
          farmslot tui
        </Text>
        <Text dimColor>{gatewayUrl}</Text>
        {SURFACE_TABS.map((tab, index) => (
          <Text key={tab.id} inverse={surface === tab.id}>
            {` ${index + 1}:${tab.label} `}
          </Text>
        ))}
        <Text dimColor>r:refresh q:quit</Text>
      </Box>

      {!snapshotLoaded && (
        <Box marginTop={1}>
          <Text color="cyan">connecting to {gatewayUrl}…</Text>
        </Box>
      )}

      {surface === 'fleet' && fleetVm && (
        <Box flexDirection="column" marginTop={1}>
          {fleetVm.stale && (
            <Text backgroundColor="red" color="white" bold>
              {' STALE STATUS — a re-probe is running; no prepare/dispatch suggestions '}
            </Text>
          )}
          <Text dimColor>
            checked {fleetVm.checkedAt} · {fleetVm.summary}
          </Text>
          {(() => {
            const { start, end } = windowFor(fleetVm.rows.length);
            return fleetVm.rows.slice(start, end).map((row, sliceIndex) => {
              const index = start + sliceIndex;
              return (
                <Text key={row.slot} inverse={surface === 'fleet' && index === cursor}>
                  {row.slot.padEnd(18)} {row.lifecycle.padEnd(9)} {row.agent.padEnd(8)}{' '}
                  {row.ghost ? 'GHOST (not in live pools)' : row.branch.slice(0, 40).padEnd(40)}{' '}
                  {row.task}
                </Text>
              );
            });
          })()}
          {fleetVm.rows.length > listHeight && (
            <Text dimColor>
              {cursor + 1}/{fleetVm.rows.length} — scroll with arrows
            </Text>
          )}
        </Box>
      )}

      {surface === 'backlog' && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>d:dispatch c:close-shipped (on selected row)</Text>
          {(() => {
            const { start, end } = windowFor(backlogVm.length);
            return backlogVm.slice(start, end).map((row, sliceIndex) => {
              const index = start + sliceIndex;
              return (
                <Text key={row.itemId} inverse={index === cursor}>
                  {row.ref.padEnd(15)} {row.status.padEnd(16)} p{row.priority.padEnd(3)}{' '}
                  {row.title.slice(0, 70)}
                </Text>
              );
            });
          })()}
          {backlogVm.length > listHeight && (
            <Text dimColor>
              {cursor + 1}/{backlogVm.length} — scroll with arrows
            </Text>
          )}
        </Box>
      )}

      {surface === 'runs' && runDetail && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">
            run {runDetail.id.slice(0, 8)} — {String(runDetail.status)} (Esc to close)
          </Text>
          <Text>
            flow {String(runDetail.flowType)} · ticket {String(runDetail.ticketOrPr ?? '-')} · slot{' '}
            {String(runDetail.slotId ?? '-')} · mode {String(runDetail.mode ?? '-')}
          </Text>
          {(runDetail.decisions ?? []).map((decision) => (
            <Text key={decision.id} color={decision.resolvedAt ? 'green' : 'yellow'}>
              {'  gate: '}
              {decision.title ?? decision.type}{' '}
              {decision.resolvedAt
                ? `resolved (${String(decision.resolvedAction ?? 'done')})`
                : `pending [${(decision.actions ?? []).map((a) => a.id).join(', ')}]`}
            </Text>
          ))}
        </Box>
      )}

      {surface === 'runs' && !runDetail && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            enter:details · on a pending gate: a:approve-publish h:hold s:close-as-shipped
          </Text>
          {(() => {
            // Runs render 1 + pending-gate lines each — window by line budget,
            // walking back from the cursor so it always stays visible.
            const lineCost = (row: (typeof runsVm)[number]) => 1 + row.pendingDecisions.length;
            // The shared clamp effect runs post-render; guard against a
            // shrunken list leaving the cursor momentarily out of range.
            const safeCursor = Math.min(cursor, Math.max(0, runsVm.length - 1));
            let start = safeCursor;
            let used = runsVm[safeCursor] ? lineCost(runsVm[safeCursor]) : 0;
            while (start > 0 && used + lineCost(runsVm[start - 1]) <= listHeight) {
              start--;
              used += lineCost(runsVm[start]);
            }
            let end = Math.min(safeCursor + 1, runsVm.length);
            while (end < runsVm.length && used + lineCost(runsVm[end]) <= listHeight) {
              used += lineCost(runsVm[end]);
              end++;
            }
            runsWindowClipped = start > 0 || end < runsVm.length;
            return runsVm.slice(start, end).map((row, sliceIndex) => {
              const index = start + sliceIndex;
              return (
                <Box key={row.id} flexDirection="column">
                  <Text inverse={index === cursor}>
                    {row.shortId} {row.status.padEnd(14)} {row.flowType.padEnd(12)}{' '}
                    {row.ticket.padEnd(16)} {row.slot}
                  </Text>
                  {row.pendingDecisions.map((decision) => (
                    <Text key={decision.id} color="yellow">
                      {'  gate: '}
                      {decision.title} [{decision.actions.join(', ')}]
                    </Text>
                  ))}
                </Box>
              );
            });
          })()}
          {runsWindowClipped && (
            <Text dimColor>
              {Math.min(cursor + 1, runsVm.length)}/{runsVm.length} — scroll with arrows
            </Text>
          )}
        </Box>
      )}

      {surface === 'roadmap' && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>s:cycle-stage · p:show CLI promote command (no in-TUI promote)</Text>
          {(() => {
            const { start, end } = windowFor(roadmapVm.length);
            return roadmapVm.slice(start, end).map((row, sliceIndex) => {
              const index = start + sliceIndex;
              return (
                <Text key={row.id} inverse={index === cursor}>
                  {row.shortId.padEnd(14)} {row.stage.padEnd(10)} {row.project.padEnd(16)}{' '}
                  {row.title.slice(0, 50)}
                </Text>
              );
            });
          })()}
          {roadmapVm.length > listHeight && (
            <Text dimColor>
              {cursor + 1}/{roadmapVm.length} — scroll with arrows
            </Text>
          )}
        </Box>
      )}

      {surface === 'decisions' && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>a/enter: print CLI resolve command (no silent auto-resolve)</Text>
          {(() => {
            // Each decision renders two lines — budget the window by line cost.
            const lineCost = 2;
            const maxItems = Math.max(1, Math.floor(listHeight / lineCost));
            const start = Math.max(
              0,
              Math.min(cursor - maxItems + 1, decisionsVm.length - maxItems),
            );
            const end = Math.min(decisionsVm.length, start + maxItems);
            return decisionsVm.slice(start, end).map((row, sliceIndex) => {
              const index = start + sliceIndex;
              return (
                <Box key={row.id} flexDirection="column">
                  <Text inverse={index === cursor}>
                    {row.shortId.padEnd(12)} {row.type.padEnd(18)} {row.title.slice(0, 40)}
                  </Text>
                  <Text color="yellow">
                    {'  '}slot {row.slotId} [{row.actions.join(', ')}]
                  </Text>
                </Box>
              );
            });
          })()}
          {decisionsVm.length === 0 && <Text dimColor>no pending decisions</Text>}
        </Box>
      )}

      {surface === 'recovery' && diagnosis && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={diagnosis.kind === 'healthy' ? 'green' : 'yellow'}>
            {diagnosis.kind}
          </Text>
          <Text>{diagnosis.message}</Text>
          {diagnosis.nextCommands.map((command) => (
            <Text key={command} color="cyan">
              {'  '}
              {command}
            </Text>
          ))}
        </Box>
      )}

      {surface === 'prepare' && (
        <Box flexDirection="column" marginTop={1}>
          {!prepare && <Text dimColor>Select a ready slot on the fleet surface and press p.</Text>}
          {prepare && (
            <Box flexDirection="column">
              <Text bold>
                prepare {prepare.slotId} {prepare.running ? '(running)' : '(finished)'}
              </Text>
              {prepare.steps.map((step, index) => (
                <Text
                  key={`${index}-${step.name}`}
                  color={prepare.running && index === prepare.steps.length - 1 ? 'yellow' : 'green'}
                >
                  {'  '}
                  {step.name.padEnd(16)} {step.detail}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )}

      {notice && (
        <Box marginTop={1}>
          <Text color="magenta">{notice}</Text>
        </Box>
      )}
    </Box>
  );
}
