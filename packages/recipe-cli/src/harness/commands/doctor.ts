// doctor — readiness for a checkout without launching anything: the shared and
// platform checks, the runtime probe, the devices, and what to run next.
// --expect-live turns it into an exit-coded liveness gate; --print-ready prints
// only Farmslot's health.ready_indicator; --fix repairs what it can.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import type { AdapterDevice, AdapterRuntimeStatus } from '@farmslot/adapter-sdk';

import { adapterPluginChecks } from '../adapter-plugins.js';
import {
  adapterDetectNext,
  adapterForPlatform,
  assertAdapter,
  detectAdapter,
  harnessAdapter,
  undetectedAdapterMessage,
} from '../adapters.js';
import { acquireCheckoutLock } from '../checkout-lock.js';
import { color } from '../cli-color.js';
import {
  createDoctorReport,
  type DoctorCheck,
  type DoctorReport,
  type DoctorReportOptions,
  requiredDoctorCheckSummary,
} from '../doctor-report.js';
import { ensureOverlay, newHealState, recipeRunning } from '../heal-bounds.js';
import { harnessHost, hostEnvName } from '../host.js';
import { resolveRuntimeContextPath } from '../overlay.js';
import {
  actionManifestPathOption,
  applyRuntimeDirOption,
  type CliOptions,
  optionFlag,
  optionString,
  type ParsedArgs,
  shellQuote,
  targetPath,
} from '../parse-args.js';
import {
  adapterReadiness,
  type FeatureFlagReport,
  type Paint,
  type ReadinessViewOptions,
  renderFeatureFlagLine,
} from '../readiness.js';
import { checkoutBusyOut, EXIT, usageOut } from '../shared.js';
import { createStageReporter } from '../stage-progress.js';

/** A block the host adds to the doctor envelope and its human output. */
export interface DoctorAdvisorySection {
  // The envelope key (after `capture`).
  key: string;
  value: unknown;
  render(out: Paint): void;
}

export interface DoctorFixOptions {
  // Create the checkout's runtime context when it has none.
  ensureRuntimeContext?(target: string, adapter: string): { created: boolean };
  // The host's own repairs, after the overlay.
  repair?(target: string, adapter: string, json: boolean): { fixed: string[]; failed: string[] };
  // Next steps for the host's failed repairs, listed first.
  nextActions?(
    failed: readonly string[],
    context: { adapter: string; target: string; executable: string; scope: string },
  ): string[];
  // The error's userAction when a host repair failed.
  userAction?(failed: readonly string[], retry: string): string | undefined;
}

export interface DoctorCommandOptions extends ReadinessViewOptions {
  // Load and validate the platform's action manifest (or --action-manifest).
  manifest(
    adapter: string,
    overridePath: string | undefined,
  ): Promise<{ summary?: { errors?: number } & Record<string, unknown> }>;
  report?: DoctorReportOptions;
  fix?: DoctorFixOptions;
  // Setup blocks beyond the runtime (skills, updates), off the --expect-live path.
  advisory?(target: string): DoctorAdvisorySection[];
  // How leaked dev servers read: the envelope key and the human label
  // (default orphanDevServers, "orphan dev server").
  orphanDevServers?: { field: string; label: string };
}

// --expect-live may carry the slot's ports on the flag line (hooks template
// {{cdp_port}}/{{port}}); apply them AFTER resolveSlotPorts so an explicit flag
// wins over the checkout/pool-resolved port, matching launch/run precedence. A
// CDP readiness probe only reaches CDP when CDP_PORT is set, so without this the
// liveness answer would fall back to "unverified" and fail closed.
function applyDoctorRuntimePorts(options: CliOptions): void {
  const cdpPort = optionString(options, 'cdpPort');
  if (cdpPort) {
    process.env.CDP_PORT = cdpPort;
    process.env.RECIPE_CDP_PORT = cdpPort;
  }
  const watcherPort =
    optionString(options, 'watcherPort') ??
    optionString(options, 'port') ??
    optionString(options, 'metroPort');
  if (watcherPort) {
    process.env.WATCHER_PORT = watcherPort;
    process.env.METRO_PORT = watcherPort;
    process.env.RECIPE_WATCHER_PORT = watcherPort;
  }
}

function executableName(): string {
  const executable = process.env[hostEnvName('EXECUTABLE')];
  return executable ? shellQuote(executable) : harnessHost().name;
}

