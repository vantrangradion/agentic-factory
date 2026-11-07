import * as fs from 'node:fs';
import * as path from 'node:path';
import { CommentedCodeConfig } from './config.js';
import { collectSourceFiles } from './fs-walk.js';
import { adapterForFile, getAdapters, LanguageAdapter } from './languages/index.js';

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

function truncate(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

export function checkCommentedCode(
  projectRoot: string,
  config?: CommentedCodeConfig,
  adapters: LanguageAdapter[] = getAdapters()
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
    const files = collectSourceFiles(fullDir, {
      include: (name) => adapters.some((a) => a.isSourceFile(name) && !a.isTestFile(name)),
      exclude,
      skipDirs: ['coverage', '__tests__'],
    });

    for (const file of files) {
      const adapter = adapterForFile(adapters, file)!;
      const content = fs.readFileSync(file, 'utf-8');

      for (const comment of adapter.extractComments(file, content)) {
        // Documentation comments describe code; they never disable it.
        if (comment.isDoc) continue;

        comment.bodyLines.forEach((body, idx) => {
          if (adapter.looksLikeCode(body)) {
            violations.push({
              file: path.relative(projectRoot, file),
              line: comment.line + idx,
              col: idx === 0 ? comment.col : 1,
              snippet: truncate(body.trim()),
            });
          }
        });
      }
    }
  }

  const hasViolations = violations.length > 0;
  const summary = hasViolations
    ? `FAIL: Found ${violations.length} commented-out code snippet(s)`
    : `PASS: 0 commented-out code blocks detected across codebase`;

  return { hasViolations, violations, summary };
}
