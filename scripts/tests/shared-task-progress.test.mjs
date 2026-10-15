import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = (path) => readFileSync(new URL(path, root), 'utf8');

test('web task surfaces render the pipeline checklist through the shared tracker', () => {
  const surfaces = [
    'runs/run-pipeline.ts',
    'runs/step-inspector.ts',
    'runs/run-review-result-renderer.ts',
    'slot-detail/slot-detail.ts',
    'slot-view/slot-view-panel-renderers.ts',
    'terminal/terminal-view-renderers.ts',
  ];
  for (const surface of surfaces) {
    const content = source(`apps/command-center/ui/src/components/${surface}`);
    assert.ok(/<progress-tracker[\s>]/.test(content), `${surface} must use progress-tracker`);
    assert.doesNotMatch(content, /(?:taskProgress|progress|tp)\.phases\.map\(/, surface);
  }
  const pipeline = source('apps/command-center/ui/src/components/runs/run-pipeline-panels.ts');
  const inspector = source('apps/command-center/ui/src/components/runs/step-inspector.ts');
  assert.doesNotMatch(pipeline, /function renderPipelineProgressPanel\(/);
  assert.doesNotMatch(inspector, /_renderTaskProgress(?:Step)?\(/);
});

test('web and native checklist renderers use the same phase and row view-model', () => {
  for (const path of [
    'apps/command-center/ui/src/components/progress-tracker/progress-tracker.ts',
    'apps/companion/src/components/TaskProgressPanel.tsx',
  ]) {
    const content = source(path);
    assert.ok(/from ['"]@farmslot\/review-dispatch['"]/.test(content), path);
    assert.ok(/checklistProgressView\(progress,/.test(content), path);
    assert.ok(/view\.phases/.test(content), path);
    assert.ok(/phase\.rows\.map\(/.test(content), path);
    assert.doesNotMatch(content, /(?:progress|structured)\.phases\.map\(/, path);
  }
});

test('native task surfaces keep one panel for structured and waiting progress', () => {
  for (const path of [
    'features/run-detail/RunDetailScreen.tsx',
    'features/decision-workspace/DecisionWorkspaceScreen.tsx',
    'features/family-workspace/components/family-workspace-panels.tsx',
    'features/slot-workspace/components/slot-workspace-panels.tsx',
    'features/terminal/SlotTerminalScreen.tsx',
  ]) {
    const content = source(`apps/companion/src/${path}`);
    assert.ok(/<TaskProgressPanel[\s>]/.test(content), `${path} must use TaskProgressPanel`);
    assert.doesNotMatch(content, /TaskProgressFallback/, path);
  }
});
