import * as fs from 'node:fs';
import * as path from 'node:path';

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
}

export interface SecretScanConfig {
  enabled?: boolean;
  patterns?: string[];
  excludePatterns?: string[];
  entropyThreshold?: number;
}

export interface FactoryConfig {
  $schema?: string;
  project?: {
    name: string;
    architecture: string;
  };
  guards?: {
    noCycles?: NoCyclesConfig;
    boundaries?: BoundaryRule[];
    plainLanguage?: PlainLanguageConfig;
    secrets?: SecretScanConfig;
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
          return JSON.parse(content) as FactoryConfig;
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
    },
  };
}
