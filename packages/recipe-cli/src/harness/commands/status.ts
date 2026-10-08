// status — the home dashboard for a checkout (its platform, the next command,
// connected devices with live state), and `--watch`/`--task`, the read-only
// view of the task the checkout is working through.

import fs from 'node:fs';
import path from 'node:path';

import type { AdapterRuntimeStatus } from '@farmslot/adapter-sdk';

import {
  adapterDetectNext,
  adapterForPlatform,
  assertAdapter,
  detectAdapter,
  harnessAdapter,
  undetectedAdapterMessage,
} from '../adapters.js';
import { color } from '../cli-color.js';
import { harnessContextField } from '../context-state.js';
import { harnessHost } from '../host.js';
import { optionFlag, optionString, type ParsedArgs, targetPath } from '../parse-args.js';
import {
  adapterReadiness,
  type FeatureFlagReport,
  type Paint,
  type ReadinessViewOptions,
  renderFeatureFlagLine,
} from '../readiness.js';
import { EXIT, usageOut } from '../shared.js';
import { collectTaskView, findTaskDir } from '../task-view.js';

import { handleStatusTaskView, renderAcceptanceLines } from './status-watch.js';

export type StatusCommandOptions = ReadinessViewOptions;

export async function handleStatus(
  { options }: ParsedArgs,
  commandOptions: StatusCommandOptions = {},
): Promise<number> {
  const target = targetPath(options);
  const json = optionFlag(options, 'json');
  const watch = optionFlag(options, 'watch');
  const taskDir = optionString(options, 'task');
  if (watch || taskDir) {
    const resolvedTask = taskDir ? path.resolve(taskDir) : undefined;
    // A mistyped path would otherwise render as a task that went quiet.
    if (resolvedTask && !(fs.existsSync(resolvedTask) && fs.statSync(resolvedTask).isDirectory())) {
      return usageOut(
        json,
        'status',
        `--task is not a directory: ${resolvedTask}`,
        'Pass a task directory under temp/tasks, or omit --task to follow the newest one.',
      );
    }
    return handleStatusTaskView({ target, taskDir: resolvedTask, json, watch });
  }
  const fast = optionFlag(options, 'fast');
  const allDevices = optionFlag(options, 'allDevices');
  const adapter =
    optionString(options, 'adapter') ??
    adapterForPlatform(optionString(options, 'platform')) ??
    detectAdapter(target);
  if (!adapter) {
    return usageOut(json, 'status', undetectedAdapterMessage(target), adapterDetectNext());
  }
  assertAdapter(adapter);

  // Before resolveSlotPorts, which hydrates the env from the context file and
  // would make every file value look like a live env override.
  const view = commandOptions.checkoutView?.(target, adapter);
  const surface = harnessAdapter(adapter);
  surface.resolveSlotPorts(target);
  const readiness = adapterReadiness(surface);
  // Device targeting only applies where there are devices to target.
  const deviceSource = await readiness.devices?.();
  if (deviceSource && commandOptions.previewDevice) {
    const preview = commandOptions.previewDevice('status', adapter, options);
    if (!preview.ok) return usageOut(json, 'status', preview.message, preview.userAction);
  }
  const next = surface.hints.relaunch;
  const flags = commandOptions.featureFlags;
  // Overrides a platform pins in a file come without a runtime. A platform that
  // reads them from its devices gets them from the same live probe as the rest:
  // status spawns one probe. `null` is "no runtime answered", never "no overrides".
  const pinnedFlags = readiness.pinnedFlags?.(target) ?? null;
  const flagReport = (
    overrides: unknown,
    detail?: { error?: string; sourcePath?: string },
  ): FeatureFlagReport | undefined => flags?.report(overrides, detail);
  const staticFeatureFlags = pinnedFlags
    ? flagReport(pinnedFlags.overrides, pinnedFlags)
    : flagReport(null);
  const deviceView = deviceSource ? deviceSource.view(allDevices) : null;
  const devices = deviceView?.devices ?? [];
  const discovery = deviceView?.deviceDiscoveryErrors.length
    ? { deviceDiscoveryErrors: deviceView.deviceDiscoveryErrors }
    : {};
  const discoveryNext = discovery.deviceDiscoveryErrors?.[0]?.userAction;
  const viewField = view ? { view: view.json } : {};

  if (json) {
    // One envelope, after the probes (unless --fast or no devices).
    const doProbe =
      !fast && deviceSource && deviceView !== null && deviceView.allConnectedDevices.length > 0;
    if (doProbe) {
      const liveView = await deviceSource.live(target, deviceView);
      const liveFlags = flagReport(liveView.featureFlags);
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'status',
            adapter,
            target,
            ...harnessContextField(),
            ...viewField,
            devices: liveView.devicesWithLive,
            ...(liveFlags ? { featureFlags: liveFlags } : {}),
            ...discovery,
            ...(liveView.additionalReachableDevices.length > 0
              ? { additionalReachableDevices: liveView.additionalReachableDevices }
              : {}),
            ...(liveView.statusFields ?? {}),
            next: discoveryNext ?? deviceSource.nextForLive(next, liveView.liveMap),
          },
          null,
          2,
        ),
      );
    } else {
      const runtime =
        !fast && readiness.statusRuntime ? await surface.runtimeStatus(target) : undefined;
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'status',
            adapter,
            target,
            ...harnessContextField(),
            ...viewField,
            devices,
            ...(staticFeatureFlags ? { featureFlags: staticFeatureFlags } : {}),
            ...discovery,
            ...(runtime ? { runtime } : {}),
            next:
              discoveryNext ??
              (runtime
                ? nextForRuntime(surface.hints.launch, surface.hints.relaunch, runtime)
                : next),
          },
          null,
          2,
        ),
      );
    }
    return EXIT.ok;
  }

  // Human output — progressive: static info prints immediately so the operator
  // sees the device list without waiting for the probe window to close.
  const out: Paint = (style, text) => color(style, text, { stream: process.stdout });
  console.log(`${out('label', 'status')} ${out('bold', adapter)} ${out('dim', target)}`);
  if (view) console.log(view.text);
  if (!fast) {
    const taskView = collectTaskView(target, findTaskDir(target), Date.now());
    if (taskView.activity.ongoing && taskView.acceptance?.length) {
      console.log(renderAcceptanceLines(taskView).join('\n'));
    }
  }
  // A device-backed override record arrives with the live probe below, so only
  // a file-backed record can be printed this early.
  if (!deviceSource && staticFeatureFlags) renderFeatureFlagLine(staticFeatureFlags, out);
  if (deviceSource && deviceView) deviceSource.renderList(deviceView, out);

  if (!fast && deviceSource && deviceView !== null && deviceView.allConnectedDevices.length > 0) {
    const liveView = await deviceSource.live(target, deviceView);
    if (liveView.additionalReachableDevices.length > 0)
      deviceSource.renderAdditional(liveView.additionalReachableDevices, out);
    const liveFlags = flagReport(liveView.featureFlags);
    if (liveFlags) renderFeatureFlagLine(liveFlags, out);
    deviceSource.renderLive(devices, liveView.liveMap, out);
    deviceSource.renderHints?.(liveView, out);
    console.log(
      `${out('label', 'Next:')} ${out('cmd', discoveryNext ?? deviceSource.nextForLive(next, liveView.liveMap))}`,
    );
  } else if (!fast && readiness.statusRuntime) {
    const runtime = await surface.runtimeStatus(target);
    renderRuntimeStatus(runtime, out);
    console.log(
      `${out('label', 'Next:')} ${out('cmd', nextForRuntime(surface.hints.launch, surface.hints.relaunch, runtime))}`,
    );
  } else {
    const noRuntime = deviceSource ? flagReport(null) : undefined;
    if (noRuntime) renderFeatureFlagLine(noRuntime, out);
    console.log(`${out('label', 'Next:')} ${out('cmd', discoveryNext ?? next)}`);
  }

  return EXIT.ok;
}

function renderRuntimeStatus(runtime: AdapterRuntimeStatus, out: Paint): void {
  const decisionStyle =
    runtime.decision === 'ready' ? 'ok' : runtime.decision === 'blocked' ? 'err' : 'warn';
  const deps = runtime.deps
    ? ` deps=${out(runtime.deps === 'current' ? 'ok' : 'warn', runtime.deps)}`
    : '';
  const devServer = runtime.devServer
    ? ` ${runtime.devServer.label}=${out(runtime.devServer.status === 'up' ? 'ok' : 'warn', runtime.devServer.status)}`
    : '';
  console.log(
    `${out('label', 'runtime:')} decision=${out(decisionStyle, runtime.decision)}${runtime.reasonCode ? ` ${out('dim', `(${runtime.reasonCode})`)}` : ''}${deps}${devServer}`,
  );
}

function nextForRuntime(
  launchHint: string,
  relaunchHint: string,
  runtime: AdapterRuntimeStatus,
): string {
  if (runtime.nextAction) return runtime.nextAction;
  if (runtime.decision === 'ready') return `${harnessHost().name} logs`;
  if (runtime.decision === 'relaunch') return launchHint;
  return relaunchHint;
}
