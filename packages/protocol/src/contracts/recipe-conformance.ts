import type { RecipeExecutionPlan } from '../recipe/index.js';

export interface RecipeConformanceSource {
  head: string | null;
  status: string;
  sourceFingerprint: string;
  dirtyDigest?: string | null;
}

export interface RecipeConformanceIdentity {
  project: string;
  app: string | null;
  domain: string | null;
  adapter: string;
  target: string;
  trustDigest?: string;
  selection?: {
    slot: string | null;
    poolSlot?: string | null;
    adapterTarget?: string | null;
    device: string | null;
    ports: Record<string, number | string>;
    provider: string | null;
    manifest: string | null;
  };
  checkout: RecipeConformanceSource;
  provider: RecipeConformanceSource;
  implementation?: Array<RecipeConformanceSource & { name: string }>;
  libraries: Array<RecipeConformanceSource & { name: string; path?: string }>;
  invocations?: Array<{ recipe: string; paramsDigest: string }>;
  configuration: Array<{ path: string; sourceFingerprint: string }>;
}

export interface RecipeConformanceCheck {
  id: string;
  status: 'pass' | 'fail' | 'missing' | 'skipped' | 'unsupported';
  required: boolean;
  message: string;
  userAction?: string;
  evidence?: { plan: RecipeExecutionPlan };
}

export interface RecipeConformanceReport {
  schemaVersion: 1;
  checkedAt: string;
  identity: RecipeConformanceIdentity;
  status: 'pass' | 'fail';
  mode: 'static' | 'live';
  capabilities: Array<{ name: string; status: 'declared' | 'verified' | 'failed' | 'unknown' }>;
  checks: RecipeConformanceCheck[];
  resolution?: {
    recipes: Array<{ ref: string; source: string; shadows: string[]; invocation?: string }>;
    actions: Array<{ action: string; source: string; shadows?: string[]; invocation?: string }>;
  };
}
