import * as fs from 'node:fs';
import * as path from 'node:path';
import { CommentRef, ImportRef, LanguageAdapter, StringRef } from './types.js';

/**
 * Dependency-free Python adapter. A small tokenizer separates code, comments
 * and string literals so that `#` or `import` inside strings is never
 * mistaken for a comment or an import.
 */

interface Tokens {
  comments: { line: number; col: number; raw: string }[];
  strings: (StringRef & { triple: boolean })[];
  /** Source lines with string contents blanked and comments removed. */
  codeLines: string[];
}

function tokenize(content: string): Tokens {
  const comments: Tokens['comments'] = [];
  const strings: Tokens['strings'] = [];
  let code = '';

  let i = 0;
  let line = 1;
  let lineStart = 0;

  while (i < content.length) {
    const ch = content[i]!;

    if (ch === '#') {
      const end = content.indexOf('\n', i);
      const stop = end === -1 ? content.length : end;
      comments.push({ line, col: i - lineStart + 1, raw: content.slice(i, stop) });
      i = stop;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const triple = content.startsWith(ch.repeat(3), i);
      const quote = triple ? ch.repeat(3) : ch;
      const startLine = line;
      let j = i + quote.length;
      let text = '';
      while (j < content.length) {
        if (content[j] === '\\') {
          text += content.slice(j, j + 2);
          if (content[j + 1] === '\n') {
            line++;
            lineStart = j + 2;
          }
          j += 2;
          continue;
        }
        if (content.startsWith(quote, j)) break;
        if (content[j] === '\n') {
          if (!triple) break; // Unterminated single-line string
          line++;
          lineStart = j + 1;
        }
        text += content[j];
        j++;
      }
      strings.push({ line: startLine, text, triple });
      // Keep line structure intact in the code view.
      code += quote + text.replace(/[^\n]/g, ' ') + quote;
      i = Math.min(j + quote.length, content.length);
      continue;
    }

    if (ch === '\n') {
      line++;
      lineStart = i + 1;
    }
    code += ch;
    i++;
  }

  return { comments, strings, codeLines: code.split('\n') };
}

function stripAlias(name: string): string {
  return name.trim().split(/\s+as\s+/)[0]!.trim();
}

const CODE_LINE_PATTERNS = [
  /^(?:async\s+)?def\s+\w+\s*\(/,
  /^class\s+\w+\s*[(:]/,
  /^import\s+[\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*$/,
  /^from\s+\.*[\w.]*\s+import\s+/,
  /^return\s+[\w.]+\(.*\)$/,
  /^(?:if|elif|while)\s+.+:$/,
  /^for\s+\w+(?:\s*,\s*\w+)*\s+in\s+.+:$/,
  /^(?:try|else|finally):$/,
  /^(?:except|with)\b.*:$/,
  /^raise\s+\w+(?:\(|$)/,
  /^await\s+[\w.]+\(/,
  /^(?:print|\w+(?:\.\w+)+)\(.*\)$/,
  /^[a-z_][\w.]*(?:\[[^\]]*\])?\s*[+\-*/]?=\s*(?:[\w.]+\(.*\)|['"].*['"]|-?\d+(?:\.\d+)?|True|False|None|\[.*\]|\{.*\})$/i,
];

const DIRECTIVE_PREFIXES = ['!', 'noqa', 'type:', 'pylint:', 'pragma', 'fmt:', 'isort:', '-*-', 'http://', 'https://'];

export const pythonAdapter: LanguageAdapter = {
  id: 'python',

  isSourceFile: (name) => /\.pyi?$/.test(name),
  isTestFile: (name) => /^test_.*\.py$/.test(name) || /_test\.py$/.test(name) || name === 'conftest.py',
  isEntryPoint: (name) => /^(__init__|__main__|main|cli)\.py$/.test(path.basename(name)),

  extractImports(_file, content): ImportRef[] {
    const { codeLines } = tokenize(content);
    const imports: ImportRef[] = [];

    codeLines.forEach((text, idx) => {
      const line = idx + 1;
      const fromMatch = text.match(/^\s*from\s+(\.*[\w.]*)\s+import\s+\(?\s*([^)#]*)/);
      if (fromMatch) {
        const module = fromMatch[1]!;
        if (/^\.+$/.test(module)) {
          // `from . import a, b` imports sibling modules a and b.
          for (const name of fromMatch[2]!.split(',').map(stripAlias).filter(Boolean)) {
            imports.push({ spec: module + name, line, dynamic: false });
          }
        } else {
          imports.push({ spec: module, line, dynamic: false });
        }
        return;
      }
      const importMatch = text.match(/^\s*import\s+([\w.,\s]+(?:\s+as\s+\w+)?)/);
      if (importMatch) {
        for (const name of importMatch[1]!.split(',').map(stripAlias).filter(Boolean)) {
          imports.push({ spec: name, line, dynamic: false });
        }
      }
    });
    return imports;
  },

  resolveImport(fromFile, spec, roots) {
    const pathLike = pythonAdapter.toPathLike(spec);
    const bases = pathLike.startsWith('.')
      ? [path.resolve(path.dirname(fromFile), pathLike)]
      : roots.map((root) => path.join(root, pathLike));

    for (const base of bases) {
      for (const candidate of [`${base}.py`, `${base}.pyi`, path.join(base, '__init__.py')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      }
    }
    return null;
  },

  toPathLike(spec) {
    const [, dots = '', rest = ''] = spec.match(/^(\.*)(.*)$/) ?? [];
    const body = rest.replace(/\./g, '/');
    if (dots.length === 0) return body;
    const prefix = dots.length === 1 ? './' : '../'.repeat(dots.length - 1);
    return body ? prefix + body : prefix.replace(/\/$/, '');
  },

  extractComments(_file, content): CommentRef[] {
    return tokenize(content).comments.map((c) => ({
      line: c.line,
      col: c.col,
      raw: c.raw,
      bodyLines: [c.raw.replace(/^#/, '')],
      isDoc: false,
    }));
  },

  looksLikeCode(text) {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (DIRECTIVE_PREFIXES.some((p) => trimmed.startsWith(p))) return false;
    return CODE_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
  },

  extractStrings(_file, content): StringRef[] {
    return tokenize(content).strings.map(({ line, text }) => ({ line, text }));
  },
};