export async function handleDoctor(
  { options }: ParsedArgs,
  commandOptions: DoctorCommandOptions,
): Promise<number> {
  applyRuntimeDirOption(options);
  const host = harnessHost().name;
  const target = targetPath(options);
  const json = optionFlag(options, 'json');
  const printReady = optionFlag(options, 'printReady');
  // Farmslot health_check uses --print-ready alone; it implies the exit-coded live probe.
  const expectLive = optionFlag(options, 'expectLive') || printReady;
  const allDevices = optionFlag(options, 'allDevices');
  const platformOption = optionString(options, 'platform');
  const explicitAdapter = optionString(options, 'adapter') ?? adapterForPlatform(platformOption);
  const adapter = explicitAdapter ?? detectAdapter(target);
  if (!adapter) {
    return usageOut(json, 'doctor', undetectedAdapterMessage(target), adapterDetectNext());
  }
  assertAdapter(adapter);
  const surface = harnessAdapter(adapter);
  const readiness = adapterReadiness(surface);
  if (!fs.existsSync(target)) {
    return usageOut(
      json,
      'doctor',
      `target does not exist: ${target}`,
      `pass --target <${harnessHost().product.toLowerCase()}-checkout> pointing to an existing checkout`,
    );
  }
  if (printReady && json) {
    return usageOut(
      json,
      'doctor',
      '--print-ready owns stdout for Farmslot health_check; drop --json (use --expect-live --json for the doctor envelope)',
      `${host} doctor --print-ready --adapter <adapter> --target <path>`,
    );
  }
  const actionManifestPath = actionManifestPathOption(options, adapter);
  const manifestValidation = await commandOptions.manifest(
    adapter,
    optionString(options, 'actionManifest'),
  );
  const flags = commandOptions.featureFlags;
  const orphanField = commandOptions.orphanDevServers?.field ?? 'orphanDevServers';
  const orphanLabel = commandOptions.orphanDevServers?.label ?? 'orphan dev server';

  if (optionFlag(options, 'fix')) {
    surface.resolveSlotPorts(target);
    const preview = commandOptions.previewDevice?.('doctor', adapter, options);
    if (preview && !preview.ok) {
      return usageOut(json, 'doctor', preview.message, preview.userAction);
    }
    applyDoctorRuntimePorts(options);
    const lock = acquireCheckoutLock(target, 'doctor-fix');
    if ('message' in lock) {
      return checkoutBusyOut(json, 'doctor', lock.message, lock.path);
    }
    let fixed: string[];
    let failed: string[];
    try {
      ({ fixed, failed } = await runDoctorFix(
        adapter,
        target,
        manifestValidation,
        json,
        commandOptions.fix,
      ));
    } finally {
      lock.release();
    }
    const result = createDoctorReport(
      adapter,
      target,
      manifestValidation,
      actionManifestPath,
      undefined,
      commandOptions.report,
    );
    let runtime: AdapterRuntimeStatus | undefined;
    let runtimeProbeError: string | undefined;
    try {
      runtime = await surface.runtimeStatus(target);
    } catch (error) {
      runtimeProbeError = error instanceof Error ? error.message : String(error);
    }
    const ready = runtime?.decision === 'ready';
    const block = readiness.runtimeBlock?.(target, runtime);
    if (block) failed.push(block.id);
    const nextActions = doctorFixNextActions(failed, adapter, target, block, commandOptions.fix);
    if (failed.length === 0 && !ready && runtime?.nextAction) nextActions.push(runtime.nextAction);
    const status = result.status === 'pass' && failed.length === 0 ? 'pass' : 'fail';
    const retryDoctor = `${host} doctor --fix --adapter ${adapter} --target ${shellQuote(target)} --json`;
    const fixUserAction =
      commandOptions.fix?.userAction?.(failed, retryDoctor) ?? nextActions[0] ?? retryDoctor;
    const error =
      status === 'fail'
        ? {
            code: 'DOCTOR_FIX_INCOMPLETE',
            message: 'doctor --fix could not make every required check pass',
            userAction: fixUserAction,
          }
        : undefined;
    if (json)
      console.log(
        JSON.stringify(
          {
            ...result,
            status,
            fixed,
            failed,
            ready,
            runtime,
            ...(runtimeProbeError ? { runtimeProbeError } : {}),
            nextActions,
            ...(error ? { error } : {}),
          },
          null,
          2,
        ),
      );
    else {
      const mode =
        typeof result.compatibilityMode === 'string' ? ` ${result.compatibilityMode}` : '';
      console.log(
        `${status} ${adapter}${mode} ready=${ready} manifest=${actionManifestPath} fixed=[${fixed.join(',')}] failed=[${failed.join(',')}]`,
      );
      if (runtime) {
        console.log(
          `runtime: decision=${runtime.decision}${runtime.reasonCode ? ` (${runtime.reasonCode})` : ''}`,
        );
        for (const reason of runtime.reasons) console.log(`  ${reason}`);
      } else if (runtimeProbeError) {
        console.log(`runtime probe failed: ${runtimeProbeError}`);
      }
      for (const action of nextActions) console.error(`  Next: ${action}`);
    }
    return status === 'pass' ? 0 : 1;
  }

  const result = createDoctorReport(
    adapter,
    target,
    manifestValidation,
    actionManifestPath,
    platformOption,
    commandOptions.report,
  );
  // Before the slot-port resolve below, which hydrates the env from the context
  // file and would make every file value look like a live env override.
  const view = commandOptions.checkoutView?.(target, adapter);
  const missingRequiredTool = result.checks.find(
    (check) =>
      check.required &&
      check.status === 'fail' &&
      check.id.startsWith('device-tool-') &&
      check.userAction,
  );
  if (missingRequiredTool) {
    const error = {
      code: 'DOCTOR_CHECKS_FAILED',
      message: missingRequiredTool.message,
      userAction: missingRequiredTool.userAction,
    };
    if (json) {
      console.log(JSON.stringify({ ...result, ready: false, error }, null, 2));
    } else {
      console.error(`✗ doctor: ${error.message}\n  Next: ${error.userAction}`);
    }
    return EXIT.runtime;
  }
  let runtime: AdapterRuntimeStatus | undefined;
  let runtimeProbeError: string | undefined;
  try {
    surface.resolveSlotPorts(target);
    // doctor previews the same device run/call would use, and the host refuses
    // device options a platform has no devices for.
    const preview = commandOptions.previewDevice?.('doctor', adapter, options);
    if (preview && !preview.ok) {
      if (json)
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              command: 'doctor',
              adapter,
              target,
              error: {
                code: preview.code,
                message: preview.message,
                userAction: preview.userAction,
              },
            },
            null,
            2,
          ),
        );
      else console.error(`✗ doctor: ${preview.message}\n  Next: ${preview.userAction}`);
      return EXIT.usage;
    }
    applyDoctorRuntimePorts(options);
    runtime = await surface.runtimeStatus(target);
  } catch (error) {
    runtimeProbeError = error instanceof Error ? error.message : String(error);
  }
  const runtimeCheck = doctorRuntimeCheck(runtime, runtimeProbeError, expectLive);
  const checks = [
    ...result.checks,
    runtimeCheck,
    ...((await readiness.liveChecks?.(target)) ?? []),
    ...(await platformDoctorChecks(adapter, target)),
    // Which library plugin code this process loaded: library, module and digest.
    ...adapterPluginChecks(),
  ];
  const requiredChecks = requiredDoctorCheckSummary(checks);
  const doctorResult: DoctorReport = {
    ...result,
    status: requiredChecks.status,
    checks,
    requiredChecks,
  };
  // Dev servers a killed/superseded launch left behind on other ports. doctor
  // surfaces them (stop reaps them) so they never silently pile up.
  const orphans = readiness.orphanDevServers?.(target, process.env.WATCHER_PORT) ?? [];
  // Screen-Recording / capture readiness (macOS): shell the capture-helper doctor
  // so a denied Screen-Recording grant surfaces as a WARN with the grant step,
  // rather than only failing later inside ui.screenshot/--record.
  const capture = captureHealth(readiness.captureProviders);

  // The connected devices (id/name/state + which one is the selected target), so
  // operators see what run/call would target. A platform without devices has none.
  const deviceSource = await readiness.devices?.();
  const deviceView = deviceSource ? deviceSource.view(allDevices) : null;
  const liveView = deviceSource && deviceView ? await deviceSource.live(target, deviceView) : null;
  const devices = liveView?.devicesWithLive ?? deviceView?.devices ?? [];
  const additionalReachableDevices = liveView?.additionalReachableDevices ?? [];
  const discovery = deviceView?.deviceDiscoveryErrors.length
    ? { deviceDiscoveryErrors: deviceView.deviceDiscoveryErrors }
    : {};

  // --expect-live: exit-coded liveness gate (prepare recovery, scripts that only need pass/fail).
  // --print-ready: Farmslot health_check mode — implies --expect-live and prints
  // the platform's ready indicator on stdout.
  if (expectLive) {
    return emitExpectLive({
      adapter,
      target,
      runtime,
      result: doctorResult,
      orphans: { [orphanField]: orphans },
      capture,
      devices,
      additionalReachableDevices,
      json,
      printReady,
      discovery,
    });
  }

  const advisory = commandOptions.advisory?.(target) ?? [];
  // Which A/B variant this slot is currently pinned to: a pinned record is a
  // file read; otherwise the live device probe that already ran above answers
  // (doctor and status are held to one probe each). `null` is "no runtime
  // answered", rendered as (no runtime), never as 0 overrides.
  const pinnedFlags = readiness.pinnedFlags?.(target) ?? null;
  const featureFlags: FeatureFlagReport | undefined = flags
    ? pinnedFlags
      ? flags.report(pinnedFlags.overrides, pinnedFlags)
      : flags.report(liveView?.featureFlags ?? null)
    : undefined;

  const doctorUserAction =
    doctorResult.checks.find(
      (check) => check.required && check.status === 'fail' && check.userAction,
    )?.userAction ??
    `${host} doctor --fix --adapter ${adapter} --target ${shellQuote(target)} --json`;
  const doctorError =
    doctorResult.status === 'fail'
      ? {
          code: 'DOCTOR_CHECKS_FAILED',
          message: 'one or more required doctor checks failed',
          userAction: doctorUserAction,
        }
      : undefined;
  const next =
    doctorError?.userAction ??
    discovery.deviceDiscoveryErrors?.[0]?.userAction ??
    (runtime?.decision === 'ready' ? undefined : runtime?.nextAction);
  if (json) {
    console.log(
      JSON.stringify(
        {
          ...doctorResult,
          ready: runtime?.decision === 'ready',
          runtime,
          ...(view ? { view: view.json } : {}),
          [orphanField]: orphans,
          capture,
          ...Object.fromEntries(advisory.map((section) => [section.key, section.value])),
          ...(featureFlags ? { featureFlags } : {}),
          devices,
          additionalReachableDevices,
          ...discovery,
          ...(next ? { next } : {}),
          ...(doctorError ? { error: doctorError } : {}),
        },
        null,
        2,
      ),
    );
  } else {
    const out: Paint = (style, text) => color(style, text, { stream: process.stdout });
    const stateStyle = (value: string | undefined, good: string) =>
      value === good ? 'ok' : 'warn';
    const mode =
      typeof doctorResult.compatibilityMode === 'string'
        ? ` ${doctorResult.compatibilityMode}`
        : '';
    console.log(
      `${out(doctorResult.status === 'pass' ? 'ok' : 'err', doctorResult.status)} ${out('bold', adapter)}${mode} ${out('dim', `manifest=${actionManifestPath}`)}`,
    );
    console.log(
      `${out('label', 'harness:')} ${doctorResult.runner.packageName}@${doctorResult.runner.version} ` +
        `${out('accent', doctorResult.runner.installKind)} ${out('dim', `executable=${doctorResult.runner.executablePath}`)}`,
    );
    if (runtime) {
      const provisionedDepsPending = runtime.reasonCode === 'app-installed-deps-pending';
      const decisionStyle = provisionedDepsPending
        ? 'info'
        : runtime.decision === 'ready'
          ? 'ok'
          : runtime.decision === 'blocked'
            ? 'err'
            : 'warn';
      const depsStyle = provisionedDepsPending ? 'info' : stateStyle(runtime.deps, 'current');
      const devServerStyle = provisionedDepsPending ? 'info' : undefined;
      const devServer = runtime.devServer
        ? ` ${runtime.devServer.label}=${out(devServerStyle ?? stateStyle(runtime.devServer.status, 'up'), runtime.devServer.status)}`
        : '';
      console.log(
        `${out('label', 'runtime:')} decision=${out(decisionStyle, runtime.decision)}${runtime.reasonCode ? ` ${out('dim', `(${runtime.reasonCode})`)}` : ''} deps=${out(depsStyle, runtime.deps ?? 'unknown')}${devServer}`,
      );
      for (const reason of runtime.reasons) console.log(`  ${out('dim', reason)}`);
    } else if (runtimeProbeError) {
      console.log(`${out('err', 'runtime probe failed:')} ${out('dim', runtimeProbeError)}`);
    }
    if (view) console.log(view.text);
    if (featureFlags) renderFeatureFlagLine(featureFlags, out);
    for (const line of readiness.lines?.(target) ?? []) console.log(line);
    if (orphans.length > 0) {
      console.log(
        `${out('warn', `${orphanLabel}:`)} ${orphans.length} leaked bundler(s) for this checkout (pids ${orphans.join(', ')})`,
      );
      console.log(
        `  ${out('dim', `Next: ${host} stop   # reaps every bundler this checkout leaked`)}`,
      );
    }
    if (capture) renderCaptureHealth(capture, out);
    for (const section of advisory) section.render(out);
    if (deviceSource) {
      if (deviceView) deviceSource.renderList(deviceView, out);
      if (additionalReachableDevices.length > 0)
        deviceSource.renderAdditional(additionalReachableDevices, out);
      if (liveView) deviceSource.renderLive(deviceView?.devices ?? [], liveView.liveMap, out);
    }
    if (next) console.log(`  ${out('dim', `Next: ${next}`)}`);
  }
  return doctorResult.status === 'pass' ? 0 : 1;
}

