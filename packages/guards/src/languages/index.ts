import * as fs from 'node:fs';
import * as path from 'node:path';
import { LanguageAdapter } from './types.js';
import { typescriptAdapter } from './typescript.js';
import { pythonAdapter } from './python.js';

export * from './types.js';
export { typescriptAdapter } from './typescript.js';
export { pythonAdapter } from './python.js';

const REGISTRY: Record<string, LanguageAdapter> = {
  typescript: typescriptAdapter,
  python: pythonAdapter,
};

export const SUPPORTED_LANGUAGES = Object.keys(REGISTRY);

/**
 * Returns the adapters for the requested languages, or every registered
 * adapter when none are requested. Files are routed by extension, so
 * enabling an adapter for a language the project does not use costs nothing.
 */
export function getAdapters(languages?: string[]): LanguageAdapter[] {
  if (!languages || languages.length === 0) {
    return Object.values(REGISTRY);
  }
  return languages.map((id) => {
    const adapter = REGISTRY[id];
    if (!adapter) {
      throw new Error(
        `Unknown language '${id}' in project.languages. Supported: ${SUPPORTED_LANGUAGES.join(', ')}`
      );
    }
    return adapter;
  });
}

export function adapterForFile(adapters: LanguageAdapter[], file: string): LanguageAdapter | undefined {
  const name = path.basename(file);
  return adapters.find((a) => a.isSourceFile(name));
}

/** Detects project languages from well-known manifest files. */
export function detectLanguages(projectRoot: string): string[] {
  const has = (f: string) => fs.existsSync(path.join(projectRoot, f));
  const detected: string[] = [];
  if (has('package.json') || has('tsconfig.json') || has('jsconfig.json')) {
    detected.push('typescript');
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py') || has('setup.cfg') || has('Pipfile')) {
    detected.push('python');
  }
  return detected;
}
