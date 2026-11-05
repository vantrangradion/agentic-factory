import * as fs from 'node:fs';
import * as path from 'node:path';
import { FactoryConfig, BoundaryRule } from './config.js';

export interface InitOptions {
  force?: boolean;
  projectName?: string;
  architecture?: string;
}

export interface InitResult {
  created: boolean;
  path: string;
  config: FactoryConfig;
  message: string;
}

export function initFactoryConfig(
  projectRoot: string = process.cwd(),
  options: InitOptions = {}
): InitResult {
  const targetPath = path.join(projectRoot, '.factoryrc.json');

  if (fs.existsSync(targetPath) && !options.force) {
    const existing = JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as FactoryConfig;
    return {
      created: false,
      path: targetPath,
      config: existing,
      message: `Configuration already exists at ${targetPath}. Use --force to overwrite.`,
    };
  }

  // 1. Detect project name
  let projectName = options.projectName;
  const pkgJsonPath = path.join(projectRoot, 'package.json');
  let pkgWorkspaces: string[] | undefined;

  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      if (!projectName && pkg.name) {
        projectName = pkg.name;
      }
      if (pkg.workspaces) {
        pkgWorkspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages;
      }
    } catch {
      // Ignore json parse error
    }
  }

  if (!projectName) {
    projectName = path.basename(path.resolve(projectRoot));
  }

  // 2. Detect workspace topology
  const hasPnpmWorkspace = fs.existsSync(path.join(projectRoot, 'pnpm-workspace.yaml'));
  const hasLerna = fs.existsSync(path.join(projectRoot, 'lerna.json'));
  const isMonorepo = hasPnpmWorkspace || hasLerna || !!pkgWorkspaces;

  const architecture = options.architecture || (isMonorepo ? 'modular-monorepo' : 'single-package');

  // 3. Detect boundaries if packages directory exists
  const boundaries: BoundaryRule[] = [];
  const packagesDir = path.join(projectRoot, 'packages');

  if (fs.existsSync(packagesDir) && fs.statSync(packagesDir).isDirectory()) {
    const pkgs = fs.readdirSync(packagesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `packages/${e.name}`);

    // If there is a types or common package, guard it from importing feature packages
    const typesPkg = pkgs.find((p) => p.endsWith('/types') || p.endsWith('/common'));
    if (typesPkg) {
      const otherPkgs = pkgs.filter((p) => p !== typesPkg);
      if (otherPkgs.length > 0) {
        boundaries.push({
          package: typesPkg,
          disallowImportsFrom: otherPkgs,
        });
      }
    }
  }

  const targetDirs = isMonorepo && fs.existsSync(packagesDir)
    ? ['packages', 'src']
    : ['src'];

  const config: FactoryConfig = {
    $schema: 'https://agentic-factory.dev/schema.json',
    project: {
      name: projectName,
      architecture,
    },
    guards: {
      noCycles: {
        enabled: true,
        rootDir: isMonorepo ? 'packages' : 'src',
      },
      boundaries,
      plainLanguage: {
        enabled: true,
        targetDirs,
        forbiddenTerms: ['internal_id', 'mutex_lock', 'deadlock', 'ast_node', 'llm_hallucination'],
        disallowEmDashes: true,
        disallowEmojis: true,
      },
      secrets: {
        enabled: true,
      },
      todoIssueLinks: {
        enabled: true,
      },
      commentedCode: {
        enabled: true,
      },
      deadExports: {
        enabled: true,
        rootDir: isMonorepo ? 'packages' : 'src',
      },
    },
    testing: {
      targetCoverage: 85,
      maxSuiteDurationMs: 2000,
      requireSyntheticScenarios: true,
    },
  };

  fs.writeFileSync(targetPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  return {
    created: true,
    path: targetPath,
    config,
    message: `Created ${targetPath} (${architecture} preset)`,
  };
}
