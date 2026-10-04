// The platform adapter contract: one interface every command resolves platform
// behavior through, so no command compares adapter ids. A new platform behavior
// adds a member here, implemented by the platforms that own it.

import type { RecipeValidationFinding } from '@farmslot/protocol';
import type {
  ActionAdapter,
  ActionExecutionContext,
  RecordingTarget,
  RecordingTargetContext,
  StandardUiAction,
  UiActionTransport,
  VideoRecorder,
} from '@farmslot/recipe-runner';
import type { CreateCdpWebUiTransportOptions } from '@farmslot/recipe-runner/runtime/cdp';
import type { CreateReactNativeBridgeUiTransportOptions } from '@farmslot/recipe-runner/runtime/react-native-bridge';

/** The adapter SDK major version a host implements. */
export const ADAPTER_SDK_VERSION = 1;
export type AdapterSdkVersion = typeof ADAPTER_SDK_VERSION;

export interface PlatformAdapter {
  /** Registry key and the value of `--adapter`. */
  readonly id: string;
  /** The SDK version this adapter was written against. A host refuses any other. */
  readonly sdkVersion: AdapterSdkVersion;
  // A headless platform runs no app or dev server. Commands ask this instead of
  // comparing adapter ids.
  readonly headless: boolean;
  // Resolve slot ports/device into the environment (checkout context > pool >
  // formula). A no-op for a headless platform.
  resolveSlotPorts(target: string): void;
  // Read-only readiness for `doctor`. Never launches or mutates.
  runtimeStatus(target: string): Promise<AdapterRuntimeStatus>;
  devServer: AdapterDevServer;
  // Ordered candidate log files for `logs`. Empty for a headless platform.
  logSources(target: string): AdapterLogSource[];
  // Application console output. It may share a file with a dev-server source
  // when the adapter deliberately multiplexes both streams.
  appLogSource(target: string): AdapterLogSource | null;
  hints: AdapterHints;
  // The platform's action set: what the runner registers and how it executes.
  actions: AdapterActions;
  // `install`, `verify` and `cleanup`.
  harness: AdapterHarness;
  // What the platform records in the checkout's agentic-runtime.json.
  runtimeContext: AdapterRuntimeContextSpec;
  // `reload`. Absent: no app runtime to reload (headless).
  reload?(target: string, json: boolean): Promise<number>;
  // Whole-run video (`--record-video`).
  recording?: AdapterRecording;
  // Application diagnostics collected around a run.
  diagnostics?: AdapterDiagnostics;
  // Source fingerprint of the checkout root, when the platform has its own.
  sourceFingerprint?(root: string): string;
  // `launch` for this platform. The command owns the shared grammar (--heal,
  // adapter resolution, the checkout lock, the --json-stream envelope); the
  // platform owns the rest and returns the exit code.
  launch(context: AdapterLaunchContext): Promise<number>;
  // How a host recognises this platform's checkout when --adapter is absent.
  // Any adapter's remote match beats any adapter's file match; within a pass,
  // registration order decides.
  detect?: AdapterDetect;
  // Positional platform targets this adapter accepts (`launch ios`), which also
  // select it when passed as --platform.
  targets?: readonly string[];
  // Boolean CLI flags this platform adds, so the host parses `--flag value` as
  // a flag followed by a positional.
  flags?: AdapterFlags;
  // Output patterns that classify a failure for bounded healing. Hosts match
  // every registered adapter's patterns.
  failurePatterns?: AdapterFailurePatterns;
}

export interface AdapterDetect {
  // Matches the checkout's `remote.origin.url`.
  remote?(url: string): boolean;
  // Matches the checkout's files.
  files?(target: string): boolean;
}

export interface AdapterFlags {
  // Flags `launch` accepts for this platform.
  launch?: readonly string[];
  // Flags the other commands accept for this platform.
  commands?: readonly string[];
}

// Failure classes in the order a host tests them; the first match wins and an
// unmatched failure is app logic (never healed).
export interface AdapterFailurePatterns {
  // The screen refuses capture, so a screenshot can't be evidence. The platform
  // words the explanation and the next step.
  captureProtected?: { pattern: RegExp; message: string; userAction: string };
  // Transport failures that would otherwise read as wallet state.
  transportFirst?: RegExp;
  // Wallet or fixture state the harness never changes on its own.
  walletState?: RegExp;
  // Transport and dev-server failures a relaunch can heal.
  transport?: RegExp;
}

// --heal: off disables every recovery, infra-only and auto allow one bounded
// transport recovery per invocation.
export type HealPolicy = 'off' | 'infra-only' | 'auto';

