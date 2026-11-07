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

/** One step of the agent loop's gate ladder, run in order, cheapest first. */
export interface AgentGate {
  name: string;
  /** Shell command run from the project root. */
  run: string;
  timeoutMs?: number;
}

export interface AgentBudgetConfig {
  /** Weekly spend cap in USD. Omit for no cap. */
  weeklyUsd?: number;
  /** Fraction of the cap after which only issues with a bug label run. Default 0.8. */
  bugOnlyAt?: number;
  /** Fraction of the cap after which the loop stops until the next week. Default 1.0. */
  stopAt?: number;
  bugLabels?: string[];
  /** Offset used to find the start of the week (Monday 00:00), e.g. "+07:00". Default "+00:00". */
  utcOffset?: string;
  /**
   * USD per million tokens: one price for every model, or a map from model id
   * to price. Without it, cost is reported as unknown and the cap cannot apply.
   */
  pricing?: ModelPricing | Record<string, ModelPricing>;
}

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
}

/** Sends issues with any of `labels` to `model`. Routes are checked in order; the first match wins. */
export interface AgentRoute {
  labels: string[];
  model: string;
}

export interface AgentConfig {
  /** Agent backend. Only "antigravity-cli" (`agy`) is implemented; the field leaves room for other vendors. */
  runner?: 'antigravity-cli';
  /** Default model for every issue that no route matches. Required. */
  model?: string;
  /** Fixed label-based routing to other models of the same vendor. Never chosen by the agent. */
  routes?: AgentRoute[];
  labels?: {
    ready?: string;
    working?: string;
    prOpen?: string;
    needsHuman?: string;
    planReview?: string;
    planApproved?: string;
  };
  plan?: {
    /**
     * "required" (default): after the red phase the run stops with a draft PR
     * holding the plan and the failing tests; nothing is implemented until a
     * person adds the plan-approved label. "none": red and green run in one go.
     */
    approval?: 'required' | 'none';
  };
  /** Independent review of finished work by a separate agent session. Advisory: it never blocks a merge. */
  review?: {
    /** "labelled" (default): only issues with one of `labels`. */
    when?: 'never' | 'labelled' | 'always';
    labels?: string[];
    /** Model for the reviewer. Default: the issue's model. */
    model?: string;
    /** Fix rounds the coding agent gets for review findings. 0 or 1; default 1. */
    maxFixRounds?: number;
  };
  /** Files the agent must read before it changes anything. Missing files are skipped with a warning. */
  context?: string[];
  gates?: AgentGate[];
  tdd?: {
    /** Run a tests-only red phase before the implementation. Default true. */
    enabled?: boolean;
    /** Gate that must fail after the red phase. Default "test". */
    redGate?: string;
    /** Globs that identify test files. */
    testFiles?: string[];
  };
  /** Globs the agent may never change. The loop reverts any change to them. */
  protectedPaths?: string[];
  /** Attempts per phase before the issue goes to a human. Default 3. */
  maxAttempts?: number;
  /** Wall-clock limit for one agent session. Default 30 minutes. */
  sessionTimeoutMs?: number;
  branchPrefix?: string;
  /** Command that installs dependencies in a fresh clone before a local run, e.g. "pnpm install --frozen-lockfile". */
  setup?: string;
  /** Orphan branch holding one JSON record per run. Default "factory-ledger". */
  ledgerBranch?: string;
  budget?: AgentBudgetConfig;
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
  /** Settings for the autonomous agent loop (`@agentic-factory/loop`). */
  agent?: AgentConfig;
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
