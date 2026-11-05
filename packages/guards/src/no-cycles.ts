import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { NoCyclesConfig } from './config.js';

export interface CycleResult {
  hasCycles: boolean;
  cycles: string[][];
  summary: string;
}

function resolveImportPath(containingFile: string, moduleSpecifier: string): string | null {
  if (!moduleSpecifier.startsWith('.')) {
    return null; // External package
  }
  const containingDir = path.dirname(containingFile);
  const candidate = path.resolve(containingDir, moduleSpecifier);

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }
  const stripCandidate = candidate.replace(/\.(js|jsx)$/, '');
  for (const ext of extensions) {
    const full = stripCandidate + ext;
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return full;
    }
  }
  for (const ext of extensions) {
    const full = candidate + ext;
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return full;
    }
  }
  return null;
}

function extractImports(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      imports.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

function collectSourceFiles(dir: string, exclude: string[] = []): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (exclude.some((ex) => fullPath.includes(ex))) continue;

    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      results.push(...collectSourceFiles(fullPath, exclude));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

export function checkNoCycles(projectRoot: string, config?: NoCyclesConfig): CycleResult {
  if (config?.enabled === false) {
    return { hasCycles: false, cycles: [], summary: 'PASS: Cycle guard disabled in config' };
  }

  const rootDir = path.resolve(projectRoot, config?.rootDir || '.');
  const exclude = config?.exclude || ['node_modules', 'dist'];
  const files = collectSourceFiles(rootDir, exclude);

  const graph = new Map<string, string[]>();
  for (const file of files) {
    const imports = extractImports(file);
    const resolvedDeps: string[] = [];
    for (const imp of imports) {
      const resolved = resolveImportPath(file, imp);
      if (resolved && files.includes(resolved)) {
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

