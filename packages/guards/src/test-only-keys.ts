import * as fs from 'node:fs';
import * as path from 'node:path';
import { TestOnlyKeysConfig } from './config.js';
import { collectSourceFiles } from './fs-walk.js';
import { adapterForFile, getAdapters, LanguageAdapter } from './languages/index.js';

export interface TestOnlyKeyViolation {
  file: string;
  key: string;
  line: number;
  col: number;
}

export interface TestOnlyKeysResult {
  hasViolations: boolean;
  violations: TestOnlyKeyViolation[];
  summary: string;
  /** Informational notes, such as languages this guard could not analyze. */
  notes: string[];
}

const DEFAULT_TEST_PATHS = ['/test/', '/tests/', '/__tests__/', '/__mocks__/', '/fixtures/', '/e2e/'];
const DATA_FILE = /\.(json|ya?ml)$/;
const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

/** Every key in a JSON or YAML file. YAML is read line by line: enough to see which keys a config file sets. */
function dataFileKeys(file: string): string[] {
  const text = fs.readFileSync(file, 'utf-8');
  if (file.endsWith('.json')) {
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, child] of Object.entries(v)) {
          keys.push(k);
          walk(child);
        }
      }
    };
    try {
      walk(JSON.parse(text));
    } catch {
      // Not plain JSON (comments, templates): it declares nothing we can trust.
    }
    return keys;
  }
  return [...text.matchAll(/^\s*(?:-\s+)?["']?([A-Za-z_$][\w$-]*)["']?\s*:/gm)].map((m) => m[1]!);
}

/**
 * Flags production code that reads a property only tests ever set.
 *
 * The failure it catches: production decides something from a config key
 * (say `health`) that nothing in the product ever writes; only the tests set
 * it, so every gate passes while the real app never sees that state. A key
 * counts as set by production when
 * any non-test source declares it (object literal, type or class member,
 * enum member, assignment) or any non-test JSON or YAML file contains it.
 */
export function checkTestOnlyKeys(
  projectRoot: string,
  config?: TestOnlyKeysConfig,
  adapters: LanguageAdapter[] = getAdapters()
): TestOnlyKeysResult {
  if (!config || config.enabled === false) {
    return { hasViolations: false, violations: [], summary: 'PASS: Test-only key scanner disabled', notes: [] };
  }

  const rootDir = path.resolve(projectRoot, config.rootDir || '.');
  const exclude = config.exclude || ['node_modules', 'dist'];
  const testPaths = config.testPaths || DEFAULT_TEST_PATHS;
  const ignore = new Set(config.ignoreKeys || []);
  const isTest = (file: string, adapter?: LanguageAdapter): boolean => {
    const posix = `/${path.relative(rootDir, file).split(path.sep).join('/')}`;
    return (adapter?.isTestFile(path.basename(file)) ?? false) || testPaths.some((p) => posix.includes(p));
  };

  const files = collectSourceFiles(rootDir, {
    include: (name) => (DATA_FILE.test(name) && !LOCKFILES.has(name)) || adapters.some((a) => a.isSourceFile(name)),
    exclude,
    skipDirs: ['coverage'],
  });

  const productionKeys = new Set<string>();
  const testKeys = new Set<string>();
  const reads: { file: string; key: string; line: number; col: number }[] = [];
  const unsupported = new Map<string, number>();

  for (const file of files) {
    if (DATA_FILE.test(file)) {
      const target = isTest(file) ? testKeys : productionKeys;
      dataFileKeys(file).forEach((k) => target.add(k));
      continue;
    }
    const adapter = adapterForFile(adapters, file)!;
    if (!adapter.analyzeKeys) {
      unsupported.set(adapter.id, (unsupported.get(adapter.id) ?? 0) + 1);
      continue;
    }
    const facts = adapter.analyzeKeys(file, fs.readFileSync(file, 'utf-8'));
    if (isTest(file, adapter)) {
      facts.keys.forEach((k) => testKeys.add(k));
    } else {
      facts.keys.forEach((k) => productionKeys.add(k));
      facts.reads.forEach((r) => reads.push({ file, ...r }));
    }
  }

  const violations: TestOnlyKeyViolation[] = reads
    .filter((r) => testKeys.has(r.key) && !productionKeys.has(r.key) && !ignore.has(r.key))
    .map((r) => ({ file: path.relative(projectRoot, r.file), key: r.key, line: r.line, col: r.col }));

  const notes = skippedNotes(unsupported);
  const hasViolations = violations.length > 0;
  const summary = hasViolations
    ? `FAIL: Found ${violations.length} read(s) of keys that only tests set`
    : 'PASS: 0 reads of test-only keys';
  return { hasViolations, violations, summary, notes };
}

function skippedNotes(unsupported: Map<string, number>): string[] {
  return [...unsupported.entries()].map(([lang, count]) => `test-only key analysis is not available for ${lang} yet; skipped ${count} file(s)`);
}