// The platform's own checks (a library plugin's, and what it extends). Checks
// that throw are a required failure in the report, not a crash.
async function platformDoctorChecks(adapter: string, target: string): Promise<DoctorCheck[]> {
  try {
    return (await harnessAdapter(adapter).doctor?.(target)) ?? [];
  } catch (error) {
    return [
      {
        id: `adapter-plugin:${adapter}:doctor`,
        status: 'fail',
        required: true,
        message: `${adapter}'s doctor checks failed to run.`,
        detail: error instanceof Error ? error.message : String(error),
        userAction: `fix the doctor() of the ${adapter} adapter, then rerun ${harnessHost().name} doctor --adapter ${adapter}`,
      },
    ];
  }
}

function doctorRuntimeCheck(
  runtime: AdapterRuntimeStatus | undefined,
  error: string | undefined,
  expectLive: boolean,
): DoctorCheck {
  if (error) {
    return {
      id: 'runtime',
      status: 'fail',
      required: true,
      message: 'Runtime readiness probe failed.',
      detail: error,
    };
  }
  const ready = runtime?.decision === 'ready';
  return {
    id: 'runtime',
    status: ready ? 'pass' : 'fail',
    required: expectLive,
    message: ready
      ? 'Runtime is ready.'
      : `Runtime is not ready${runtime?.reasonCode ? ` (${runtime.reasonCode})` : '.'}`,
    detail: runtime?.reasons.join(' | ') || 'Runtime readiness probe returned no result.',
  };
}