export interface HealMutation {
  type: string;
  action: string;
  [key: string]: unknown;
}

export interface HealState {
  recovered: string[];
  mutations: HealMutation[];
  attemptedRecoveries: string[];
}

export interface HealBoundViolation {
  code: string;
  exitCode: number;
  message: string;
  userAction?: string;
  // The original failure output, carried verbatim next to the classification.
  originalError?: string;
}

// The --json-stream events a command and its platform emit while it runs.
export interface CommandEventStream {
  readonly enabled: boolean;
  emit(event: string, fields?: Record<string, unknown>): void;
  phase(phase: string, fields?: Record<string, unknown>): void;
  mutation(mutation: Record<string, unknown>): void;
  recovery(code: string): void;
  error(error: Record<string, unknown>): void;
  complete(
    status: 'pass' | 'fail' | 'unknown',
    exitCode: number,
    fields?: Record<string, unknown>,
  ): void;
}

export interface AdapterLaunchContext {
  adapter: string;
  target: string;
  options: Record<string, string | boolean>;
  // One of the adapter's `targets`, from the positional or --platform.
  platformTarget?: string;
  heal: HealPolicy;
  // --json without --json-stream: print one JSON document.
  jsonOutput: boolean;
  // --json or --json-stream: no interactive progress.
  machine: boolean;
  stream: CommandEventStream;
  // Report a usage error in the launch envelope and return its exit code.
  usage(message: string, userAction: string): number;
}

// Read-only runtime readiness, normalized across platforms so `doctor` renders
// one line the same way regardless of adapter. Device platforms fill deps +
// devServer; a headless platform reports deps presence only (no devServer).
export interface AdapterRuntimeStatus {
  decision: string;
  reasonCode?: string;
  reasons: string[];
  // Exact, platform-owned recovery command when the runtime is not ready.
  // Commands render this instead of guessing from adapter names.
  nextAction?: string;
  deps?: string;
  // The platform's dev server (Metro, a webpack watcher), labelled so the
  // render names the right thing. Absent for a headless platform.
  devServer?: { label: string; status: string };
}

// One log file a platform writes, most-relevant first. `logs` tails the first
// candidate that exists.
export interface AdapterLogSource {
  label: string;
  path: string;
}

// Result of stopping the platform's dev server. `headless` means there is
// nothing to stop, so `stop` teaches instead. `stopped` carries the exit status
// plus, when the platform counts them, how many processes were signalled and
// the raw leaf output for the --json envelope.
export type AdapterDevServerStop =
  | { kind: 'headless'; message: string; userAction: string }
  | { kind: 'stopped'; status: number; summary: string; signalled?: number; output?: string };

export interface AdapterDevServer {
  // Short label used in compact status/help output ("metro", "webpack").
  label: string;
  // One noun for the dev server this platform runs ("Metro", "webpack watcher").
  describe(): string;
  // Stop the dev server this checkout owns, port/pid-scoped. Idempotent:
  // nothing-to-stop is success, never an error.
  stop(target: string): AdapterDevServerStop;
  // stop's Next: line, when the platform has one truthful relaunch.
  afterStop?(target: string): string;
}

// Platform-phrased Next: hints so no command prints another platform's vocabulary.
// `launch` (re)starts the app + dev server; `relaunch` rebuilds first. A headless
// platform has no app, so its hints teach the headless path.
export interface AdapterHints {
  launch: string;
  relaunch: string;
  runtimeProbeRecovery(target: string): string;
}

export interface AdapterActions {
  // The bundled action manifest.
  manifestPath(): string;
  // Semantic actions this platform bundles beyond the ones every platform
  // bundles. Any other declared action must come from a live adapter script.
  semantic: readonly string[];
  // Bundled actions that still need a live adapter script here.
  liveOnly?: readonly string[];
  // Bundled actions try a live adapter script only once a CDP port is set.
  liveNeedsCdpPort?: boolean;
  // Live adapter scripts import the checkout's TypeScript: they run under tsx
  // with this extra environment.
  tsxLiveScripts?: { env(projectRoot: string, tempDir: string): Promise<NodeJS.ProcessEnv> };
  // How `cdp.target` probes the runtime.
  cdpTarget: AdapterCdpTarget;
  // The ui.* transport. Absent: the platform is headless and refuses ui.* actions.
  ui?(harness: AdapterUiHarness, options: { hudPolicy: 'auto' | 'show' }): AdapterUiTransport;
  // Wraps every registered action adapter.
  wrap?(adapters: ActionAdapter[]): Promise<ActionAdapter[]>;
  // Wraps the app.lifecycle adapters.
  lifecycle?(adapters: ActionAdapter[]): Promise<ActionAdapter[]>;
  // Platform checks on one recipe node's inputs.
  inputFindings?(nodeId: string, node: Record<string, unknown>): RecipeValidationFinding[];
}

