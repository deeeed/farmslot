export interface TaskPinEntry {
  pin: string;
  taskDir: string;
  writtenAt: number;
  provenance?: string;
}
export interface TaskPinProtection {
  taskDirs: string[];
  taskNames: string[];
  pinIds: string[];
}
export interface TaskPinSweepInput {
  root: string;
  now: number;
  ageMs: number;
  protection: TaskPinProtection;
  /** Task directories of runs retention released; their pins go even if the directory exists. */
  releasedTaskDirs?: string[];
}
export interface TaskPinStage {
  inspected: number;
  staged: string[];
  stage: string | null;
  /** Shared-store entries no pin linked any more, removed in this stage. */
  swept?: number;
}
export interface TaskPinShareInput {
  root: string;
  limit?: number;
}
export interface TaskPinShareResult {
  /** Pins now linked into the shared store, every byte re-verified. */
  pins: string[];
  /** Pins whose recomputed fingerprint differed; left unrecorded, logged by the gateway. */
  unverified: string[];
  shared: number;
  inserted: number;
  /** Files kept as private read-only copies, by reason (EXDEV, EPERM, mismatch, ...). */
  private: Record<string, number>;
  savedBytes: number;
}
export interface TaskPinSweepResult {
  inspected: number;
  removed: string[];
}
export interface TaskPinSweepHooks {
  beforeStage?: (entry: TaskPinEntry) => Promise<void>;
  afterStage?: (stage: TaskPinStage) => void | Promise<void>;
  protection?: () => TaskPinProtection;
  beforeSweep?: (entry: string) => Promise<void>;
}
export interface TaskPinShareHooks {
  beforeLink?: (entry: string) => Promise<void>;
  link?: (existing: string, created: string) => Promise<void>;
}
export function readTaskPins(root: string, names?: string[]): Promise<TaskPinEntry[]>;
export function retiredTaskPinsOf(
  entries: readonly TaskPinEntry[],
  removed: ReadonlySet<string>,
  context: { now: number; ageMs: number },
  pending: (dir: string) => boolean,
  present?: (pin: string) => Promise<boolean>,
  released?: ReadonlySet<string>,
): Promise<string[]>;
export function stageTaskPins(
  input: TaskPinSweepInput,
  hooks?: TaskPinSweepHooks,
): Promise<TaskPinStage>;
export function purgeTaskPins(root: string, stage: TaskPinStage): Promise<TaskPinSweepResult>;
export function sweepTaskPins(
  input: TaskPinSweepInput,
  hooks?: TaskPinSweepHooks,
): Promise<TaskPinSweepResult>;
export function sweepContentStore(
  root: string,
  now: number,
  hooks?: TaskPinSweepHooks,
): Promise<number>;
export function shareTaskPins(
  input: TaskPinShareInput,
  hooks?: TaskPinShareHooks,
): Promise<TaskPinShareResult>;
