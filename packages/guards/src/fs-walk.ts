import * as fs from 'node:fs';
import * as path from 'node:path';

/** Directories that never contain first-party source, for any language. */
const ALWAYS_SKIPPED_DIRS = [
  'node_modules',
  'dist',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
];

export interface WalkOptions {
  /** Returns true for files the caller wants. */
  include: (fileName: string) => boolean;
  /** Path fragments or entry names to skip. */
  exclude?: string[];
  /** Extra directory names to skip on top of the built-in list. */
  skipDirs?: string[];
}

export function collectSourceFiles(dir: string, options: WalkOptions): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const exclude = options.exclude ?? [];
  const skipDirs = new Set([...ALWAYS_SKIPPED_DIRS, ...(options.skipDirs ?? [])]);

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (exclude.some((ex) => fullPath.includes(ex) || entry.name === ex)) continue;

    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      results.push(...collectSourceFiles(fullPath, options));
    } else if (options.include(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}