// Recovery commands embed the resolved --adapter and absolute --target so each
// runs verbatim from any cwd without relying on adapter re-detection. They are
// prefixed with the resolved executable (<PREFIX>_EXECUTABLE, set by the host's
// bin) so they also run in task-local installs where the host is not on PATH;
// the host name is the fallback only for direct helper invocations.
export function doctorFixNextActions(
  failed: string[],
  adapter: string,
  target: string,
  // The platform's runtime block (readiness.runtimeBlock), when doctor found one.
  block?: { id: string; userAction?: string },
  fix?: DoctorFixOptions,
): string[] {
  const executable = executableName();
  const scope = `--adapter ${adapter} --target ${shellQuote(target)}`;
  const actions: string[] = [
    ...(fix?.nextActions?.(failed, { adapter, target, executable, scope }) ?? []),
  ];
  if (failed.includes('runtime-context')) {
    actions.push(
      `inspect ${shellQuote(resolveRuntimeContextPath(target))}, then retry ${executable} doctor --fix ${scope}`,
    );
  }
  if (failed.includes('overlay')) actions.push(`${executable} install ${scope}`);
  if (block?.userAction && failed.includes(block.id)) actions.push(block.userAction);
  return actions;
}

// Print a teaching stderr escape for --expect-live / --print-ready failures.
function emitExpectLiveVerdict(
  adapter: string,
  target: string,
  runtime: AdapterRuntimeStatus | undefined,
  verdict: 'not-live' | 'not-ready',
): void {
  const out: Paint = (style, text) => color(style, text, { stream: process.stderr });
  const detail = runtime
    ? `${runtime.decision}${runtime.reasonCode ? ` (${runtime.reasonCode})` : ''}`
    : 'runtime probe unavailable';
  console.error(`${out('err', verdict)} ${out('bold', adapter)} ${detail} ${out('dim', target)}`);
  for (const reason of runtime?.reasons ?? []) console.error(`  ${out('dim', reason)}`);
  console.error(
    `  Next: ${runtime?.nextAction ?? harnessAdapter(adapter).hints.runtimeProbeRecovery(target)}`,
  );
}

