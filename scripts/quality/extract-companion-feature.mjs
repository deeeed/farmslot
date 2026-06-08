#!/usr/bin/env node
/**
 * Mechanical companion route → feature folder extraction.
 * Splits a route file into Screen + panels + styles and writes a thin re-export route.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMPANION_SRC = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../apps/companion/src',
);

function findMainFunctionEnd(lines) {
  const startIdx = lines.findIndex((l) => /^export default function /.test(l));
  if (startIdx < 0) throw new Error('export default function not found');

  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') {
        depth++;
        started = true;
      } else if (ch === '}') {
        depth--;
        if (started && depth === 0) {
          return i;
        }
      }
    }
  }
  throw new Error('could not find end of main function');
}

function findStylesStart(lines) {
  const idx = lines.findIndex((l) => /^const styles = StyleSheet\.create\(/.test(l));
  if (idx < 0) throw new Error('StyleSheet.create not found');
  return idx;
}

function collectImportBlock(lines) {
  const imports = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('import ')) {
      const block = [line];
      i++;
      while (
        i < lines.length &&
        !block[block.length - 1].includes(" from '") &&
        !block[block.length - 1].includes(' from "')
      ) {
        block.push(lines[i]);
        i++;
      }
      imports.push(block.join('\n'));
      continue;
    }
    if (line.trim() === '' || line.startsWith('//')) {
      i++;
      continue;
    }
    break;
  }
  return imports;
}

function skipHeaderLines(lines) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('import ')) {
      i++;
      while (
        i < lines.length &&
        !lines[i - 1].includes(" from '") &&
        !lines[i - 1].includes(' from "')
      ) {
        i++;
      }
      continue;
    }
    if (line.trim() === '' || line.startsWith('//')) {
      i++;
      continue;
    }
    break;
  }
  return i;
}

function stripStyleSheetFromImports(imports) {
  return imports
    .map((stmt) => {
      if (!stmt.includes("from 'react-native'") && !stmt.includes('from "react-native"')) {
        return stmt;
      }
      const match = stmt.match(/^import\s+\{([^}]+)\}\s+from\s+['"]react-native['"];?$/s);
      if (!match) return stmt;
      const parts = match[1]
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p && p !== 'StyleSheet');
      if (parts.length === 0) return '';
      return `import { ${parts.join(', ')} } from 'react-native';`;
    })
    .filter(Boolean);
}

function themeImportsFromStyles(stylesBlock) {
  const names = new Set();
  for (const key of ['colors', 'fonts', 'radii', 'spacing', 'baseStyles', 'lifecycleColor']) {
    if (stylesBlock.includes(`${key}.`)) names.add(key);
  }
  if (names.size === 0) return '';
  return `import { ${[...names].join(', ')} } from '../../lib/theme';\n`;
}

function extract(config) {
  const sourcePath = path.join(COMPANION_SRC, config.route);
  const raw = readFileSync(sourcePath, 'utf8');
  const lines = raw.split('\n');

  const mainEnd = findMainFunctionEnd(lines);
  const stylesStart = findStylesStart(lines);
  const panelStart = mainEnd + 1;

  const panelLines = lines.slice(panelStart, stylesStart).filter((l) => l.trim().length > 0);
  const styleLines = lines.slice(stylesStart);

  const featureDir = path.join(COMPANION_SRC, config.featureDir);
  const componentsDir = path.join(featureDir, 'components');
  const stylesDir = path.join(featureDir, 'styles');
  mkdirSync(componentsDir, { recursive: true });
  mkdirSync(stylesDir, { recursive: true });

  const stylesExport = config.stylesExport ?? 'styles';
  const stylesImportPath = `../styles/${config.stylesFile}`;

  // --- styles module ---
  const stylesBody = styleLines
    .join('\n')
    .replace(/^const styles = /, `export const ${stylesExport} = `);
  const stylesContent = `import { StyleSheet } from 'react-native';\n${themeImportsFromStyles(stylesBody)}${stylesBody}\n`;
  writeFileSync(path.join(stylesDir, `${config.stylesFile}.ts`), stylesContent);

  const importBlock = stripStyleSheetFromImports(collectImportBlock(lines));

  // --- panels module ---
  let panelsContent = '';
  if (panelLines.length > 0) {
    panelsContent = `${importBlock.join('\n')}\nimport { ${stylesExport} as styles } from '${stylesImportPath}';\n\n${panelLines.join('\n')}\n`;
    writeFileSync(path.join(componentsDir, `${config.panelsFile}.tsx`), panelsContent);
  }

  // --- screen module ---
  const bodyStart = skipHeaderLines(lines);
  const screenCore = lines.slice(bodyStart, mainEnd + 1).join('\n');
  const extraImports = [
    `import { ${stylesExport} as styles } from './styles/${config.stylesFile}';`,
    ...(panelLines.length > 0
      ? [`import { ${config.panelExports.join(', ')} } from './components/${config.panelsFile}';`]
      : []),
  ];
  const screenBody = `${importBlock.join('\n')}\n${extraImports.join('\n')}\n\n${screenCore}\n`;
  writeFileSync(path.join(featureDir, `${config.screenFile}.tsx`), `${screenBody}\n`);

  // --- thin route ---
  const routeDepth = config.route.split('/').length - 1;
  const up = '../'.repeat(routeDepth);
  const routeExport = `export { default } from '${up}${config.featureDir}/${config.screenFile}';\n`;
  writeFileSync(sourcePath, routeExport);

  const screenLoc = lineCount(path.join(featureDir, `${config.screenFile}.tsx`));
  console.log(
    `extracted ${config.route} → ${config.featureDir}/ (${screenLoc} screen lines, ${panelLines.length} panel lines)`,
  );
}

function lineCount(file) {
  return readFileSync(file, 'utf8').split('\n').length;
}

function panelExportNames(panelLines) {
  const names = [];
  for (const line of panelLines) {
    const fn = line.match(/^function (\w+)/);
    if (fn) names.push(fn[1]);
  }
  return names;
}

function prepareConfig(entry) {
  const sourcePath = path.join(COMPANION_SRC, entry.route);
  const lines = readFileSync(sourcePath, 'utf8').split('\n');
  const mainEnd = findMainFunctionEnd(lines);
  const stylesStart = findStylesStart(lines);
  const panelLines = lines.slice(mainEnd + 1, stylesStart).filter((l) => l.trim().length > 0);
  return {
    ...entry,
    panelExports: entry.panelExports ?? panelExportNames(panelLines),
  };
}

const FEATURES = [
  {
    route: 'app/diff/[runId].tsx',
    featureDir: 'features/diff',
    screenFile: 'RunDiffScreen',
    panelsFile: 'run-diff-panels',
    stylesFile: 'run-diff.styles',
    stylesExport: 'runDiffStyles',
  },
  {
    route: 'app/diff/slot/[slotId].tsx',
    featureDir: 'features/diff',
    screenFile: 'SlotDiffScreen',
    panelsFile: 'slot-diff-panels',
    stylesFile: 'slot-diff.styles',
    stylesExport: 'slotDiffStyles',
  },
  {
    route: 'app/terminal/worker.tsx',
    featureDir: 'features/terminal',
    screenFile: 'WorkerTerminalScreen',
    panelsFile: 'worker-terminal-panels',
    stylesFile: 'worker-terminal.styles',
    stylesExport: 'workerTerminalStyles',
  },
  {
    route: 'app/decision/[id].tsx',
    featureDir: 'features/decision-workspace',
    screenFile: 'DecisionWorkspaceScreen',
    panelsFile: 'decision-workspace-panels',
    stylesFile: 'decision-workspace.styles',
    stylesExport: 'decisionWorkspaceStyles',
  },
  {
    route: 'app/artifacts/[runId].tsx',
    featureDir: 'features/artifacts',
    screenFile: 'ArtifactViewerScreen',
    panelsFile: 'artifact-viewer-panels',
    stylesFile: 'artifact-viewer.styles',
    stylesExport: 'artifactViewerStyles',
  },
  {
    route: 'app/run/[id].tsx',
    featureDir: 'features/run-detail',
    screenFile: 'RunDetailScreen',
    panelsFile: 'run-detail-panels',
    stylesFile: 'run-detail.styles',
    stylesExport: 'runDetailStyles',
  },
  {
    route: 'app/terminal/[slotId].tsx',
    featureDir: 'features/terminal',
    screenFile: 'SlotTerminalScreen',
    panelsFile: 'slot-terminal-panels',
    stylesFile: 'slot-terminal.styles',
    stylesExport: 'slotTerminalStyles',
  },
];

for (const entry of FEATURES) {
  extract(prepareConfig(entry));
}

console.log('done');
