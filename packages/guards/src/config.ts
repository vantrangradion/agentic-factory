import * as fs from 'node:fs';
import * as path from 'node:path';
import { BUILTIN_PRESETS, deepMerge, PRESET_NAMES } from './presets.js';

export interface NoCyclesConfig {
  enabled?: boolean;
  rootDir?: string;
  exclude?: string[];
}

export interface BoundaryRule {
  package: string;
  disallowImportsFrom: string[];
}

export interface PlainLanguageConfig {
  enabled?: boolean;
  targetDirs?: string[];
  forbiddenTerms?: string[];
  customMessage?: string;
  disallowEmDashes?: boolean;
  disallowEmojis?: boolean;
}

export interface SecretScanConfig {
  enabled?: boolean;
  patterns?: string[];
  excludePatterns?: string[];
  entropyThreshold?: number;
}

export interface TodoIssueConfig {
  enabled?: boolean;
  targetDirs?: string[];
  exclude?: string[];
  issuePattern?: string;
}

export interface CommentedCodeConfig {
  enabled?: boolean;
  targetDirs?: string[];
  exclude?: string[];
}

export interface DeadExportsConfig {
  enabled?: boolean;
  rootDir?: string;
  entryPoints?: string[];
  exclude?: string[];
}

export interface FactoryConfig {
  $schema?: string;
  /** Built-in preset names (e.g. 'agentic-factory/recommended') or relative paths to shared JSON configs. */
  extends?: string | string[];
  project?: {
    name?: string;
    architecture?: string;
    /** Restrict guards to these language adapters. Omit to route every file by extension. */
    languages?: string[];
  };
  guards?: {
    noCycles?: NoCyclesConfig;
    boundaries?: BoundaryRule[];
    plainLanguage?: PlainLanguageConfig;
    secrets?: SecretScanConfig;
    todoIssueLinks?: TodoIssueConfig;
    commentedCode?: CommentedCodeConfig;
    deadExports?: DeadExportsConfig;
  };
  testing?: {
    targetCoverage?: number;
    maxSuiteDurationMs?: number;
    requireSyntheticScenarios?: boolean;
  };
}

export function loadFactoryConfig(startDir: string = process.cwd()): FactoryConfig {
  let curr = startDir;
  while (true) {
    const candidates = [
      path.join(curr, '.factoryrc.json'),
      path.join(curr, '.factoryrc'),
      path.join(curr, 'factory.config.json'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          const content = fs.readFileSync(candidate, 'utf-8');
          return resolveExtends(JSON.parse(content) as FactoryConfig, path.dirname(candidate), [candidate]);
        } catch (err) {
          throw new Error(`Failed to parse factory config at ${candidate}: ${(err as Error).message}`);
        }
      }
    }
    const parent = path.dirname(curr);
    if (parent === curr) {
      break;
    }
    curr = parent;
  }

  // Default fallback configuration
  return {
    project: {
      name: 'unnamed-project',
      architecture: 'modular-monorepo',
    },
    guards: {
      noCycles: { enabled: true, rootDir: 'src' },
      boundaries: [],
      plainLanguage: { enabled: true, targetDirs: ['src'], forbiddenTerms: [] },
      secrets: { enabled: true },
      todoIssueLinks: { enabled: true },
      commentedCode: { enabled: true },
      deadExports: { enabled: true },
    },
  };
}


/**
 * Applies `extends` entries in order, then the config itself on top, so the
 * project's own settings always win. Arrays replace rather than concatenate.
 */
export function resolveExtends(config: FactoryConfig, baseDir: string, seen: string[] = []): FactoryConfig {
  const parents = config.extends === undefined ? [] : [config.extends].flat();
  let merged: FactoryConfig = {};

  for (const ref of parents) {
    let parent: FactoryConfig;
    if (BUILTIN_PRESETS[ref]) {
      parent = BUILTIN_PRESETS[ref] as FactoryConfig;
    } else if (ref.startsWith('.') || path.isAbsolute(ref)) {
      const file = path.resolve(baseDir, ref);
      if (seen.includes(file)) {
        throw new Error(`Circular extends: ${[...seen, file].join(' -> ')}`);
      }
      if (!fs.existsSync(file)) {
        throw new Error(`extends target not found: ${ref}`);
      }
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as FactoryConfig;
      parent = resolveExtends(raw, path.dirname(file), [...seen, file]);
    } else {
      throw new Error(`Unknown preset '${ref}'. Built-in presets: ${PRESET_NAMES.join(', ')}`);
    }
    merged = deepMerge(merged, parent);
  }

  const { extends: _ignored, ...own } = config;
  return deepMerge(merged, own);
}
