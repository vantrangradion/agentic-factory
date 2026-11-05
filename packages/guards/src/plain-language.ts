import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { PlainLanguageConfig } from './config.js';

export interface JargonViolation {
  file: string;
  term: string;
  snippet: string;
  line: number;
}

export interface PlainLanguageResult {
  hasViolations: boolean;
  violations: JargonViolation[];
  summary: string;
}

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', '__tests__'].includes(entry.name)) continue;
      results.push(...collectSourceFiles(fullPath));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      results.push(fullPath);
    }
  }
  return results;
}

export function checkPlainLanguage(projectRoot: string, config?: PlainLanguageConfig): PlainLanguageResult {
  if (config?.enabled === false || !config?.forbiddenTerms || config.forbiddenTerms.length === 0) {
    return { hasViolations: false, violations: [], summary: 'PASS: Plain language check disabled or no terms configured' };
  }

  const targetDirs = config.targetDirs || ['src'];
  const forbiddenTerms = config.forbiddenTerms.map((t) => t.toLowerCase());
  const violations: JargonViolation[] = [];

  for (const relDir of targetDirs) {
    const fullDir = path.resolve(projectRoot, relDir);
    const files = collectSourceFiles(fullDir);

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);

      function visit(node: ts.Node) {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          const text = node.text.toLowerCase();
          for (const term of forbiddenTerms) {
            // Match whole word or exact token
            const regex = new RegExp(`\\b${term}\\b`, 'i');
            if (regex.test(text)) {
              const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              violations.push({
                file: path.relative(projectRoot, file),
                term,
                snippet: node.text.length > 60 ? `${node.text.slice(0, 57)}...` : node.text,
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
    ? `FAIL: Found ${violations.length} user-facing jargon violation(s)`
    : `PASS: 0 user-facing jargon violations found across target surfaces`;

  return { hasViolations, violations, summary };
}
