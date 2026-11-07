import * as fs from 'node:fs';
import * as path from 'node:path';
import { PlainLanguageConfig } from './config.js';
import { collectSourceFiles } from './fs-walk.js';
import { adapterForFile, getAdapters, LanguageAdapter } from './languages/index.js';

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

const PROSE_FILE = /\.(md|json)$/;

function truncate(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

export function checkPlainLanguage(
  projectRoot: string,
  config?: PlainLanguageConfig,
  adapters: LanguageAdapter[] = getAdapters()
): PlainLanguageResult {
  const hasTerms = Boolean(config?.forbiddenTerms && config.forbiddenTerms.length > 0);
  const disallowEmDashes = Boolean(config?.disallowEmDashes);
  const disallowEmojis = Boolean(config?.disallowEmojis);

  if (config?.enabled === false || (!hasTerms && !disallowEmDashes && !disallowEmojis)) {
    return { hasViolations: false, violations: [], summary: 'PASS: Plain language check disabled or not configured' };
  }

  const targetDirs = config?.targetDirs || ['src'];
  const termPatterns = (config?.forbiddenTerms || []).map((t) => ({
    term: t.toLowerCase(),
    regex: new RegExp(`\\b${t.toLowerCase()}\\b`, 'i'),
  }));
  const violations: JargonViolation[] = [];

  /**
   * Checks one piece of user-facing text and records every rule it breaks.
   * Prose lines report style rules before terms; string literals the reverse
   * (the historical output order, kept stable for CI log diffs).
   */
  function inspect(file: string, line: number, text: string, styleFirst: boolean) {
    const record = (term: string) =>
      violations.push({ file: path.relative(projectRoot, file), term, snippet: truncate(text.trim()), line });
    const checkTerms = () => {
      for (const { term, regex } of termPatterns) {
        if (regex.test(text)) record(term);
      }
    };
    const checkStyle = () => {
      if (disallowEmDashes && text.includes('—')) record('em-dash (—)');
      if (disallowEmojis && /\p{Extended_Pictographic}/u.test(text)) record('emoji/icon');
    };

    if (styleFirst) {
      checkStyle();
      checkTerms();
    } else {
      checkTerms();
      checkStyle();
    }
  }

  for (const relDir of targetDirs) {
    const fullDir = path.resolve(projectRoot, relDir);
    const files = collectSourceFiles(fullDir, {
      include: (name) =>
        PROSE_FILE.test(name) || adapters.some((a) => a.isSourceFile(name) && !a.isTestFile(name)),
      skipDirs: ['__tests__'],
    });

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');

      if (PROSE_FILE.test(file)) {
        content.split('\n').forEach((lineText, idx) => inspect(file, idx + 1, lineText, true));
        continue;
      }

      const adapter = adapterForFile(adapters, file)!;
      for (const literal of adapter.extractStrings(file, content)) {
        inspect(file, literal.line, literal.text, false);
      }
    }
  }

  const hasViolations = violations.length > 0;
  const summary = hasViolations
    ? `FAIL: Found ${violations.length} user-facing jargon / style violation(s)`
    : `PASS: 0 user-facing jargon violations found across target surfaces`;

  return { hasViolations, violations, summary };
}
