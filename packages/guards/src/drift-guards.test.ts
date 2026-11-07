import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { checkTodoIssueLinks } from './todo-issue-links.js';
import { checkCommentedCode } from './commented-code.js';
import { checkDeadExports } from './dead-exports.js';
import { checkPlainLanguage } from './plain-language.js';
import { formatGitHubAnnotation } from './github-annotations.js';

describe('AI Drift AST Guards', () => {
  const tmpDir = path.join(os.tmpdir(), `guard-drift-test-${Date.now()}`);

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('TODO Issue Link Enforcement', () => {
    it('flags TODO comments without issue tracker links', () => {
      const testFile = path.join(tmpDir, 'bad-todo.ts');
      fs.writeFileSync(testFile, `
        // TODO: implement this later
        const x = 1;
        /* FIXME refactor this function */
        function test() {}
      `);

      const result = checkTodoIssueLinks(tmpDir);
      expect(result.hasViolations).toBe(true);
      expect(result.violations.length).toBe(2);
      expect(result.violations[0]?.text).toContain('TODO: implement this later');
      expect(result.violations[1]?.text).toContain('FIXME refactor this function');
    });

    it('passes TODO comments that contain issue tracker links', () => {
      const testFile = path.join(tmpDir, 'good-todo.ts');
      fs.writeFileSync(testFile, `
        // TODO(#123): implement this with issue ref
        const a = 1;
        // TODO(https://github.com/org/repo/issues/456): link to github issue
        const b = 2;
        // TODO [PROJ-789]: linear or jira issue format
        const c = 3;
        /* FIXME(#999): issue tracker link in block comment */
        function clean() {}
      `);

      const result = checkTodoIssueLinks(tmpDir, {
        exclude: ['bad-todo.ts'],
      });
      expect(result.hasViolations).toBe(false);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe('Commented-Out Code Detector', () => {
    it('detects commented out statements and declarations', () => {
      const testFile = path.join(tmpDir, 'commented-code.ts');
      fs.writeFileSync(testFile, `
        // const oldCounter = 42;
        // function oldHandler() { return true; }
        // import { dead } from './dead.js';
        const active = true;
      `);

      const result = checkCommentedCode(tmpDir, {
        exclude: ['bad-todo.ts', 'good-todo.ts'],
      });
      expect(result.hasViolations).toBe(true);
      expect(result.violations.length).toBeGreaterThanOrEqual(3);
    });

    it('permits standard explanatory prose and JSDoc comments', () => {
      const testFile = path.join(tmpDir, 'clean-comments.ts');
      fs.writeFileSync(testFile, `
        /**
         * Computes the factorial of n.
         * @param n The input number
         */
        export function factorial(n: number): number {
          // This is a normal explanatory comment describing the base case
          if (n <= 1) return 1;
          // Return recursively for higher values
          return n * factorial(n - 1);
        }
      `);

      const result = checkCommentedCode(tmpDir, {
        exclude: ['bad-todo.ts', 'good-todo.ts', 'commented-code.ts'],
      });
      expect(result.hasViolations).toBe(false);
      expect(result.violations).toHaveLength(0);
    });
  });

  describe('Dead Export Scanner', () => {
    it('detects unused exported symbols across files', () => {
      const subDir = path.join(tmpDir, 'dead-export-pkg');
      fs.mkdirSync(subDir, { recursive: true });

      // helper.ts exports usedFn and unusedFn
      fs.writeFileSync(path.join(subDir, 'helper.ts'), `
        export function usedFn(): string { return 'used'; }
        export function unusedFn(): string { return 'unused'; }
        export const UNUSED_CONST = 123;
      `);

      // app.ts imports usedFn but not unusedFn or UNUSED_CONST
      fs.writeFileSync(path.join(subDir, 'app.ts'), `
        import { usedFn } from './helper.js';
        console.log(usedFn());
      `);

      const result = checkDeadExports(subDir, {
        entryPoints: ['app.ts'],
      });

      expect(result.hasViolations).toBe(true);
      const symbolNames = result.violations.map((v) => v.symbol);
      expect(symbolNames).toContain('unusedFn');
      expect(symbolNames).toContain('UNUSED_CONST');
      expect(symbolNames).not.toContain('usedFn');
    });
  });

  describe('GitHub Actions Annotations', () => {
    it('formats error annotations in standard GitHub Actions workflow command format', () => {
      const annotation = formatGitHubAnnotation('error', {
        file: 'src/main.ts',
        line: 10,
        col: 5,
        message: 'Unresolved TODO without issue tracker link',
      });

      expect(annotation).toBe('::error file=src/main.ts,line=10,col=5::Unresolved TODO without issue tracker link');
    });

    it('formats warning annotations with fallback columns', () => {
      const annotation = formatGitHubAnnotation('warning', {
        file: 'packages/core/src/index.ts',
        line: 42,
        message: 'Deprecation warning',
      });

      expect(annotation).toBe('::warning file=packages/core/src/index.ts,line=42,col=1::Deprecation warning');
    });
  });

  describe('Plain Language Anti-AI-Drift (Em Dashes and Emojis)', () => {
    it('flags em dashes when disallowEmDashes is true', () => {
      const styleDir = path.join(tmpDir, 'style-test');
      fs.mkdirSync(styleDir, { recursive: true });
      fs.writeFileSync(path.join(styleDir, 'component.ts'), 'export const text = "Welcome \u2014 sign in";');

      const result = checkPlainLanguage(tmpDir, {
        targetDirs: ['style-test'],
        disallowEmDashes: true,
      });

      expect(result.hasViolations).toBe(true);
      expect(result.violations[0]?.term).toContain('em-dash');
    });

    it('flags emojis when disallowEmojis is true', () => {
      const styleDir = path.join(tmpDir, 'style-test');
      fs.writeFileSync(path.join(styleDir, 'component.ts'), 'export const welcome = "Hello world! \u{1F680}";');

      const result = checkPlainLanguage(tmpDir, {
        targetDirs: ['style-test'],
        disallowEmojis: true,
      });

      expect(result.hasViolations).toBe(true);
      expect(result.violations[0]?.term).toContain('emoji');
    });
  });
});
