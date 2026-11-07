import * as fs from 'node:fs';
import * as path from 'node:path';
import { NoCyclesConfig } from './config.js';
import { collectSourceFiles } from './fs-walk.js';
import { adapterForFile, getAdapters, LanguageAdapter } from './languages/index.js';

export interface CycleResult {
  hasCycles: boolean;
  cycles: string[][];
  summary: string;
}

export function checkNoCycles(
  projectRoot: string,
  config?: NoCyclesConfig,
  adapters: LanguageAdapter[] = getAdapters()
): CycleResult {
  if (config?.enabled === false) {
    return { hasCycles: false, cycles: [], summary: 'PASS: Cycle guard disabled in config' };
  }

  const rootDir = path.resolve(projectRoot, config?.rootDir || '.');
  const exclude = config?.exclude || ['node_modules', 'dist'];
  const files = collectSourceFiles(rootDir, {
    include: (name) => adapters.some((a) => a.isSourceFile(name)),
    exclude,
  });
  const fileSet = new Set(files);
  const roots = [rootDir, path.resolve(projectRoot)];

  const graph = new Map<string, string[]>();
  for (const file of files) {
    const adapter = adapterForFile(adapters, file)!;
    const content = fs.readFileSync(file, 'utf-8');
    const resolvedDeps: string[] = [];
    for (const imp of adapter.extractImports(file, content)) {
      const resolved = adapter.resolveImport(file, imp.spec, roots);
      if (resolved && fileSet.has(resolved)) {
        resolvedDeps.push(resolved);
      }
    }
    graph.set(file, resolvedDeps);
  }

  // Detect cycles using DFS
  const visited = new Set<string>();
  const recursionStack: string[] = [];
  const detectedCycles: string[][] = [];

  function dfs(node: string) {
    visited.add(node);
    recursionStack.push(node);

    const neighbors = graph.get(node) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else {
        const cycleStartIndex = recursionStack.indexOf(neighbor);
        if (cycleStartIndex !== -1) {
          const cycle = recursionStack.slice(cycleStartIndex).concat(neighbor);
          detectedCycles.push(cycle);
        }
      }
    }

    recursionStack.pop();
  }

  for (const file of files) {
    if (!visited.has(file)) {
      dfs(file);
    }
  }

  const hasCycles = detectedCycles.length > 0;
  const summary = hasCycles
    ? `FAIL: Found ${detectedCycles.length} circular dependency cycle(s)`
    : `PASS: 0 circular dependencies detected across ${files.length} source file(s)`;

  return { hasCycles, cycles: detectedCycles, summary };
}
