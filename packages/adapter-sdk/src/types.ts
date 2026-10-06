// The platform adapter contract: one interface every command resolves platform
// behavior through, so no command compares adapter ids. A new platform behavior
// adds a member here, implemented by the platforms that own it.

import type {
  RecipeExecutionApproval,
  RecipeSourceProvenance,
  RecipeValidationFinding,
} from '@farmslot/protocol';
import type {
  ActionAdapter,
  ActionExecutionContext,
  RecipeLibrarySource,
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

// TPlatform: the run options this platform adds (`run.platformOptions`).
// TBrowser: the browser record a run drove (`run.launchedBrowser`).
export interface PlatformAdapter<
  TPlatform extends object = object,
  TBrowser extends AdapterBrowser = AdapterBrowser,
> {
  /** Registry key and the value of `--adapter`. */
  readonly id: string;
  /** The SDK version this adapter was written against. A host refuses any other. */
  readonly sdkVersion: AdapterSdkVersion;
  /**
   * The adapter this one composes on. Set on an adapter a recipe library
   * declares with `extends` in recipe-library.json `adapters`.
   */
  readonly extends?: string;
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
  // What `run` and `call` need from the platform. Every member is optional: a
  // platform without one behaves like a headless platform for that step.
  run?: AdapterRun<TPlatform, TBrowser>;
  // Network and performance observation around a run.
  observation?: AdapterObservation;
  // Platform checks `doctor` reports after the shared ones.
  doctor?(target: string): Promise<AdapterDoctorCheck[]>;
}

/** One check a platform adds to the `doctor` report. */
export interface AdapterDoctorCheck {
  id: string;
  status: 'pass' | 'fail';
  /** A required check that fails makes the report fail. */
  required: boolean;
  message: string;
  detail?: string;
  userAction?: string;
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

// The parsed command-line options a command hands its platform.
export type CommandOptions = Readonly<Record<string, string | boolean | readonly string[]>>;

// One recipe node changing state while a run executes.
export interface RecipeNodeEvent {
  nodeId: string;
  action: string;
  status: 'running' | 'passed' | 'failed';
}

// The options of one recipe run (`run`, `call`). `platform` carries what the
// adapter adds through `run.platformOptions`.
export interface RecipeRunOptions<TPlatform extends object = object> {
  cdpPort?: string;
  watcherPort?: string;
  slot?: string;
  validationRuntimeDir?: string;
  recordVideo?: false | 'full-run';
  librarySources?: RecipeLibrarySource[];
  // Root recipe values supplied by `run <recipe> key=value`.
  params?: Record<string, unknown>;
  onActionEvent?(event: RecipeNodeEvent): void;
  // Machine output: stdout is the contract, so the engine logs elsewhere.
  stdoutIsMachineContract?: boolean;
  // Whether the runner may update its HUD automatically; undefined lets it decide.
  autoHud?: boolean;
  // Keep routine library provenance in the trace instead of human output.
  suppressLibraryResolutionLogs?: boolean;
  source?: RecipeSourceProvenance;
  approval?: RecipeExecutionApproval;
  platform?: TPlatform;
}

// The least a browser record carries: what it was bound to, or `none` with
// the reason the run's browser could not be bound.
export interface AdapterBrowser {
  boundTo: string;
  reason?: string;
}

export interface AdapterDependencyBlock {
  code: string;
  message: string;
  userAction: string;
}

export interface AdapterRunPrepareContext {
  target: string;
  options: CommandOptions;
  heal: HealPolicy;
  state: HealState;
  json: boolean;
  // The caller authored an app restart, so the loaded source may be stale.
  appRestartAuthored?: boolean;
  onRecovery?(code: string): void;
}

// Members are methods so an adapter with its own TPlatform/TBrowser still fits
// a registry of `PlatformAdapter`.
export interface AdapterRun<
  TPlatform extends object = object,
  TBrowser extends AdapterBrowser = AdapterBrowser,
> {
  // The run options this platform reads from the command line.
  platformOptions?(options: CommandOptions): TPlatform;
  // Keys to restore after the slot ports resolve (an explicit device pin).
  pinnedEnv?(): Record<string, string | undefined> | undefined;
  // Platform environment for the run, after the slot ports and explicit ports.
  activateEnv?(projectRoot: string, options: RecipeRunOptions<TPlatform>): void;
  // Environment keys the engine restores when the run ends, beyond the ones
  // every run restores (the CDP and watcher ports).
  envKeys?: readonly string[];
  // Extra environment the run's child processes read.
  childEnv?(base: Record<string, string | undefined>): Record<string, string | undefined>;
  // Whether the runner may draw its HUD automatically.
  autoHud?(): boolean;
  // Best-effort cleanup after the runner returns, whatever the outcome.
  teardown?(projectRoot: string, env: Record<string, string | undefined>): Promise<void>;
  // Make the runtime attachable before a run.
  prepareRuntime?(projectRoot: string, options: RecipeRunOptions<TPlatform>): Promise<void>;
  // Called before the overlay install; returns the check the healthcheck phase
  // runs on the run's ports (exit code to stop, null to continue), or undefined
  // for none.
  runtimeCheck?(context: AdapterRunPrepareContext): (() => Promise<number | null>) | undefined;
  // A dependency the run cannot start without, for a recipe or one action.
  dependencyBlock?(
    target: string,
    use: { recipe?: unknown; librarySources?: RecipeLibrarySource[]; action?: string },
  ): Promise<AdapterDependencyBlock | null>;
  // Platform wording for a heal-bound violation's next step.
  violationUserAction?(violation: HealBoundViolation): string | undefined;
  // The browser a run drove, bound to the run's one CDP port.
  launchedBrowser?(target: string, artifactsDir: string, cdpPort?: string): TBrowser | null;
  // Metadata the product provenance artifact records for a bound browser.
  browserProvenance?(browser: TBrowser): Record<string, unknown>;
}

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
  // More environment names the dev server reads its port from, besides
  // WATCHER_PORT and RECIPE_WATCHER_PORT. Hosts set them for every registered
  // platform when a port is given explicitly.
  portEnv?: readonly string[];
  // More option names (camelCase, as parsed) that give the dev-server port to
  // `run` and `call`, after --watcher-port.
  portFlags?: readonly string[];
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
  // Every action manifest the platform declares, in order: an adapter that
  // extends another lists its parent's first. Absent: [manifestPath()].
  manifestPaths?(): readonly string[];
  // Action implementations the platform ships in code, registered for the
  // actions its manifests declare instead of a library's live adapter scripts.
  adapters?(): Promise<ActionAdapter[]>;
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
  // The harness-owned framed recorder: the browser pid to record, and the
  // environment variable that names it to actions while the recording runs.
  framed?: {
    browserPid(projectRoot: string, artifactsDir: string, cdpPort?: string): number | undefined;
    activePidEnv: string;
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
    // Prove the collector belongs to this runtime and listens on the run's CDP
    // port, and that a control line reaches the log the run reads.
    verifyControl(
      capture: { projectRoot: string; cdpPort: string } & AdapterConsoleFiles,
    ): Promise<{ ok: boolean; detail: string }>;
  };
  // A request log read from the run's start; the platform turns its lines
  // into findings.
  requestLog?: {
    path(projectRoot: string): string;
    findings(lines: readonly string[]): AdapterLogFinding[];
  };
  // An in-app issue buffer armed at the start and collected at the end.
  issueBuffer?: {
    arm(projectRoot: string): boolean;
    collect(projectRoot: string): unknown[] | null;
  };
}

// One finding a platform reads from its own log.
export interface AdapterLogFinding {
  level: 'warning' | 'error' | 'exception';
  // Where it came from, as the diagnostics report names it.
  source: string;
  text: string;
}

// A run-scoped observer: it sees every node event and writes its artifacts when
// the run ends.
export interface RunObserver {
  onActionEvent(event: RecipeNodeEvent): void;
  // Write and index the artifacts; the manifest is absent when the run threw.
  finalize(artifactManifestPath?: string): Promise<void>;
}

// One network capture session on the platform's runtime.
export interface NetworkCaptureBackend {
  start(params: Record<string, unknown>): Promise<unknown>;
  end(id: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface AdapterObservation {
  // The run's network capture: the host owns the session, the automatic summary
  // and the app.network_capture windows; the platform owns the backend.
  network?: {
    backend(
      target: string,
      env: NodeJS.ProcessEnv,
      artifactsDir: string,
    ): Promise<NetworkCaptureBackend>;
    // Whether recipes may call app.network_capture and app.network_assert.
    actions?: boolean;
  };
  // The run's performance observer, started before the run executes; `env`
  // carries the run's ports.
  performance?: {
    start(context: {
      target: string;
      artifactsDir: string;
      env: NodeJS.ProcessEnv;
    }): Promise<RunObserver>;
  };
}
