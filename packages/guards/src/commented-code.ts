import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { CommentedCodeConfig } from './config.js';

export interface CommentedCodeViolation {
  file: string;
  line: number;
  col: number;
  snippet: string;
}

export interface CommentedCodeResult {
  hasViolations: boolean;
  violations: CommentedCodeViolation[];
  summary: string;
}

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

function isCommentedOutCode(text: string): boolean {
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
}

function collectSourceFiles(dir: string, exclude: string[] = []): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (exclude.some((ex) => fullPath.includes(ex) || entry.name === ex)) continue;

    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'coverage', '__tests__'].includes(entry.name)) continue;
      results.push(...collectSourceFiles(fullPath, exclude));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      results.push(fullPath);
    }
  }
  return results;
}

export function checkCommentedCode(
  projectRoot: string,
  config?: CommentedCodeConfig
): CommentedCodeResult {
  if (config?.enabled === false) {
    return {
      hasViolations: false,
      violations: [],
      summary: 'PASS: Commented-out code detector disabled',
    };
  }

  const targetDirs = config?.targetDirs || ['.'];
  const exclude = config?.exclude || ['node_modules', 'dist'];
  const violations: CommentedCodeViolation[] = [];

  for (const relDir of targetDirs) {
    const fullDir = path.resolve(projectRoot, relDir);
    const files = collectSourceFiles(fullDir, exclude);

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, content);

      let token = scanner.scan();
      while (token !== ts.SyntaxKind.EndOfFileToken) {
        if (token === ts.SyntaxKind.SingleLineCommentTrivia) {
          const raw = scanner.getTokenText();
          const pos = scanner.getTokenPos();
          const body = raw.replace(/^\/\//, '');

          if (isCommentedOutCode(body)) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
            const trimmed = body.trim();
            violations.push({
              file: path.relative(projectRoot, file),
              line: line + 1,
              col: character + 1,
              snippet: trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed,
            });
          }
        } else if (token === ts.SyntaxKind.MultiLineCommentTrivia) {
          const raw = scanner.getTokenText();
          const pos = scanner.getTokenPos();

          // Skip JSDoc comments
          if (!raw.startsWith('/**')) {
            const lines = raw.split('\n');
            let offset = pos;

            for (let idx = 0; idx < lines.length; idx++) {
              const line = lines[idx]!;
              const stripped = line.replace(/^\/\*/, '').replace(/\*\/$/, '').replace(/^\s*\*?\s?/, '');

              if (isCommentedOutCode(stripped)) {
                const { line: lineNum, character } = sourceFile.getLineAndCharacterOfPosition(offset);
                const trimmed = stripped.trim();
                violations.push({
                  file: path.relative(projectRoot, file),
                  line: lineNum + 1,
                  col: character + 1,
                  snippet: trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed,
                });
              }
              offset += line.length + 1;
            }
          }
        }
        token = scanner.scan();
      }
    }
  }

  const hasViolations = violations.length > 0;
  const summary = hasViolations
    ? `FAIL: Found ${violations.length} commented-out code snippet(s)`
    : `PASS: 0 commented-out code blocks detected across codebase`;

  return { hasViolations, violations, summary };
}
