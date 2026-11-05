import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { Readable, Writable } from 'node:stream';

export type ArchitecturePreset = 'modular-monorepo' | 'single-package' | 'hexagonal' | 'microservice';

export interface ScaffoldOptions {
  projectName: string;
  targetDir: string;
  architecture: ArchitecturePreset;
  forbiddenJargon?: string[];
}

export interface PromptOptionsInput {
  input?: Readable;
  output?: Writable;
  defaultName?: string;
}

export async function promptOptions(options: PromptOptionsInput = {}): Promise<ScaffoldOptions> {
  const rl = readline.createInterface({
    input: options.input || process.stdin,
    output: options.output || process.stdout,
  });

  try {
    const rawName = await rl.question(`Project directory name (${options.defaultName || 'my-agentic-app'}): `);
    const projectName = rawName.trim() || options.defaultName || 'my-agentic-app';
    const targetDir = path.resolve(process.cwd(), projectName);

    const rawArch = await rl.question(
      `Select architecture preset:\n  1) modular-monorepo (default)\n  2) single-package\nChoice (1/2): `
    );
    const archChoice = rawArch.trim();
    let architecture: ArchitecturePreset = 'modular-monorepo';
    if (archChoice === '2' || archChoice.toLowerCase() === 'single-package') {
      architecture = 'single-package';
    }

    const rawJargon = await rl.question(
      `Forbidden plain language terms (comma-separated, or press Enter to skip): `
    );
    const forbiddenJargon = rawJargon.trim()
      ? rawJargon.split(',').map((t) => t.trim()).filter(Boolean)
      : [];

    return {
      projectName: path.basename(targetDir),
      targetDir,
      architecture,
      forbiddenJargon,
    };
  } finally {
    rl.close();
  }
}

export function copyDirSync(src: string, dest: string, replacements: Record<string, string> = {}) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, replacements);
    } else {
      let content = fs.readFileSync(srcPath, 'utf-8');
      for (const [key, val] of Object.entries(replacements)) {
        content = content.split(key).join(val);
      }
      fs.writeFileSync(destPath, content, 'utf-8');
    }
  }
}

export function scaffoldProject(options: ScaffoldOptions): void {
  const { projectName, targetDir, architecture, forbiddenJargon = [] } = options;
  fs.mkdirSync(targetDir, { recursive: true });

  const templateName = architecture === 'single-package' ? 'single-package' : 'modular-monorepo';

  // Locate template path relative to package root or bundled dist
  const candidateDirs = [
    path.resolve(__dirname, `templates/${templateName}`),
    path.resolve(__dirname, `../templates/${templateName}`),
    path.resolve(__dirname, `../../templates/${templateName}`),
    path.resolve(__dirname, `../../../templates/${templateName}`),
  ];
  const templateDir = candidateDirs.find((dir) => fs.existsSync(dir));

  if (!templateDir) {
    throw new Error(`Template directory for architecture '${architecture}' could not be located.`);
  }

  copyDirSync(templateDir, targetDir, {
    '{{PROJECT_NAME}}': projectName,
    '{{ARCHITECTURE}}': architecture,
  });

  const isMonorepo = architecture === 'modular-monorepo';

  // Write tailored .factoryrc.json
  const factoryConfig = {
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
      boundaries: isMonorepo
        ? [
            {
              package: 'packages/types',
              disallowImportsFrom: ['packages/testing'],
            },
          ]
        : [],
      plainLanguage: {
        enabled: true,
        targetDirs: isMonorepo ? ['packages', 'src'] : ['src'],
        forbiddenTerms: forbiddenJargon.length > 0 ? forbiddenJargon : ['internal_id', 'mutex_lock', 'deadlock'],
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

  fs.writeFileSync(path.join(targetDir, '.factoryrc.json'), JSON.stringify(factoryConfig, null, 2) + '\n', 'utf-8');
}
