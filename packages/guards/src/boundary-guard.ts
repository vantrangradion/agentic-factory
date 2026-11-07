import * as fs from 'node:fs';
import * as path from 'node:path';
import { BoundaryRule } from './config.js';
import { collectSourceFiles } from './fs-walk.js';
import { adapterForFile, getAdapters, LanguageAdapter } from './languages/index.js';

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

export function checkBoundaries(
  projectRoot: string,
  rules: BoundaryRule[] = [],
  adapters: LanguageAdapter[] = getAdapters()
): BoundaryResult {
  if (!rules || rules.length === 0) {
    return { hasViolations: false, violations: [], summary: 'PASS: No boundary rules configured' };
  }

  const violations: BoundaryViolation[] = [];

  for (const rule of rules) {
    const pkgDir = path.resolve(projectRoot, rule.package);
    if (!fs.existsSync(pkgDir)) continue;

    const files = collectSourceFiles(pkgDir, {
      include: (name) => adapters.some((a) => a.isSourceFile(name)),
    });

    for (const file of files) {
      const adapter = adapterForFile(adapters, file)!;
      const content = fs.readFileSync(file, 'utf-8');

      for (const imp of adapter.extractImports(file, content)) {
        if (imp.dynamic) continue;
        const pathLike = adapter.toPathLike(imp.spec);

        for (const forbidden of rule.disallowImportsFrom) {
          // Check direct import path matches or relative paths traversing into forbidden package
          const resolvedCandidate = pathLike.startsWith('.') ? path.resolve(path.dirname(file), pathLike) : null;
          const forbiddenAbs = path.resolve(projectRoot, forbidden);

          const isDirectMatch = pathLike.includes(forbidden);
          const isPathMatch = resolvedCandidate && resolvedCandidate.startsWith(forbiddenAbs);

          if (isDirectMatch || isPathMatch) {
            violations.push({
              file: path.relative(projectRoot, file),
              imported: imp.spec,
              sourcePackage: rule.package,
              forbiddenTarget: forbidden,
              line: imp.line,
            });
          }
        }
      }
    }
  }

  const hasViolations = violations.length > 0;
  const summary = hasViolations
    ? `FAIL: Found ${violations.length} boundary violation(s)`
    : `PASS: 0 architectural boundary violations across ${rules.length} rule set(s)`;

  return { hasViolations, violations, summary };
}