// Emit the --expect-live answer: with --json the doctor envelope goes to stdout and
// the exit code carries the live answer; with --print-ready stdout is only the
// Farmslot ready_indicator line. Fail closed when the runtime probe is unavailable.
function emitExpectLive(input: {
  adapter: string;
  target: string;
  runtime: AdapterRuntimeStatus | undefined;
  result: DoctorReport;
  orphans: Record<string, string[]>;
  capture: CaptureHealth | null;
  devices: AdapterDevice[];
  additionalReachableDevices: AdapterDevice[];
  json: boolean;
  printReady: boolean;
  discovery: { deviceDiscoveryErrors?: ReadonlyArray<unknown> };
}): number {
  const { adapter, target, runtime, json, printReady } = input;
  const live = runtime?.decision === 'ready';
  if (printReady) {
    if (live) {
      // A platform without an indicator is never ready for Farmslot's health check.
      const indicator =
        adapterReadiness(harnessAdapter(adapter)).readyIndicator?.(input.devices) ?? '';
      if (indicator) {
        console.log(indicator);
        return EXIT.ok;
      }
      emitExpectLiveVerdict(adapter, target, runtime, 'not-ready');
      return EXIT.runtime;
    }
    emitExpectLiveVerdict(adapter, target, runtime, 'not-live');
    return EXIT.runtime;
  }
  if (json) {
    const userAction =
      runtime?.nextAction ?? harnessAdapter(adapter).hints.runtimeProbeRecovery(target);
    const error = live
      ? undefined
      : { code: 'RUNTIME_NOT_LIVE', message: `${adapter} runtime is not live`, userAction };
    console.log(
      JSON.stringify(
        {
          ...input.result,
          ready: live,
          runtime,
          ...input.orphans,
          capture: input.capture,
          devices: input.devices,
          additionalReachableDevices: input.additionalReachableDevices,
          ...input.discovery,
          ...(error ? { error } : {}),
        },
        null,
        2,
      ),
    );
    return live ? EXIT.ok : EXIT.runtime;
  }
  const out: Paint = (style, text) => color(style, text, { stream: process.stdout });
  if (live) {
    console.log(`${out('ok', 'live')} ${out('bold', adapter)} runtime ready`);
    return EXIT.ok;
  }
  emitExpectLiveVerdict(adapter, target, runtime, 'not-live');
  return EXIT.runtime;
}

