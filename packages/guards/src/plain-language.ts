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
    } else if (/\.(md|json)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

export function checkPlainLanguage(projectRoot: string, config?: PlainLanguageConfig): PlainLanguageResult {
  const hasTerms = Boolean(config?.forbiddenTerms && config.forbiddenTerms.length > 0);
  const disallowEmDashes = Boolean(config?.disallowEmDashes);
  const disallowEmojis = Boolean(config?.disallowEmojis);

  if (config?.enabled === false || (!hasTerms && !disallowEmDashes && !disallowEmojis)) {
    return { hasViolations: false, violations: [], summary: 'PASS: Plain language check disabled or not configured' };
  }

  const targetDirs = config?.targetDirs || ['src'];
  const forbiddenTerms = (config?.forbiddenTerms || []).map((t) => t.toLowerCase());
  const violations: JargonViolation[] = [];

  for (const relDir of targetDirs) {
    const fullDir = path.resolve(projectRoot, relDir);
    const files = collectSourceFiles(fullDir);

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');

      if (file.endsWith('.md') || file.endsWith('.json')) {
        const lines = content.split('\n');
        lines.forEach((lineText, idx) => {
          if (disallowEmDashes && lineText.includes('\u2014')) {
            violations.push({
              file: path.relative(projectRoot, file),
              term: 'em-dash (\u2014)',
              snippet: lineText.trim().length > 60 ? `${lineText.trim().slice(0, 57)}...` : lineText.trim(),
              line: idx + 1,
            });
          }
          if (disallowEmojis && /\p{Extended_Pictographic}/u.test(lineText)) {
            violations.push({
              file: path.relative(projectRoot, file),
              term: 'emoji/icon',
              snippet: lineText.trim().length > 60 ? `${lineText.trim().slice(0, 57)}...` : lineText.trim(),
              line: idx + 1,
            });
          }
          if (hasTerms) {
            for (const term of forbiddenTerms) {
              const regex = new RegExp(`\\b${term}\\b`, 'i');
              if (regex.test(lineText)) {
                violations.push({
                  file: path.relative(projectRoot, file),
                  term,
                  snippet: lineText.trim().length > 60 ? `${lineText.trim().slice(0, 57)}...` : lineText.trim(),
                  line: idx + 1,
                });
              }
            }
          }
        });
        continue;
      }

      const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);

      function visit(node: ts.Node) {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          const rawText = node.text;
          const lowerText = rawText.toLowerCase();

          if (hasTerms) {
            for (const term of forbiddenTerms) {
              const regex = new RegExp(`\\b${term}\\b`, 'i');
              if (regex.test(lowerText)) {
                const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
                violations.push({
                  file: path.relative(projectRoot, file),
                  term,
                  snippet: rawText.length > 60 ? `${rawText.slice(0, 57)}...` : rawText,
                  line: line + 1,
                });
              }
            }
          }

          if (disallowEmDashes && rawText.includes('\u2014')) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            violations.push({
              file: path.relative(projectRoot, file),
              term: 'em-dash (\u2014)',
              snippet: rawText.length > 60 ? `${rawText.slice(0, 57)}...` : rawText,
              line: line + 1,
            });
          }

          if (disallowEmojis && /\p{Extended_Pictographic}/u.test(rawText)) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            violations.push({
              file: path.relative(projectRoot, file),
              term: 'emoji/icon',
              snippet: rawText.length > 60 ? `${rawText.slice(0, 57)}...` : rawText,
              line: line + 1,
            });
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }
  }

  const hasViolations = violations.length > 0;
  const summary = hasViolations
    ? `FAIL: Found ${violations.length} user-facing jargon / style violation(s)`
    : `PASS: 0 user-facing jargon violations found across target surfaces`;

  return { hasViolations, violations, summary };
}
