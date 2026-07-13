/** @jsxRuntime automatic @jsxImportSource react */
// The pragma must stay single-line: tsx resolves tsconfig from the invocation
// cwd (often apps/command-center), so it pins the automatic JSX runtime.
// app.tsx — farmslot TUI shell. One authenticated gateway connection, four
// surfaces (fleet / backlog / runs / recovery), live event-driven refresh.
// Business rules stay in the gateway + shared view-models (ADR-050).

import { Box, Text, useApp, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { BacklogItem, EventFrame, FleetStatus, Run } from '@farmslot/protocol';

import type { GatewayConnection } from '../gateway-client.js';

import { backlogViewModel, diagnoseFleet, fleetViewModel, runsViewModel } from './view-models.js';

type Surface = 'fleet' | 'backlog' | 'runs' | 'recovery' | 'prepare';

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
  const [cursor, setCursor] = useState(0);
  const [notice, setNotice] = useState<string>('');
  const [prepare, setPrepare] = useState<{
    slotId: string;
    running: boolean;
    steps: Array<{ name: string; status: string }>;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [fleetResult, backlogResult, runsResult] = await Promise.all([
        connection.call<{ fleet: FleetStatus }>('fleet.status'),
        connection.call<{ items: BacklogItem[] }>('backlog.list'),
        connection.call<{ runs: Run[] }>('run.list', { limit: 15 }),
      ]);
      setFleet(fleetResult.fleet);
      setItems(backlogResult.items);
      setRuns(runsResult.runs);
    } catch (err) {
      setNotice(`refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [connection]);

  useEffect(() => {
    void refresh();
    const unsubscribe = connection.onEvent((event: EventFrame) => {
      if (event.event === 'slot.prepare.step') {
        const payload = event.payload as { step?: string; name?: string; status?: string };
        const name = payload?.name ?? payload?.step ?? 'step';
        const status = payload?.status ?? 'running';
        setPrepare((current) =>
          current
            ? {
                ...current,
                steps: [...current.steps.filter((step) => step.name !== name), { name, status }],
              }
            : current,
        );
        return;
      }
      if (event.event === 'fleet.updated') {
        const payload = event.payload as { fleet?: FleetStatus };
        if (payload?.fleet) setFleet(payload.fleet);
      } else if (event.event === 'backlog.updated' || event.event === 'run.updated') {
        void refresh();
      }
    });
    return unsubscribe;
  }, [connection, refresh]);

  const fleetVm = useMemo(() => (fleet ? fleetViewModel(fleet) : null), [fleet]);
  const backlogVm = useMemo(() => backlogViewModel(items), [items]);
  const runsVm = useMemo(() => runsViewModel(runs), [runs]);
  const diagnosis = useMemo(() => (fleet ? diagnoseFleet(fleet) : null), [fleet]);

  const rowsForSurface =
    surface === 'fleet'
      ? (fleetVm?.rows.length ?? 0)
      : surface === 'backlog'
        ? backlogVm.length
        : runsVm.length;

  useInput((input, key) => {
    if (input === 'q') {
      connection.close();
      exit();
      return;
    }
    if (input === '1') setSurface('fleet');
    if (input === '2') setSurface('backlog');
    if (input === '3') setSurface('runs');
    if (input === '4') setSurface('recovery');
    if (input === '5') setSurface('prepare');
    if (input === 'r') void refresh();

    if (surface === 'fleet' && input === 'p' && fleetVm) {
      const row = fleetVm.rows[cursor];
      if (!row || row.ghost || row.lifecycle !== 'ready') {
        setNotice('prepare needs a live ready slot');
        return;
      }
      setSurface('prepare');
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
            await connection.call('run.resolveDecision', {
              runId: row.id,
              decisionId: decision.id,
              actionId,
            });
            setNotice(`resolved ${row.shortId} with ${actionId}`);
            void refresh();
          } catch (err) {
            setNotice(`resolve failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text bold color="cyan">
          farmslot tui
        </Text>
        <Text dimColor>{gatewayUrl}</Text>
        {(['fleet', 'backlog', 'runs', 'recovery', 'prepare'] as Surface[]).map((name, index) => (
          <Text key={name} inverse={surface === name}>
            {` ${index + 1}:${name} `}
          </Text>
        ))}
        <Text dimColor>r:refresh q:quit</Text>
      </Box>

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
          {fleetVm.rows.map((row, index) => (
            <Text key={row.slot} inverse={surface === 'fleet' && index === cursor}>
              {row.slot.padEnd(18)} {row.lifecycle.padEnd(9)} {row.agent.padEnd(8)}{' '}
              {row.ghost ? 'GHOST (not in live pools)' : row.branch.slice(0, 40).padEnd(40)}{' '}
              {row.task}
            </Text>
          ))}
        </Box>
      )}

      {surface === 'backlog' && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>d:dispatch c:close-shipped (on selected row)</Text>
          {backlogVm.map((row, index) => (
            <Text key={row.itemId} inverse={index === cursor}>
              {row.ref.padEnd(15)} {row.status.padEnd(16)} p{row.priority.padEnd(3)}{' '}
              {row.title.slice(0, 70)}
            </Text>
          ))}
        </Box>
      )}

      {surface === 'runs' && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            on a run with a pending gate: a:approve-publish h:hold s:close-as-shipped
          </Text>
          {runsVm.map((row, index) => (
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
          ))}
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
              {prepare.steps.map((step) => (
                <Text
                  key={step.name}
                  color={
                    step.status === 'fail' ? 'red' : step.status === 'done' ? 'green' : 'yellow'
                  }
                >
                  {'  '}
                  {step.status.padEnd(8)} {step.name}
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