// Best-effort capture-helper health for the Screen-Recording surface. macOS-only;
// an absent binary or unreadable output yields null (capture is optional — never a
// doctor failure). Seam: CAPTURE_HELPER_PATH overrides the binary (contract tests).
interface CaptureHealth {
  status: 'pass' | 'warn' | 'fallback';
  failing: string[];
  screenshots: { available: true; providers: string[] };
  recording: { available: boolean; provider: 'capture-helper' | null };
}

function captureHealth(providers: readonly string[] | undefined): CaptureHealth | null {
  if (!providers) return null;
  const fallback = [...providers];
  const helper = captureHelperHealth();
  if (!helper) {
    return {
      status: 'fallback',
      failing: [],
      screenshots: { available: true, providers: fallback },
      recording: { available: false, provider: null },
    };
  }
  return {
    status: helper.status,
    failing: helper.failing,
    screenshots: { available: true, providers: ['capture-helper', ...fallback] },
    recording: {
      available: helper.status === 'pass',
      provider: helper.status === 'pass' ? 'capture-helper' : null,
    },
  };
}

function captureHelperHealth(): Pick<CaptureHealth, 'status' | 'failing'> | null {
  if (process.platform !== 'darwin') return null;
  const bin = process.env.CAPTURE_HELPER_PATH || 'capture-helper';
  try {
    const out = execFileSync(bin, ['doctor', '--json'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out) as {
      ok?: boolean;
      checks?: Array<{ id?: string; name?: string; ok?: boolean; required?: boolean }>;
    };
    const failing = (parsed.checks ?? [])
      .filter((c) => c.required === true && c.ok === false)
      .map((c) => c.name ?? c.id ?? 'check');
    return { status: parsed.ok === true && failing.length === 0 ? 'pass' : 'warn', failing };
  } catch {
    return null;
  }
}

function renderCaptureHealth(capture: CaptureHealth, out: Paint): void {
  const video = capture.recording.available ? 'capture-helper' : 'unavailable';
  console.log(
    `${out('label', 'capture:')} ${out(capture.status === 'pass' ? 'ok' : 'warn', capture.status)} ` +
      `${out('dim', `(screenshots: ${capture.screenshots.providers.join(' → ')}; video: ${video})`)}`,
  );
  if (capture.status === 'warn') {
    if (capture.failing.length > 0)
      console.log(`  ${out('dim', `failing: ${capture.failing.join(', ')}`)}`);
    console.log(
      `  ${out('dim', 'Next: grant Screen Recording (System Settings → Privacy & Security → Screen Recording), or run: capture-helper doctor --open-permissions')}`,
    );
  } else if (capture.status === 'fallback') {
    console.log(
      `  ${out('dim', 'Next: screenshots work without capture-helper; install/configure capture-helper only when recipe video is required')}`,
    );
  }
}

async function runDoctorFix(
  adapter: string,
  target: string,
  manifestValidation: { summary?: { errors?: number } },
  json: boolean,
  fix: DoctorFixOptions | undefined,
): Promise<{ fixed: string[]; failed: string[] }> {
  const fixed: string[] = [];
  const failed: string[] = [];

  if (recipeRunning(target)) {
    failed.push('recipe-running');
    return { fixed, failed };
  }

  if (Number(manifestValidation.summary?.errors ?? 0) > 0) failed.push('manifest');

  // One stage per fix, on stderr, so a slow repair shows which one is running.
  const repairs = adapterReadiness(harnessAdapter(adapter)).fixes ?? [];
  const stages = createStageReporter();
  const total = 2 + repairs.length + (fix?.repair ? 1 : 0);
  let index = 0;
  const stage = (name: string) => stages.stage(name, { index: ++index, total });
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

  try {
    const contextStage = stage('runtime-context');
    try {
      harnessAdapter(adapter).resolveSlotPorts(target);
      const runtimeContext = fix?.ensureRuntimeContext?.(target, adapter);
      if (runtimeContext?.created) fixed.push('runtime-context');
      contextStage.done(runtimeContext?.created ? 'created' : undefined);
    } catch (error) {
      failed.push('runtime-context');
      contextStage.failed(reason(error));
    }

    for (const repair of repairs) {
      const repairStage = stage(repair.id);
      try {
        const repaired = repair.apply(target);
        if (repaired) fixed.push(repair.id);
        repairStage.done(repaired ? 'fixed' : undefined);
      } catch (error) {
        failed.push(repair.id);
        repairStage.failed(reason(error));
      }
    }

    const overlayStage = stage('overlay');
    const state = newHealState();
    const ensured = await ensureOverlay(adapter, target, 'infra-only', state, json);
    if (!ensured.ok) {
      failed.push('overlay');
      overlayStage.failed(ensured.error);
    } else {
      if (state.mutations.length > 0) fixed.push('overlay');
      overlayStage.done(state.mutations.length > 0 ? 'installed' : undefined);
    }

    const hostStage = fix?.repair ? stage('host repair') : undefined;
    const host = fix?.repair?.(target, adapter, json);
    if (host) {
      fixed.push(...host.fixed);
      failed.push(...host.failed);
      if (host.failed.length > 0) hostStage?.failed(host.failed.join(', '));
      else hostStage?.done(host.fixed.length > 0 ? `fixed ${host.fixed.join(', ')}` : undefined);
    }
  } finally {
    // A fix that threw leaves its stage open; end it with the command.
    stages.close('failed', 'doctor --fix stopped');
  }

  return { fixed, failed };
}
