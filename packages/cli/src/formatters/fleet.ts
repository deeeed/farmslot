import type { FleetStatusResult, SlotStatus } from '@farmslot/protocol';

import {
  bold,
  colorAgent,
  colorBranch,
  colorCdp,
  colorLifecycle,
  colorStatus,
  cyan,
  dim,
  green,
  red,
  yellow,
} from '../colors.js';
import { TableRenderer } from '../table.js';

export function formatFleetStatus(result: FleetStatusResult): string {
  const { fleet } = result;
  const termWidth = process.stdout.columns || 120;
  const lines: string[] = [];

  // Title + age
  const age = fleet.checkedAt ? formatAge(fleet.checkedAt) : '';
  lines.push('');
  lines.push(`${bold('Farm Status')}${age ? `  ${dim(age)}` : ''}`);
  lines.push(bold('='.repeat(Math.min(termWidth, 140))));

  // Table
  lines.push(buildFleetTable(fleet.slots));

  lines.push(bold('='.repeat(Math.min(termWidth, 140))));

  // Summary
  lines.push(buildSummary(fleet.slots));

  // Hints
  const hints = buildHints(fleet.slots);
  if (hints) lines.push(hints);

  // Active tasks
  const active = formatActiveTasks(fleet.slots);
  if (active) lines.push(active);

  lines.push('');
  return lines.join('\n');
}

function buildFleetTable(slots: SlotStatus[]): string {
  const table = new TableRenderer();

  table
    .addColumn('SLOT')
    .addColumn('MACHINE')
    .addColumn('SSH')
    .addColumn('DEV')
    .addColumn('DEVSRV')
    .addColumn('CDP')
    .addColumn('FIX')
    .addColumn('DEVICE', { shrinkable: true, minWidth: 8 })
    .addColumn('BRANCH', { shrinkable: true, minWidth: 8 })
    .addColumn('AGENT')
    .addColumn('LIFECYCLE')
    .addColumn('TASK', { shrinkable: true, minWidth: 8 });

  for (const s of slots) {
    const task = buildTaskLabel(s);
    const device = s.deviceName || '-';
    const lifecycle = s.lifecycle || '-';
    const plain = [
      s.slot,
      s.machine,
      s.health.ssh,
      s.health.device,
      s.health.devserver,
      s.health.cdp,
      s.health.fixtures,
      device,
      s.branch,
      s.agent,
      lifecycle,
      task,
    ];

    const isDisabled = s.lifecycle === 'disabled';
    const colored = isDisabled
      ? plain.map((v) => dim(v))
      : [
          s.slot,
          s.machine,
          colorStatus(s.health.ssh),
          colorStatus(s.health.device),
          colorStatus(s.health.devserver),
          colorCdp(s.health.cdp),
          colorStatus(s.health.fixtures, ['OK']),
          device,
          colorBranch(s.branch),
          colorAgent(s.agent),
          colorLifecycle(lifecycle),
          task === '-' ? dim(task) : task,
        ];

    table.addRow(plain, colored);
  }

  return table.render();
}

function buildTaskLabel(s: SlotStatus): string {
  const task = s.taskId || '-';
  if (task === '-') return task;
  if (s.lifecycle === 'busy' && s.runner) {
    const runner = s.model ? `${s.runner}:${s.model}` : s.runner;
    return `${task} (${runner})`;
  }
  return task;
}

function buildSummary(slots: SlotStatus[]): string {
  const total = slots.length;
  const dispatchOk = slots.filter((s) => s.dispatchable).length;
  const busy = slots.filter((s) => s.lifecycle === 'busy').length;
  const held = slots.filter((s) => s.lifecycle === 'held').length;
  const disabled = slots.filter((s) => s.lifecycle === 'disabled').length;
  const manual = slots.filter((s) => s.lifecycle === 'manual').length;
  const active = slots.filter((s) => s.lifecycle !== 'disabled');
  const stale = active.filter(
    (s) => s.health.fixtures !== 'OK' && s.health.fixtures !== '-',
  ).length;
  const unreachable = active.filter(
    (s) => s.health.ssh !== 'OK' && s.health.ssh !== 'LOCAL',
  ).length;

  const parts = [
    `Dispatchable: ${green(String(dispatchOk))}/${total}`,
    `Busy: ${yellow(String(busy))}`,
    `Held: ${cyan(String(held))}`,
    `Fixtures stale: ${yellow(String(stale))}`,
    `Unreachable: ${red(String(unreachable))}`,
  ];
  if (manual) parts.push(`Manual: ${cyan(String(manual))}`);
  if (disabled) parts.push(`Disabled: ${dim(String(disabled))}`);
  return parts.join('  ');
}

