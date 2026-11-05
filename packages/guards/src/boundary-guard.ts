import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { BoundaryRule } from './config.js';

export interface BoundaryViolation {
  file: string;
  imported: string;
  sourcePackage: string;
  forbiddenTarget: string;
  line: number;
}

export interface BoundaryResult {
  hasViolations: boolean;
  violations: BoundaryViolation[];
  summary: string;
}

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      results.push(...collectSourceFiles(fullPath));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

export function checkBoundaries(projectRoot: string, rules: BoundaryRule[] = []): BoundaryResult {
  if (!rules || rules.length === 0) {
    return { hasViolations: false, violations: [], summary: 'PASS: No boundary rules configured' };
  }

  const violations: BoundaryViolation[] = [];

  for (const rule of rules) {
    const pkgDir = path.resolve(projectRoot, rule.package);
    if (!fs.existsSync(pkgDir)) continue;

    const files = collectSourceFiles(pkgDir);

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);

      function visit(node: ts.Node) {
        let importTarget: string | null = null;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            importTarget = node.moduleSpecifier.text;
          }
        }

        if (importTarget) {
          for (const forbidden of rule.disallowImportsFrom) {
            // Check direct import path matches or relative paths traversing into forbidden package
            const resolvedCandidate = importTarget.startsWith('.')
              ? path.resolve(path.dirname(file), importTarget)
              : null;
            const forbiddenAbs = path.resolve(projectRoot, forbidden);

            const isDirectMatch = importTarget.includes(forbidden);
            const isPathMatch = resolvedCandidate && resolvedCandidate.startsWith(forbiddenAbs);

            if (isDirectMatch || isPathMatch) {
              const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              violations.push({
                file: path.relative(projectRoot, file),
                imported: importTarget,
                sourcePackage: rule.package,
                forbiddenTarget: forbidden,
                line: line + 1,
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }
  }

  const hasViolations = violations.length > 0;
  const summary = hasViolations
    ? `FAIL: Found ${violations.length} boundary violation(s)`
    : `PASS: 0 architectural boundary violations across ${rules.length} rule set(s)`;

  return { hasViolations, violations, summary };
}
