import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as TS from 'typescript';
import { loadTypeScript } from './ts-loader.js';
import { CommentRef, ExportFacts, ImportRef, LanguageAdapter, StringRef } from './types.js';

const SOURCE_FILE = /\.(ts|tsx|js|jsx)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;
const ENTRY_FILE = /^(index|cli|main)\.(ts|tsx|js|jsx)$/;
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];

const CODE_LINE_PATTERNS = [
  /^\s*(?:const|let|var)\s+[a-zA-Z0-9_$]+\s*[:=]/,
  /^\s*(?:async\s+)?function\s+[a-zA-Z0-9_$]*\s*\(/,
  /^\s*class\s+[a-zA-Z0-9_$]+(?:\s+extends|\s+implements|\s*\{)/,
  /^\s*interface\s+[a-zA-Z0-9_$]+(?:\s+extends|\s*\{)/,
  /^\s*type\s+[A-Z][a-zA-Z0-9_$]*\s*=/,
  /^\s*import\s+(?:\{|\*|[a-zA-Z0-9_$]+|\s*).*(?:from|require\()/,
  /^\s*export\s+(?:default|const|let|var|function|class|interface|type|\{)/,
  /^\s*return\s+[^;]+;$/,
  /^\s*(?:if|while|for|switch)\s*\([^)]+\)\s*\{?$/,
  /^\s*throw\s+new\s+[a-zA-Z0-9_$]+(?:\(|$)/,
  /^\s*await\s+[a-zA-Z0-9_$]+(?:\.[a-zA-Z0-9_$]+)*\(/,
  /^\s*[a-zA-Z0-9_$]+(?:\.[a-zA-Z0-9_$]+)+\([^)]*\);?$/,
  /^\s*[a-zA-Z0-9_$]+\s*=\s*[^;]+;$/,
];

function parse(file: string, content: string): { ts: typeof TS; sf: TS.SourceFile } {
  const ts = loadTypeScript();
  return { ts, sf: ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true) };
}

function lineOf(sf: TS.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

export const typescriptAdapter: LanguageAdapter = {
  id: 'typescript',

  isSourceFile: (name) => SOURCE_FILE.test(name) && !name.endsWith('.d.ts'),
  isTestFile: (name) => TEST_FILE.test(name),
  isEntryPoint: (name) => ENTRY_FILE.test(path.basename(name)),

  extractImports(file, content): ImportRef[] {
    const { ts, sf } = parse(file, content);
    const imports: ImportRef[] = [];

    function visit(node: TS.Node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          imports.push({ spec: node.moduleSpecifier.text, line: lineOf(sf, node.getStart()), dynamic: false });
        }
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]!)
      ) {
        imports.push({ spec: node.arguments[0]!.text, line: lineOf(sf, node.getStart()), dynamic: true });
      }
      ts.forEachChild(node, visit);
    }

    visit(sf);
    return imports;
  },

  resolveImport(fromFile, spec) {
    if (!spec.startsWith('.')) {
      return null; // External package
    }
    const candidate = path.resolve(path.dirname(fromFile), spec);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    // Support ESM TypeScript imports referencing .js/.jsx
    const stripped = candidate.replace(/\.(js|jsx)$/, '');
    for (const base of [stripped, candidate]) {
      for (const ext of RESOLVE_EXTENSIONS) {
        const full = base + ext;
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return full;
        }
      }
    }
    return null;
  },

  toPathLike: (spec) => spec,

  extractComments(file, content): CommentRef[] {
    const { ts, sf } = parse(file, content);
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, content);
    const comments: CommentRef[] = [];

    let token = scanner.scan();
    while (token !== ts.SyntaxKind.EndOfFileToken) {
      const isLine = token === ts.SyntaxKind.SingleLineCommentTrivia;
      const isBlock = token === ts.SyntaxKind.MultiLineCommentTrivia;
      if (isLine || isBlock) {
        const raw = scanner.getTokenText();
        const { line, character } = sf.getLineAndCharacterOfPosition(scanner.getTokenPos());
        const bodyLines = isLine
          ? [raw.replace(/^\/\//, '')]
          : raw
              .split('\n')
              .map((l) => l.replace(/^\/\*/, '').replace(/\*\/$/, '').replace(/^\s*\*?\s?/, ''));
        comments.push({ line: line + 1, col: character + 1, raw, bodyLines, isDoc: raw.startsWith('/**') });
      }
      token = scanner.scan();
    }
    return comments;
  },

  looksLikeCode(text) {
    const trimmed = text.trim();
    if (!trimmed) return false;
    // Ignore linter directives, type annotations, and URLs
    if (
      trimmed.startsWith('eslint-') ||
      trimmed.startsWith('@ts-') ||
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('<reference')
    ) {
      return false;
    }
    return CODE_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
  },

  extractStrings(file, content): StringRef[] {
    const { ts, sf } = parse(file, content);
    const strings: StringRef[] = [];

    function visit(node: TS.Node) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        strings.push({ line: lineOf(sf, node.getStart()), text: node.text });
      }
      ts.forEachChild(node, visit);
    }

    visit(sf);
    return strings;
  },

  analyzeExports(file, content, isEntry, resolve): ExportFacts {
    const { ts, sf } = parse(file, content);
    const facts: ExportFacts = { exports: [], used: [], wildcardTargets: [] };

    const addExport = (symbol: string, pos: number) => {
      const { line, character } = sf.getLineAndCharacterOfPosition(pos);
      facts.exports.push({ symbol, line: line + 1, col: character + 1 });
    };
    const markUsed = (target: string, symbol: string) => facts.used.push({ target, symbol });

    function visit(node: TS.Node) {
      // 1. Collect declarations with 'export' modifier
      const hasExportModifier =
        ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

      if (hasExportModifier && !isEntry) {
        if (
          (ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isEnumDeclaration(node)) &&
          node.name
        ) {
          addExport(node.name.text, node.name.getStart());
        } else if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              addExport(decl.name.text, decl.name.getStart());
            }
          }
        }
      }

      // 2. Export declaration: export { a, b } or export * from '...'
      if (ts.isExportDeclaration(node)) {
        const moduleSpecifier =
          node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;

        if (moduleSpecifier) {
          const target = resolve(moduleSpecifier);
          if (target) {
            if (!node.exportClause) {
              facts.wildcardTargets.push(target);
            } else if (ts.isNamedExports(node.exportClause)) {
              for (const el of node.exportClause.elements) {
                markUsed(target, el.propertyName ? el.propertyName.text : el.name.text);
              }
            }
          }
        } else if (node.exportClause && ts.isNamedExports(node.exportClause) && !isEntry) {
          for (const el of node.exportClause.elements) {
            addExport(el.name.text, el.name.getStart());
          }
        }
      }

      // 3. Import declaration: import { a } from '...' or import * as a from '...'
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolve(node.moduleSpecifier.text);
        if (target && node.importClause) {
          if (node.importClause.name) {
            markUsed(target, 'default');
          }
          const bindings = node.importClause.namedBindings;
          if (bindings) {
            if (ts.isNamespaceImport(bindings)) {
              facts.wildcardTargets.push(target);
            } else if (ts.isNamedImports(bindings)) {
              for (const el of bindings.elements) {
                markUsed(target, el.propertyName ? el.propertyName.text : el.name.text);
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sf);
    return facts;
  },
};