export interface AdapterCdpTarget {
  transport: string;
  // Path probed on the runtime port.
  probePath: string;
  // Probe the watcher port (Metro) before the CDP port.
  watcherPortFirst?: boolean;
  // A required probe asks the platform instead; it throws when unreachable.
  requiredProbe?(
    node: Record<string, unknown>,
    context: ActionExecutionContext,
  ): Promise<Record<string, unknown>>;
}

export interface NativeUiTransport extends UiActionTransport {
  close?(): Promise<void>;
}

export interface NativeUiTransportOptions {
  platform: 'ios' | 'android';
  device: string;
  app: string;
  session: string;
  stateDir: string;
}

// Transport factories the runner hands the platform.
export interface AdapterUiHarness {
  createReactNativeBridgeUiTransport: (
    options: CreateReactNativeBridgeUiTransportOptions,
  ) => UiActionTransport;
  createCdpWebUiTransport: (options: CreateCdpWebUiTransportOptions) => UiActionTransport;
  createNativeUiTransport?: (options: NativeUiTransportOptions) => Promise<NativeUiTransport>;
}

export interface AdapterUiTransport {
  base: UiActionTransport;
  // Actions the platform runs itself. `standard` runs the shared path
  // (ui.navigate, ui.wait_for aliases, then `base`).
  execute?(
    action: StandardUiAction,
    node: Record<string, unknown>,
    context: ActionExecutionContext,
    standard: () => Promise<unknown>,
  ): Promise<unknown>;
}

export interface AdapterHarnessLeaf {
  // Relative to the runner root (or absolute); the fallback is tried second.
  entry: string;
  fallback: string;
  // Run with node; otherwise the leaf is a shell script.
  node?: boolean;
}

export type AdapterHarnessVerify =
  | { command: string; prefixArgs: string[] }
  // Runner-owned typed code that runs in this process.
  | {
      inProcess(): Promise<
        (
          args: string[],
          io: { out(line: string): void; err(line: string): void },
        ) => Promise<number>
      >;
    }
  | { error: string };

export interface AdapterHarness {
  install: AdapterHarnessLeaf;
  // fromInstalledRunner: cleanup runs the copy the checkout's overlay records.
  cleanup: AdapterHarnessLeaf & { fromInstalledRunner?: boolean };
  verify(target: string): AdapterHarnessVerify;
  // The environment and args verify runs with (runtime identity, CDP port).
  verifyArgs?(target: string, args: string[]): string[];
  // How to (re)start the runtime after a failure. Absent: headless.
  restart?: string;
}

export interface AdapterRuntimeContextSpec {
  // Fields this platform's context must not carry.
  forbiddenFields: readonly string[];
  // Port bases claimed when neither the env nor the context names one.
  localPorts?: { cdp?: number; watcher?: number };
  // Resources recorded besides watcherPort/devServerPort. Absent: none at all.
  resources?(ports: {
    watcherPort: unknown;
    existing: Record<string, unknown>;
    defaults: Record<string, string | number>;
    envPort(...names: string[]): number | undefined;
  }): Record<string, unknown>;
}

export interface AdapterRecording {
  target(context: RecordingTargetContext): Promise<RecordingTarget>;
  // The harness-owned framed recorder: the browser pid to record.
  framed?: {
    browserPid(projectRoot: string, artifactsDir: string, cdpPort?: string): number | undefined;
  };
  // The device recorder the runner records with, when the platform has one.
  videoRecorder?(): Promise<VideoRecorder | undefined>;
}

export interface AdapterConsoleFiles {
  extensionLog: string;
  pageLog: string;
  pidFile: string;
}

export interface AdapterDiagnostics {
  // The detached CDP console collector a run's findings depend on.
  console?: {
    start(projectRoot: string): Promise<void>;
    files(projectRoot: string): AdapterConsoleFiles;
    cdpPort(): string | undefined;
    // Prove a control line reaches the log the run reads.
    verifyControl(
      capture: { projectRoot: string; cdpPort: string } & AdapterConsoleFiles,
    ): Promise<{ ok: boolean; detail: string }>;
  };
  // A JSONL log of wallet requests, read from the run's start.
  walletLog?(projectRoot: string): string;
  // An in-app issue buffer armed at the start and collected at the end.
  issueBuffer?: {
    arm(projectRoot: string): boolean;
    collect(projectRoot: string): unknown[] | null;
  };
}
