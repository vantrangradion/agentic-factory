import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { TodoIssueConfig } from './config.js';

export interface TodoViolation {
  file: string;
  line: number;
  col: number;
  text: string;
}

export interface TodoIssueResult {
  hasViolations: boolean;
  violations: TodoViolation[];
  summary: string;
}

const DEFAULT_ISSUE_PATTERN = /(?:#\d+|https?:\/\/[^\s)]+|[A-Z][A-Z0-9]+-\d+|issue[-#:\s]*\d+)/i;

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

export function checkTodoIssueLinks(
  projectRoot: string,
  config?: TodoIssueConfig
): TodoIssueResult {
  if (config?.enabled === false) {
    return {
      hasViolations: false,
      violations: [],
      summary: 'PASS: TODO issue link guard disabled',
    };
  }

  const targetDirs = config?.targetDirs || ['.'];
  const exclude = config?.exclude || ['node_modules', 'dist'];
  const issuePattern = config?.issuePattern
    ? new RegExp(config.issuePattern, 'i')
    : DEFAULT_ISSUE_PATTERN;

  const violations: TodoViolation[] = [];

  for (const relDir of targetDirs) {
    const fullDir = path.resolve(projectRoot, relDir);
    const files = collectSourceFiles(fullDir, exclude);

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, content);

      let token = scanner.scan();
      while (token !== ts.SyntaxKind.EndOfFileToken) {
        if (
          token === ts.SyntaxKind.SingleLineCommentTrivia ||
          token === ts.SyntaxKind.MultiLineCommentTrivia
        ) {
          const rawComment = scanner.getTokenText();
          const commentPos = scanner.getTokenPos();

          // Inspect whether comment matches actionable markers
          if (/\b(TODO|FIXME)\b/i.test(rawComment)) {
            // Strip comment delimiters
            const commentBody = rawComment
              .replace(/^\/\//, '')
              .replace(/^\/\*/, '')
              .replace(/\*\/$/, '');

            if (!issuePattern.test(commentBody)) {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(commentPos);
              const trimmed = rawComment.split('\n')[0]!.trim();
              violations.push({
                file: path.relative(projectRoot, file),
                line: line + 1,
                col: character + 1,
                text: trimmed,
              });
            }
          }
        }
        token = scanner.scan();
      }
    }
  }

  const hasViolations = violations.length > 0;
  const summary = hasViolations
    ? `FAIL: Found ${violations.length} TODO/FIXME comment(s) missing issue tracker links`
    : `PASS: 0 unresolved TODOs without issue tracker links detected`;

  return { hasViolations, violations, summary };
}
