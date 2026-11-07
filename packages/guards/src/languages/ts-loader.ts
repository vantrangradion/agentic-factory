import * as path from 'node:path';
import { createRequire } from 'node:module';
import type * as TS from 'typescript';

let cached: typeof TS | undefined;

/**
 * Loads the TypeScript compiler on first use. It is an optional peer
 * dependency: projects without .ts/.js files never need it installed.
 * Resolution tries this package first, then the project being checked.
 */
export function loadTypeScript(): typeof TS {
  if (cached) return cached;

  const requireFns = [
    typeof require === 'function' ? require : createRequire(__filename),
    createRequire(path.join(process.cwd(), 'package.json')),
  ];

  for (const req of requireFns) {
    try {
      cached = req('typescript') as typeof TS;
      return cached;
    } catch {
      // Try the next resolution root.
    }
  }

  throw new Error(
    "agentic-guards needs the 'typescript' package to check .ts/.js files. " +
      'Install it in your project (npm install -D typescript), or set ' +
      'project.languages in .factoryrc.json to skip TypeScript.'
  );
}
