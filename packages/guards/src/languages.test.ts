import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { checkNoCycles } from './no-cycles.js';
import { checkBoundaries } from './boundary-guard.js';
import { checkCommentedCode } from './commented-code.js';
import { checkTodoIssueLinks } from './todo-issue-links.js';
import { checkPlainLanguage } from './plain-language.js';
import { checkDeadExports } from './dead-exports.js';
import { getAdapters, pythonAdapter } from './languages/index.js';
import { loadFactoryConfig } from './config.js';
import { initFactoryConfig } from './init.js';

function write(root: string, rel: string, content: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('Language-agnostic guards', () => {
  const tmpDir = path.join(os.tmpdir(), `guard-lang-test-${Date.now()}`);

  beforeAll(() => fs.mkdirSync(tmpDir, { recursive: true }));
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  describe('Python adapter', () => {
    const py = () => path.join(tmpDir, 'py');

    beforeAll(() => {
      write(py(), 'app/domain/order.py', 'from .pricing import price\nimport app.infra.db\n');
      write(py(), 'app/domain/pricing.py', 'from . import order\n');
      write(py(), 'app/domain/__init__.py', '');
      write(py(), 'app/infra/db.py', 'URL = "postgres://"\n');
      write(py(), 'app/infra/__init__.py', '');
      write(py(), 'app/__init__.py', '');
    });

    it('detects a relative-import cycle', () => {
      const result = checkNoCycles(py(), { rootDir: 'app' });
      expect(result.hasCycles).toBe(true);
      const names = result.cycles[0]!.map((f) => path.basename(f));
      expect(names).toContain('order.py');
      expect(names).toContain('pricing.py');
    });

    it('detects an absolute import crossing a boundary', () => {
      const result = checkBoundaries(py(), [{ package: 'app/domain', disallowImportsFrom: ['app/infra'] }]);
      expect(result.hasViolations).toBe(true);
      expect(result.violations[0]).toMatchObject({ imported: 'app.infra.db', line: 2 });
    });

    it('detects a relative import crossing a boundary', () => {
      write(py(), 'app/domain/leak.py', 'from ..infra.db import URL\n');
      const result = checkBoundaries(py(), [{ package: 'app/domain', disallowImportsFrom: ['app/infra'] }]);
      expect(result.violations.map((v) => v.imported)).toContain('..infra.db');
    });

    it('flags commented-out code and unlinked TODOs, but not prose or strings', () => {
      const dir = path.join(tmpDir, 'py-comments');
      write(dir, 'svc.py', [
        '#!/usr/bin/env python3',
        '# Retry the request when the server is busy.',
        '# for example: a 503 response',
        '# result = fetch_data(url)',
        '# def old_handler(event):',
        'x = "# not a comment"  # noqa: E501',
        '# TODO: handle timeouts',
        '# TODO(#42): linked follow-up',
        'msg = """',
        '# also inside a string',
        '"""',
      ].join('\n'));

      const code = checkCommentedCode(dir);
      expect(code.violations.map((v) => v.snippet)).toEqual(['result = fetch_data(url)', 'def old_handler(event):']);
      expect(code.violations[0]!.line).toBe(4);

      const todos = checkTodoIssueLinks(dir);
      expect(todos.violations).toHaveLength(1);
      expect(todos.violations[0]).toMatchObject({ line: 7, text: '# TODO: handle timeouts' });
    });

    it('scans Python string literals for plain-language rules', () => {
      const dir = path.join(tmpDir, 'py-copy');
      write(dir, 'src/ui.py', "label = 'Database deadlock detected'\n# deadlock in a comment is fine\n");
      const result = checkPlainLanguage(dir, { forbiddenTerms: ['deadlock'] });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]!.line).toBe(1);
    });

    it('reports Python files as skipped by dead-exports instead of passing silently', () => {
      const result = checkDeadExports(py(), { rootDir: 'app' });
      expect(result.hasViolations).toBe(false);
      expect(result.notes[0]).toMatch(/not available for python/);
    });

    it('converts dotted specifiers into paths', () => {
      expect(pythonAdapter.toPathLike('app.infra.db')).toBe('app/infra/db');
      expect(pythonAdapter.toPathLike('.pricing')).toBe('./pricing');
      expect(pythonAdapter.toPathLike('..infra.db')).toBe('../infra/db');
      expect(pythonAdapter.toPathLike('..')).toBe('..');
    });
  });

  describe('Mixed-language projects', () => {
    it('routes each file to its adapter by extension', () => {
      const dir = path.join(tmpDir, 'mixed');
      write(dir, 'src/a.ts', "import { b } from './b.js';\nexport const a = b;\n");
      write(dir, 'src/b.ts', "import { a } from './a.js';\nexport const b = a;\n");
      write(dir, 'src/x.py', 'from . import y\n');
      write(dir, 'src/y.py', 'from . import x\n');

      const both = checkNoCycles(dir, { rootDir: 'src' });
      expect(both.cycles).toHaveLength(2);

      const pythonOnly = checkNoCycles(dir, { rootDir: 'src' }, getAdapters(['python']));
      expect(pythonOnly.cycles).toHaveLength(1);
      expect(pythonOnly.cycles[0]!.every((f) => f.endsWith('.py'))).toBe(true);
    });

    it('rejects unknown languages with the supported list', () => {
      expect(() => getAdapters(['cobol'])).toThrow(/Supported: typescript, python/);
    });
  });

  describe('Presets and extends', () => {
    it('merges presets under the project config, with the project winning', () => {
      const dir = path.join(tmpDir, 'extends');
      write(dir, 'shared/base.json', JSON.stringify({ guards: { secrets: { patterns: ['org_key_'] } } }));
      write(dir, '.factoryrc.json', JSON.stringify({
        extends: ['agentic-factory/plain-ux', './shared/base.json'],
        guards: { plainLanguage: { targetDirs: ['ui'], forbiddenTerms: ['widget'] } },
      }));

      const config = loadFactoryConfig(dir);
      expect(config.extends).toBeUndefined();
      expect(config.guards?.plainLanguage).toEqual({
        enabled: true,
        targetDirs: ['ui'],
        forbiddenTerms: ['widget'], // arrays replace, never concatenate
        disallowEmDashes: true,
        disallowEmojis: true,
      });
      expect(config.guards?.secrets?.patterns).toEqual(['org_key_']);
    });

    it('fails loudly on unknown presets and circular extends', () => {
      const unknown = path.join(tmpDir, 'bad-preset');
      write(unknown, '.factoryrc.json', JSON.stringify({ extends: 'agentic-factory/nope' }));
      expect(() => loadFactoryConfig(unknown)).toThrow(/Unknown preset/);

      const loop = path.join(tmpDir, 'loop');
      write(loop, '.factoryrc.json', JSON.stringify({ extends: './a.json' }));
      write(loop, 'a.json', JSON.stringify({ extends: './b.json' }));
      write(loop, 'b.json', JSON.stringify({ extends: './a.json' }));
      expect(() => loadFactoryConfig(loop)).toThrow(/Circular extends/);
    });

    it('init is style-neutral by default and opt-in for plain-ux', () => {
      const neutral = path.join(tmpDir, 'init-neutral');
      write(neutral, 'pyproject.toml', '[project]\nname = "svc"\n');
      const res = initFactoryConfig(neutral);
      expect(res.config.extends).toEqual(['agentic-factory/recommended']);
      expect(res.config.project?.languages).toEqual(['python']);
      expect(res.config.guards?.plainLanguage).toBeUndefined();
      expect(JSON.stringify(res.config)).not.toMatch(/disallowEm|deadlock/);

      const styled = path.join(tmpDir, 'init-styled');
      write(styled, 'package.json', '{"name":"web"}');
      const res2 = initFactoryConfig(styled, { presets: ['plain-ux'] });
      expect(res2.config.extends).toEqual(['agentic-factory/recommended', 'agentic-factory/plain-ux']);
      expect(loadFactoryConfig(styled).guards?.plainLanguage?.disallowEmDashes).toBe(true);
    });
  });
});
