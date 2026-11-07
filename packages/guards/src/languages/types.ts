/**
 * A language adapter turns source text into the language-neutral facts the
 * guards reason about (imports, comments, string literals, exports).
 * Guards never parse source themselves; they only consume these facts.
 */

export interface ImportRef {
  /** Module specifier exactly as written (e.g. './foo.js', '..models.user'). */
  spec: string;
  /** 1-based line of the import statement. */
  line: number;
  /** True for runtime imports such as `import('x')`. */
  dynamic: boolean;
}

export interface CommentRef {
  /** 1-based line where the comment starts. */
  line: number;
  /** 1-based column where the comment starts. */
  col: number;
  /** Comment text including its delimiters. */
  raw: string;
  /** Comment body split per source line, with delimiters stripped. */
  bodyLines: string[];
  /** Documentation comments (JSDoc and similar). */
  isDoc: boolean;
}

export interface StringRef {
  /** 1-based line where the literal starts. */
  line: number;
  /** Literal value without quotes. */
  text: string;
}

export interface ExportFacts {
  /** Symbols this file declares as exported. */
  exports: { symbol: string; line: number; col: number }[];
  /** Symbols this file consumes from other files (resolved absolute path). */
  used: { target: string; symbol: string }[];
  /** Files whose every export this file consumes or re-exports. */
  wildcardTargets: string[];
}

export interface LanguageAdapter {
  /** Stable id used in `.factoryrc.json` `project.languages`. */
  id: string;
  /** Returns true for source files this adapter understands. */
  isSourceFile(fileName: string): boolean;
  /** Returns true for test files (skipped by copy and comment guards). */
  isTestFile(fileName: string): boolean;
  /** Returns true for files whose exports are public API (never dead). */
  isEntryPoint(fileName: string): boolean;

  extractImports(file: string, content: string): ImportRef[];
  /**
   * Resolves a specifier to an absolute file path inside the project,
   * or null for external packages and unresolvable specifiers.
   */
  resolveImport(fromFile: string, spec: string, roots: string[]): string | null;
  /** Converts a specifier into a slash-separated path for boundary matching. */
  toPathLike(spec: string): string;

  extractComments(file: string, content: string): CommentRef[];
  /** Heuristic: does this comment line look like disabled source code? */
  looksLikeCode(commentLine: string): boolean;
  extractStrings(file: string, content: string): StringRef[];

  /** Optional: languages without it are skipped by the dead-exports guard. */
  analyzeExports?(
    file: string,
    content: string,
    isEntry: boolean,
    resolve: (spec: string) => string | null
  ): ExportFacts;
}