function buildHints(slots: SlotStatus[]): string {
  const hints: string[] = [];
  const dispatchable: string[] = [];
  const monitoring: string[] = [];
  const recyclable: string[] = [];
  const preparable: string[] = [];

  for (const s of slots) {
    if (s.lifecycle === 'disabled' || s.lifecycle === 'manual') continue;
    const sid = s.slot;
    if (s.lifecycle === 'busy') {
      monitoring.push(sid);
    } else if (s.lifecycle === 'ready' && !s.warm) {
      preparable.push(sid);
    } else if (s.dispatchable) {
      dispatchable.push(sid);
    } else if ((s.health.ssh === 'OK' || s.health.ssh === 'LOCAL') && s.agent !== 'working') {
      preparable.push(sid);
    }
  }

  if (dispatchable.length) {
    hints.push(`\n${green('Ready to dispatch:')}  ${dim(`${dispatchable.length} slot(s)`)}`);
    for (const sid of dispatchable) {
      hints.push(
        `  farmslot run create --slot ${sid} --project <project> --flow-type <flow> --ticket <jira-or-github-ref>`,
      );
      hints.push(`  farmslot run create --slot ${sid} --task <TASK.md>`);
    }
  }

  if (monitoring.length) {
    hints.push(`\n${yellow('Monitor (working):')}  ${dim(`${monitoring.length} slot(s)`)}`);
    for (const sid of monitoring) {
      hints.push(`  farmslot slot release ${sid} --keep-warm  ${dim('# reset + re-prepare')}`);
      hints.push(`  farmslot slot release ${sid}  ${dim('# full teardown')}`);
    }
  }

  if (recyclable.length) {
    hints.push(`\n${yellow('Recycle (done):')}  ${dim(`${recyclable.length} slot(s)`)}`);
    for (const sid of recyclable) {
      hints.push(`  farmslot slot release ${sid} --keep-warm`);
    }
  }

  if (preparable.length) {
    hints.push(`\n${yellow('Prepare (not ready):')}  ${dim(`${preparable.length} slot(s)`)}`);
    for (const sid of preparable) {
      hints.push(`  farmslot slot prepare ${sid}`);
    }
  }

  return hints.join('\n');
}

function formatActiveTasks(slots: SlotStatus[]): string {
  const working = slots.filter((s) => s.lifecycle === 'busy');
  if (!working.length) return '';

  const termWidth = process.stdout.columns || 120;
  const lines = ['', bold('Active Tasks'), bold('\u2500'.repeat(Math.min(80, termWidth)))];

  for (const s of working) {
    const task = s.taskId || '-';
    const runnerLabel = s.runner ? (s.model ? `${s.runner}:${s.model}` : s.runner) : '?';
    lines.push(`  ${bold(s.slot)}  ${task}  ${dim(runnerLabel)}`);

    const parts: string[] = [];
    if (s.dispatchedAt) {
      const secs = Math.floor((Date.now() - new Date(s.dispatchedAt).getTime()) / 1000);
      const mins = Math.floor(secs / 60);
      parts.push(`elapsed: ${mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60}m`}`);
    }
    if (parts.length) lines.push(`    ${dim(parts.join(' \u00b7 '))}`);
  }

  return lines.join('\n');
}

function formatAge(iso: string): string {
  try {
    const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 0) return '';
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m ago`;
  } catch {
    return '';
  }
}
