import * as fs from 'node:fs';
import * as path from 'node:path';
import { DeadExportsConfig } from './config.js';
import { collectSourceFiles } from './fs-walk.js';
import { adapterForFile, getAdapters, LanguageAdapter } from './languages/index.js';

export interface DeadExportViolation {
  file: string;
  symbol: string;
  line: number;
  col: number;
}

export interface DeadExportsResult {
  hasViolations: boolean;
  violations: DeadExportViolation[];
  summary: string;
  /** Informational notes, such as languages this guard could not analyze. */
  notes: string[];
}

function isEntryPointFile(adapter: LanguageAdapter, filePath: string, customEntryPoints: string[]): boolean {
  const basename = path.basename(filePath);
  if (customEntryPoints.some((ep) => filePath.endsWith(ep) || basename === ep)) {
    return true;
  }
  return adapter.isEntryPoint(basename);
}

export function checkDeadExports(
  projectRoot: string,
  config?: DeadExportsConfig,
  adapters: LanguageAdapter[] = getAdapters()
): DeadExportsResult {
  if (config?.enabled === false) {
    return {
      hasViolations: false,
      violations: [],
      summary: 'PASS: Dead export scanner disabled',
      notes: [],
    };
  }

  const rootDir = path.resolve(projectRoot, config?.rootDir || '.');
  const exclude = config?.exclude || ['node_modules', 'dist'];
  const entryPoints = config?.entryPoints || [];
  const roots = [rootDir, path.resolve(projectRoot)];

  const files = collectSourceFiles(rootDir, {
    include: (name) => adapters.some((a) => a.isSourceFile(name)),
    exclude,
    skipDirs: ['coverage'],
  });

  const exportsByFile = new Map<string, { symbol: string; line: number; col: number }[]>();
  const usedExportsByFile = new Map<string, Set<string>>();
  const wildcardReExportedFiles = new Set<string>();
  const unsupported = new Map<string, number>();

  for (const file of files) {
    const adapter = adapterForFile(adapters, file)!;
    if (!adapter.analyzeExports) {
      unsupported.set(adapter.id, (unsupported.get(adapter.id) ?? 0) + 1);
      continue;
    }

    const content = fs.readFileSync(file, 'utf-8');
    const isEntry = isEntryPointFile(adapter, file, entryPoints);
    const facts = adapter.analyzeExports(file, content, isEntry, (spec) => adapter.resolveImport(file, spec, roots));

    if (facts.exports.length > 0) {
      exportsByFile.set(file, [...(exportsByFile.get(file) ?? []), ...facts.exports]);
    }
    for (const { target, symbol } of facts.used) {
      if (!usedExportsByFile.has(target)) usedExportsByFile.set(target, new Set());
      usedExportsByFile.get(target)!.add(symbol);
    }
    facts.wildcardTargets.forEach((t) => wildcardReExportedFiles.add(t));
  }

  const violations: DeadExportViolation[] = [];

  for (const [file, exportList] of exportsByFile.entries()) {
    if (wildcardReExportedFiles.has(file)) {
      continue;
    }
    const used = usedExportsByFile.get(file) || new Set();
    for (const exp of exportList) {
      if (!used.has(exp.symbol)) {
        violations.push({
          file: path.relative(projectRoot, file),
          symbol: exp.symbol,
          line: exp.line,
          col: exp.col,
        });
      }
    }
  }

  const notes = [...unsupported.entries()].map(
    ([lang, count]) => `dead-export analysis is not available for ${lang} yet; skipped ${count} file(s)`
  );

  const hasViolations = violations.length > 0;
  const summary = hasViolations
    ? `FAIL: Found ${violations.length} unused / dead export(s)`
    : `PASS: 0 dead exports detected across codebase`;

  return { hasViolations, violations, summary, notes };
}
