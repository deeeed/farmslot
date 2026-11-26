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
}
export interface TaskPinSweepResult {
  inspected: number;
  removed: string[];
}
export interface TaskPinSweepHooks {
  beforeStage?: (entry: TaskPinEntry) => Promise<void>;
  afterStage?: (stage: TaskPinStage) => void | Promise<void>;
  protection?: () => TaskPinProtection;
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
