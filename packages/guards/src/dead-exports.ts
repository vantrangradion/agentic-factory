import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { DeadExportsConfig } from './config.js';

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
}

interface ExportItem {
  file: string;
  symbol: string;
  line: number;
  col: number;
}

function resolveImportPath(containingFile: string, moduleSpecifier: string): string | null {
  if (!moduleSpecifier.startsWith('.')) {
    return null;
  }
  const containingDir = path.dirname(containingFile);
  const candidate = path.resolve(containingDir, moduleSpecifier);

  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  // Support ESM TypeScript imports referencing .js/.jsx
  const stripCandidate = candidate.replace(/\.(js|jsx)$/, '');
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];

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

function collectSourceFiles(dir: string, exclude: string[] = []): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (exclude.some((ex) => fullPath.includes(ex) || entry.name === ex)) continue;

    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'coverage'].includes(entry.name)) continue;
      results.push(...collectSourceFiles(fullPath, exclude));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

function isEntryPointFile(filePath: string, customEntryPoints: string[] = []): boolean {
  const basename = path.basename(filePath);
  if (customEntryPoints.some((ep) => filePath.endsWith(ep) || basename === ep)) {
    return true;
  }
  return /^(index|cli|main)\.(ts|tsx|js|jsx)$/.test(basename);
}

export function checkDeadExports(
  projectRoot: string,
  config?: DeadExportsConfig
): DeadExportsResult {
  if (config?.enabled === false) {
    return {
      hasViolations: false,
      violations: [],
      summary: 'PASS: Dead export scanner disabled',
    };
  }

  const rootDir = path.resolve(projectRoot, config?.rootDir || '.');
  const exclude = config?.exclude || ['node_modules', 'dist'];
  const entryPoints = config?.entryPoints || [];

  const files = collectSourceFiles(rootDir, exclude);
  const exportsByFile = new Map<string, ExportItem[]>();
  const usedExportsByFile = new Map<string, Set<string>>();
  const wildcardReExportedFiles = new Set<string>();

  // Parse all files
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);

    const isEntry = isEntryPointFile(file, entryPoints);

    function visit(node: ts.Node) {
      // 1. Collect declarations with 'export' modifier
      const hasExportModifier =
        ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

      if (hasExportModifier && !isEntry) {
        if (ts.isFunctionDeclaration(node) && node.name) {
          addExport(file, node.name.text, node.name.getStart(), sourceFile);
        } else if (ts.isClassDeclaration(node) && node.name) {
          addExport(file, node.name.text, node.name.getStart(), sourceFile);
        } else if (ts.isInterfaceDeclaration(node) && node.name) {
          addExport(file, node.name.text, node.name.getStart(), sourceFile);
        } else if (ts.isTypeAliasDeclaration(node) && node.name) {
          addExport(file, node.name.text, node.name.getStart(), sourceFile);
        } else if (ts.isEnumDeclaration(node) && node.name) {
          addExport(file, node.name.text, node.name.getStart(), sourceFile);
        } else if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              addExport(file, decl.name.text, decl.name.getStart(), sourceFile);
            }
          }
        }
      }

      // 2. Export declaration: export { a, b } or export * from '...'
      if (ts.isExportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : null;

        if (moduleSpecifier) {
          const target = resolveImportPath(file, moduleSpecifier);
          if (target) {
            if (!node.exportClause) {
              // export * from './foo.js'
              wildcardReExportedFiles.add(target);
            } else if (ts.isNamedExports(node.exportClause)) {
              for (const el of node.exportClause.elements) {
                markUsed(target, el.propertyName ? el.propertyName.text : el.name.text);
              }
            }
          }
        } else if (node.exportClause && ts.isNamedExports(node.exportClause) && !isEntry) {
          for (const el of node.exportClause.elements) {
            addExport(file, el.name.text, el.name.getStart(), sourceFile);
          }
        }
      }

      // 3. Import declaration: import { a } from '...' or import * as a from '...'
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveImportPath(file, node.moduleSpecifier.text);
        if (target && node.importClause) {
          if (node.importClause.name) {
            markUsed(target, 'default');
          }
          if (node.importClause.namedBindings) {
            if (ts.isNamespaceImport(node.importClause.namedBindings)) {
              wildcardReExportedFiles.add(target);
            } else if (ts.isNamedImports(node.importClause.namedBindings)) {
              for (const el of node.importClause.namedBindings.elements) {
                markUsed(target, el.propertyName ? el.propertyName.text : el.name.text);
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  function addExport(file: string, symbol: string, pos: number, sf: ts.SourceFile) {
    if (!exportsByFile.has(file)) {
      exportsByFile.set(file, []);
    }
    const { line, character } = sf.getLineAndCharacterOfPosition(pos);
    exportsByFile.get(file)!.push({
      file,
      symbol,
      line: line + 1,
      col: character + 1,
    });
  }

  function markUsed(file: string, symbol: string) {
    if (!usedExportsByFile.has(file)) {
      usedExportsByFile.set(file, new Set());
    }
    usedExportsByFile.get(file)!.add(symbol);
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

  const hasViolations = violations.length > 0;
  const summary = hasViolations
    ? `FAIL: Found ${violations.length} unused / dead export(s)`
    : `PASS: 0 dead exports detected across codebase`;

  return { hasViolations, violations, summary };
}
