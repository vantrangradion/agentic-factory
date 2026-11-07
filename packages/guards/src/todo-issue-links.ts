import * as fs from 'node:fs';
import * as path from 'node:path';
import { TodoIssueConfig } from './config.js';
import { collectSourceFiles } from './fs-walk.js';
import { adapterForFile, getAdapters, LanguageAdapter } from './languages/index.js';

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

export function checkTodoIssueLinks(
  projectRoot: string,
  config?: TodoIssueConfig,
  adapters: LanguageAdapter[] = getAdapters()
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
  const issuePattern = config?.issuePattern ? new RegExp(config.issuePattern, 'i') : DEFAULT_ISSUE_PATTERN;

  const violations: TodoViolation[] = [];

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
        // Inspect whether comment matches actionable markers
        if (!/\b(TODO|FIXME)\b/i.test(comment.raw)) continue;

        if (!issuePattern.test(comment.bodyLines.join('\n'))) {
          violations.push({
            file: path.relative(projectRoot, file),
            line: comment.line,
            col: comment.col,
            text: comment.raw.split('\n')[0]!.trim(),
          });
        }
      }
    }
  }

  const hasViolations = violations.length > 0;
  const summary = hasViolations
    ? `FAIL: Found ${violations.length} TODO/FIXME comment(s) missing issue tracker links`
    : `PASS: 0 unresolved TODOs without issue tracker links detected`;

  return { hasViolations, violations, summary };
}
